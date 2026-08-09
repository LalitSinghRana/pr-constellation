import { randomUUID } from "node:crypto";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { parseGitHubPrUrl } from "../../analysis-worker/workflow/02-fetch-pr/github.js";
import {
  analysisModelReasoningEffort,
  DEFAULT_CLAUDE_REASONING_EFFORTS,
  DEFAULT_REASONING_EFFORTS,
  inferModelProvider,
  loadDashboardConfiguration,
  normalizeDashboardConfiguration,
  normalizeTokenUsage,
} from "./dashboard-service/configuration.js";
import {
  createInputFingerprint,
  readCodeVersion,
  readInputFingerprint,
  resolveFrozenInputFingerprint,
  tryReadInputFingerprint,
} from "./dashboard-service/input-snapshot.js";
import {
  compareFrozenSourceCandidates,
  eventForResumedJob,
  orderQueuedRunsForResume,
  queuedJobFromManifest,
  runKey,
  stageAttemptOffsets,
  uniqueJobs,
} from "./dashboard-service/run-resume.js";
import { assertStorageId, RunStore } from "./run-store.js";

const ACTIVE_STATUSES = new Set(["queued", "running"]);
const MAX_CONCURRENT_JOBS = 2;
const STAGE_FINISH_EVENT_TYPES = new Set([
  "end",
  "finish",
  "complete",
  "stage-end",
  "stage-finish",
  "fail",
  "error",
]);

export {
  createInputFingerprint,
  DEFAULT_CLAUDE_REASONING_EFFORTS,
  DEFAULT_REASONING_EFFORTS,
  loadDashboardConfiguration,
  readCodeVersion,
};

export async function createDashboardService(options) {
  const service = new DashboardService(options);
  await service.initialize();
  return service;
}

export class DashboardService {
  #activeJobs = new Set();
  #closePromise = null;
  #closed = false;
  #configuration;
  #executions = new Set();
  #getCodeVersion;
  #initialized = false;
  #jobs = [];
  #now;
  #onChange;
  #projectRoot;
  #publishReview;
  #runExecutor;
  #store;

  constructor({
    getCodeVersion = readCodeVersion,
    configuration = null,
    now = () => new Date(),
    onChange = () => {},
    projectRoot = process.cwd(),
    publishReview = publishDefaultReview,
    reviewsDir,
    runExecutor = runDefaultAnalysis,
    store = new RunStore({ reviewsDir }),
  }) {
    if (!reviewsDir) {
      throw new TypeError("reviewsDir is required.");
    }

    this.reviewsDir = path.resolve(reviewsDir);
    this.#configuration = configuration ? normalizeDashboardConfiguration(configuration) : null;
    this.#getCodeVersion = getCodeVersion;
    this.#now = now;
    this.#onChange = onChange;
    this.#projectRoot = path.resolve(projectRoot);
    this.#publishReview = publishReview;
    this.#runExecutor = runExecutor;
    this.#store = store;
  }

  get store() {
    return this.#store;
  }

  async initialize() {
    if (this.#initialized) {
      return;
    }
    if (!this.#configuration) {
      this.#configuration = await loadDashboardConfiguration();
    }
    const interruptedRuns = await this.#store.markStaleRunsInterrupted();
    const queuedRuns = (await this.#store.scanRuns()).filter((run) => run.status === "queued");
    const resumedAttempts = await this.#resumeInterruptedBatchSources(interruptedRuns, queuedRuns);
    for (const run of orderQueuedRunsForResume(queuedRuns)) {
      try {
        this.#jobs.push(
          queuedJobFromManifest(
            run,
            this.#configuration,
            resumedAttempts.get(runKey(run.slug, run.runId)),
          ),
        );
      } catch (error) {
        if (error?.code !== "UNSUPPORTED_STORED_CONFIGURATION") throw error;
        await this.#store.updateRun(run.slug, run.runId, {
          error: { code: error.code, message: error.message },
          phase: "Failed",
          status: "failed",
          timestamps: { completedAt: this.#nowDate() },
        });
        this.#emitChange({ runId: run.runId, slug: run.slug, type: "failed" });
      }
    }
    this.#initialized = true;
    this.#startDrain();
  }

  async #resumeInterruptedBatchSources(interruptedRuns, queuedRuns) {
    const neededSources = new Set(
      queuedRuns
        .filter((run) => run.metrics?.batchId && run.sourceRunId)
        .map((run) => runKey(run.slug, run.sourceRunId)),
    );
    const resumedAttempts = new Map();

    for (const source of interruptedRuns) {
      const key = runKey(source.slug, source.runId);
      if (!neededSources.has(key)) continue;
      try {
        await this.#store.resolveFrozenSource({
          slug: source.slug,
          sourceRunId: source.runId,
        });
        continue;
      } catch (error) {
        if (!isUnavailableFrozenSourceError(error)) throw error;
      }

      const timings = await this.#store.readTimings(source.slug, source.runId);
      resumedAttempts.set(key, stageAttemptOffsets(timings));
      queuedRuns.push(
        await this.#store.updateRun(source.slug, source.runId, {
          error: null,
          phase: null,
          status: "queued",
          timestamps: {
            completedAt: null,
            startedAt: null,
          },
        }),
      );
    }

    return resumedAttempts;
  }

  async enqueueBatch({
    prUrl,
    model,
    refresh = false,
    sourceRunId = null,
    sourceSlug = null,
    title = "",
  }) {
    await this.initialize();
    this.#assertOpen();

    const parsed = parseGitHubPrUrl(prUrl);
    const selectedModel = this.#resolveModel(model);
    const selectedProvider = this.#resolveProvider(selectedModel);
    const reasoningEfforts =
      this.#configuration.modelReasoningEfforts[selectedModel] ||
      this.#configuration.reasoningEfforts;
    const frozenSource = await this.#resolveRequestedSource({
      parsed,
      refresh,
      sourceRunId,
      sourceSlug,
    });
    const batchId = createBatchId(this.#now());
    const runIds = reasoningEfforts.map(() => createRunId(this.#now()));
    const sourceRun = frozenSource?.run || null;
    const inputFingerprint = frozenSource
      ? await resolveFrozenInputFingerprint(frozenSource)
      : null;
    const firstRunId = runIds[0];
    const runs = [];

    for (const [batchIndex, reasoningEffort] of reasoningEfforts.entries()) {
      const usesFrozenSource = Boolean(frozenSource) || batchIndex > 0;
      const effectiveSourceRunId =
        frozenSource?.run.runId || (usesFrozenSource ? firstRunId : null);
      const manifest = await this.#createQueuedRun({
        batchId,
        batchIndex,
        batchSize: reasoningEfforts.length,
        inputFingerprint,
        model: selectedModel,
        parsed,
        prUrl,
        provider: selectedProvider,
        reasoningEffort,
        runId: runIds[batchIndex],
        sourceRun,
        sourceRunId: effectiveSourceRunId,
        title,
      });
      runs.push(manifest);
    }

    this.#startDrain();
    return {
      batchId,
      model: selectedModel,
      provider: selectedProvider,
      reasoningEfforts: [...reasoningEfforts],
      runs,
    };
  }

  async enqueue({
    prUrl,
    model,
    reasoningEffort,
    refresh = false,
    sourceRunId = null,
    sourceSlug = null,
    title = "",
  }) {
    await this.initialize();
    this.#assertOpen();
    return this.#enqueueRun({
      model,
      prUrl,
      reasoningEffort,
      refresh,
      sourceRunId,
      sourceSlug,
      title,
    });
  }

  async enqueueFrozenRerun({ runId, slug, model }) {
    await this.initialize();
    this.#assertOpen();
    const source = await this.#store.resolveFrozenSource({
      slug,
      sourceRunId: runId,
    });
    return this.#enqueueFrozenSource(source, model);
  }

  async enqueueFrozenBatchRerun({ batchId, model }) {
    await this.initialize();
    this.#assertOpen();
    assertStorageId(batchId, "batchId");

    const candidates = (await this.#store.scanRuns())
      .filter((run) => run.metrics?.batchId === batchId)
      .sort(compareFrozenSourceCandidates);
    if (candidates.length === 0) {
      throw createHistoryTargetNotFound(`Analysis batch "${batchId}" was not found.`);
    }

    for (const candidate of candidates) {
      let source;
      try {
        source = await this.#store.resolveFrozenSource({
          slug: candidate.slug,
          sourceRunId: candidate.runId,
        });
      } catch (error) {
        if (!isUnavailableFrozenSourceError(error)) {
          throw error;
        }
        continue;
      }
      return this.#enqueueFrozenSource(source, model);
    }

    throw createHistoryTargetNotFound(
      `Analysis batch "${batchId}" has no saved PR input to rerun.`,
    );
  }

  async snapshot() {
    await this.initialize();
    const dashboard = await this.#store.scanDashboard();
    const pullRequests = dashboard.pullRequests.map((pr) => {
      let includedTerminalTimings = false;
      return {
        ...pr,
        runCount: pr.runs.length,
        runs: pr.runs.map((run) => {
          const terminal = !ACTIVE_STATUSES.has(run.status);
          const includeTimings = run.status === "running" || (terminal && !includedTerminalTimings);
          if (terminal) includedTerminalTimings = true;
          const { events: _events, ...timings } = run.timings ?? {};
          return {
            ...run,
            ...run.timestamps,
            currentStage: run.phase,
            timings: includeTimings ? timings : null,
          };
        }),
      };
    });
    const { pullRequests: _storedPullRequests, ...dashboardMetadata } = dashboard;

    const activeRunIds = [...this.#activeJobs].map((job) => job.runId);
    return {
      ...dashboardMetadata,
      configuration: structuredClone(this.#configuration),
      prs: pullRequests,
      queue: {
        activeRunId: activeRunIds[0] || null,
        activeRunIds,
        queuedRunIds: this.#jobs.map((job) => job.runId),
      },
    };
  }

  async waitForIdle() {
    while (this.#executions.size > 0) {
      await Promise.all(this.#executions);
    }
  }

  async cancelBatch({ batchId }) {
    await this.initialize();
    assertStorageId(batchId, "batchId");

    const activeJobs = [...this.#activeJobs].filter((job) => job.batchId === batchId);
    const queuedJobs = this.#jobs.filter((job) => job.batchId === batchId);
    this.#jobs = this.#jobs.filter((job) => job.batchId !== batchId);

    const storedActiveRuns = (await this.#store.scanRuns()).filter(
      (run) => run.metrics?.batchId === batchId && ACTIVE_STATUSES.has(run.status),
    );
    const targets = uniqueJobs([
      ...queuedJobs,
      ...activeJobs,
      ...storedActiveRuns.map((run) => ({
        batchId,
        runId: run.runId,
        slug: run.slug,
      })),
    ]);

    if (targets.length === 0) {
      throw createCancellationTargetNotFound(
        `Batch "${batchId}" has no queued or running analysis runs.`,
      );
    }

    const message = `Analysis batch "${batchId}" was canceled by the user.`;
    for (const job of activeJobs) {
      job.abortController?.abort(createAbortError(message));
    }
    const canceledTargets = (
      await Promise.all(
        targets.map(async (job) => ({
          job,
          run: await this.#markRunCanceled(job, { message }),
        })),
      )
    ).filter(({ run }) => Boolean(run));
    const canceledRuns = canceledTargets.map(({ run }) => run);
    await Promise.all(canceledTargets.map(({ job }) => this.#cancelOpenStages(job, { message })));

    if (canceledRuns.length === 0) {
      throw createCancellationTargetNotFound(
        `Batch "${batchId}" has no queued or running analysis runs.`,
      );
    }

    const activeRunIds = activeJobs.map((job) => job.runId);
    return {
      batchId,
      canceled: true,
      activeRunId: activeRunIds[0] || null,
      activeRunIds,
      queuedRunIds: queuedJobs.map((job) => job.runId),
      canceledRunIds: canceledRuns.map((run) => run.runId),
      canceledRunCount: canceledRuns.length,
    };
  }

  async cancelRun({ slug, runId }) {
    await this.initialize();
    assertStorageId(slug, "slug");
    assertStorageId(runId, "runId");

    let manifest;
    try {
      manifest = await this.#store.readRun(slug, runId);
    } catch (error) {
      if (error?.code === "ENOENT") {
        throw createCancellationTargetNotFound(`Run "${slug}/${runId}" was not found.`);
      }
      throw error;
    }

    const batchId = manifest.metrics?.batchId;
    if (typeof batchId === "string" && batchId.length > 0) {
      const summary = await this.cancelBatch({ batchId });
      return {
        ...summary,
        delegatedToBatch: true,
        requestedRunId: runId,
        requestedSlug: slug,
      };
    }

    const activeJob = [...this.#activeJobs].find((job) => job.slug === slug && job.runId === runId);
    const queuedJob = this.#jobs.find((job) => job.slug === slug && job.runId === runId);
    if (!ACTIVE_STATUSES.has(manifest.status) || (!activeJob && !queuedJob)) {
      throw createCancellationTargetNotFound(`Run "${slug}/${runId}" is not queued or running.`);
    }

    this.#jobs = this.#jobs.filter((job) => job.slug !== slug || job.runId !== runId);
    const message = `Analysis run "${slug}/${runId}" was canceled by the user.`;
    activeJob?.abortController?.abort(createAbortError(message));
    const canceledRun = await this.#markRunCanceled(activeJob || queuedJob, { message });
    if (!canceledRun) {
      throw createCancellationTargetNotFound(`Run "${slug}/${runId}" is not queued or running.`);
    }
    await this.#cancelOpenStages(activeJob || queuedJob, { message });

    return {
      batchId: null,
      canceled: true,
      activeRunId: activeJob?.runId || null,
      queuedRunIds: queuedJob ? [queuedJob.runId] : [],
      canceledRunIds: [canceledRun.runId],
      canceledRunCount: 1,
      delegatedToBatch: false,
      requestedRunId: runId,
      requestedSlug: slug,
    };
  }

  async deleteRunHistory({ slug, runId }) {
    await this.initialize();
    assertStorageId(slug, "slug");
    assertStorageId(runId, "runId");

    let manifest;
    try {
      manifest = await this.#store.readRun(slug, runId);
    } catch (error) {
      if (error?.code === "ENOENT") {
        throw createHistoryTargetNotFound(`Run "${slug}/${runId}" was not found.`);
      }
      throw error;
    }
    this.#assertHistoryRunCanBeDeleted(manifest);
    await this.#store.deleteRun(slug, runId);
    this.#emitChange({ runId, slug, type: "deleted" });
    return {
      batchId: manifest.metrics?.batchId || null,
      deleted: true,
      deletedRunCount: 1,
      deletedRunIds: [runId],
      slug,
    };
  }

  async deleteBatchHistory({ batchId }) {
    await this.initialize();
    assertStorageId(batchId, "batchId");

    const manifests = (await this.#store.scanRuns()).filter(
      (run) => run.metrics?.batchId === batchId,
    );
    if (manifests.length === 0) {
      throw createHistoryTargetNotFound(`Analysis batch "${batchId}" was not found.`);
    }
    for (const manifest of manifests) {
      this.#assertHistoryRunCanBeDeleted(manifest);
    }

    await Promise.all(
      manifests.map((manifest) => this.#store.deleteRun(manifest.slug, manifest.runId)),
    );
    this.#emitChange({ batchId, type: "deleted" });
    return {
      batchId,
      deleted: true,
      deletedRunCount: manifests.length,
      deletedRunIds: manifests.map((run) => run.runId),
      slug: manifests[0].slug,
    };
  }

  close() {
    if (this.#closePromise) return this.#closePromise;
    this.#closed = true;
    this.#jobs = [];
    for (const job of this.#activeJobs) {
      job.abortController?.abort(createAbortError("The dashboard service was closed."));
    }
    this.#closePromise = this.waitForIdle().finally(() => this.#store.close?.());
    return this.#closePromise;
  }

  #assertHistoryRunCanBeDeleted(manifest) {
    const queued = this.#jobs.some(
      (job) => job.slug === manifest.slug && job.runId === manifest.runId,
    );
    const active = [...this.#activeJobs].some(
      (job) => job.slug === manifest.slug && job.runId === manifest.runId,
    );
    const usedByActiveOrQueuedRun = [...this.#activeJobs, ...this.#jobs].some(
      (job) => job.slug === manifest.slug && job.sourceRunId === manifest.runId,
    );
    if (ACTIVE_STATUSES.has(manifest.status) || active || queued || usedByActiveOrQueuedRun) {
      throw createHistoryTargetActive(
        `Run "${manifest.slug}/${manifest.runId}" is queued, running, or supplying frozen input to queued work. Cancel or finish that work before deleting its history.`,
      );
    }
  }

  #startDrain() {
    while (!this.#closed && this.#activeJobs.size < MAX_CONCURRENT_JOBS) {
      const activeSlugs = new Set([...this.#activeJobs].map((job) => job.slug));
      const jobIndex = this.#jobs.findIndex((job) => !activeSlugs.has(job.slug));
      if (jobIndex < 0) return;

      const [job] = this.#jobs.splice(jobIndex, 1);
      job.abortController = new AbortController();
      job.pendingEventWrites = new Set();
      this.#activeJobs.add(job);
      let execution;
      execution = this.#executeJob(job)
        .catch((error) => {
          console.error("Dashboard analysis job failed:", error);
        })
        .finally(() => {
          this.#activeJobs.delete(job);
          this.#executions.delete(execution);
          this.#startDrain();
        });
      this.#executions.add(execution);
    }
  }

  async #executeJob(job) {
    const runDir = this.#store.getRunDir(job.slug, job.runId);
    const startedNs = performance.now();
    const signal = job.abortController.signal;
    let completedResult = null;
    let successCommitted = false;
    let totalStageStarted = false;

    const trackPendingWrite = (pendingWrite) => {
      job.pendingEventWrites.add(pendingWrite);
      pendingWrite
        .finally(() => {
          job.pendingEventWrites.delete(pendingWrite);
        })
        .catch(() => {});
      return pendingWrite;
    };

    const onEvent = (event) => {
      return trackPendingWrite(recordEvent(event));
    };

    const recordEvent = async (event) => {
      const resumedEvent = eventForResumedJob(job, event);
      const canceledFinish = signal.aborted && isStageFinishEvent(resumedEvent);
      if (signal.aborted && !canceledFinish) {
        return;
      }
      const cancellationEvent = canceledFinish
        ? {
            ...resumedEvent,
            error: cancellationEventError(resumedEvent.error),
            status: "canceled",
          }
        : resumedEvent;
      const normalizedEvent =
        cancellationEvent.stageId !== "run.total" && !cancellationEvent.parentStageId
          ? { ...cancellationEvent, parentStageId: "run.total" }
          : cancellationEvent;

      await this.#store.recordStageEvent(job.slug, job.runId, normalizedEvent);

      if (normalizedEvent.type === "stage-start" && !signal.aborted) {
        await this.#store.updateRun(job.slug, job.runId, {
          phase: normalizedEvent.label || normalizedEvent.stageId,
        });
      } else if (normalizedEvent.type === "stage-finish") {
        await this.#updateLiveMetrics(job, normalizedEvent);
      }
      this.#emitChange({ runId: job.runId, slug: job.slug, type: "progress" });
    };

    try {
      throwIfAborted(signal);
      const codeVersion = await this.#getCodeVersion({ cwd: this.#projectRoot });
      throwIfAborted(signal);
      const startedAt = this.#nowDate();

      await this.#store.updateRun(job.slug, job.runId, {
        error: null,
        gitCommit: codeVersion.commit,
        metrics: {
          codeDirty: codeVersion.dirty,
          codeFingerprint: codeVersion.fingerprint,
        },
        phase: "Starting analysis",
        status: "running",
        timestamps: {
          startedAt,
        },
      });
      throwIfAborted(signal);
      await trackPendingWrite(
        this.#store.recordStageEvent(
          job.slug,
          job.runId,
          eventForResumedJob(job, {
            at: startedAt.toISOString(),
            label: "Total analysis run",
            stageId: "run.total",
            type: "stage-start",
          }),
        ),
      );
      totalStageStarted = true;
      throwIfAborted(signal);

      const frozenSource = job.sourceRunId
        ? await this.#store.resolveFrozenSource({
            slug: job.slug,
            sourceRunId: job.sourceRunId,
          })
        : null;
      const sourceRunDir = frozenSource?.runDir || null;
      if (frozenSource) {
        const sourceFingerprint = await resolveFrozenInputFingerprint(frozenSource);
        await this.#store.updateRun(job.slug, job.runId, {
          ...(frozenSource.run.baseSha ? { baseSha: frozenSource.run.baseSha } : {}),
          ...(frozenSource.run.headSha ? { headSha: frozenSource.run.headSha } : {}),
          metrics: {
            inputFingerprint: sourceFingerprint,
          },
          title: frozenSource.run.title || "",
        });
      }
      throwIfAborted(signal);

      const result = await this.#runExecutor({
        model: job.model,
        onEvent,
        prUrl: job.prUrl,
        provider: job.provider,
        reasoningEffort: job.reasoningEffort,
        reviewsDir: this.reviewsDir,
        runDir,
        signal,
        sourceRunDir,
      });
      completedResult = result;
      throwIfAborted(signal);
      const inputFingerprint = await readInputFingerprint(runDir);
      const usage = normalizeTokenUsage(result.usage);
      const completedAt = this.#nowDate();
      const elapsedMs = Math.round((performance.now() - startedNs) * 1000) / 1000;
      throwIfAborted(signal);

      await trackPendingWrite(
        this.#store.recordStageEvent(
          job.slug,
          job.runId,
          eventForResumedJob(job, {
            at: completedAt.toISOString(),
            metrics: { elapsedMs },
            stageId: "run.total",
            status: "completed",
            type: "stage-finish",
          }),
        ),
      );
      throwIfAborted(signal);
      await this.#store.updateRun(job.slug, job.runId, (current) => {
        if (signal.aborted || !ACTIVE_STATUSES.has(current.status)) {
          return {};
        }
        successCommitted = true;
        return {
          baseSha: resolveBaseSha(result.metadata),
          error: null,
          headSha: resolveHeadSha(result.metadata),
          metrics: {
            additions: result.metadata?.additions ?? 0,
            changedFiles: result.metadata?.changedFiles ?? result.diffSummary?.files?.length ?? 0,
            changedLines: result.diffSummary?.changedLineCount ?? 0,
            deletions: result.metadata?.deletions ?? 0,
            inputFingerprint,
            totalMs: elapsedMs,
            ...(usage ? { tokens: usage, usage } : {}),
          },
          phase: "Complete",
          status: "succeeded",
          timestamps: {
            completedAt,
          },
          title: result.metadata?.title || "",
        };
      });
      if (!successCommitted) {
        throw signal.reason instanceof Error
          ? signal.reason
          : createAbortError("Analysis was canceled before success could be committed.");
      }

      const hasPublicationPath = Boolean(result.htmlPath || result.stableHtmlPath);
      if (hasPublicationPath) {
        if (typeof result.htmlPath !== "string" || typeof result.stableHtmlPath !== "string") {
          throw new Error("A completed review must provide both htmlPath and stableHtmlPath.");
        }
        await this.#publishReview({
          htmlPath: result.htmlPath,
          stableHtmlPath: result.stableHtmlPath,
        });
      }
      this.#emitChange({ runId: job.runId, slug: job.slug, type: "succeeded" });
    } catch (error) {
      const inputFingerprint = await tryReadInputFingerprint(runDir);
      const usage = normalizeTokenUsage(error?.usage || completedResult?.usage);
      const completedAt = this.#nowDate();
      const elapsedMs = Math.round((performance.now() - startedNs) * 1000) / 1000;
      const message = error instanceof Error ? error.message : String(error);
      const canceled = !successCommitted && (signal.aborted || isAbortError(error));
      const errorDetails = canceled
        ? {
            code: "RUN_CANCELED",
            message: message || "Analysis was canceled.",
            ...(typeof error?.code === "string" ? { causeCode: error.code } : {}),
          }
        : {
            code: "RUN_FAILED",
            message,
          };

      if (totalStageStarted) {
        await trackPendingWrite(
          this.#store.recordStageEvent(
            job.slug,
            job.runId,
            eventForResumedJob(job, {
              at: completedAt.toISOString(),
              error: errorDetails,
              metrics: { elapsedMs },
              stageId: "run.total",
              status: canceled ? "canceled" : "failed",
              type: "stage-finish",
            }),
          ),
        );
      }
      await this.#store.updateRun(job.slug, job.runId, (current) => {
        const canFinalize =
          ACTIVE_STATUSES.has(current.status) ||
          (canceled && current.status === "canceled") ||
          (successCommitted && current.status === "succeeded");
        if (!canFinalize) {
          return {};
        }

        return {
          error: errorDetails,
          metrics: {
            ...(inputFingerprint ? { inputFingerprint } : {}),
            totalMs: elapsedMs,
            ...(usage ? { tokens: usage, usage } : {}),
          },
          phase: canceled ? "Canceled" : "Failed",
          status: canceled ? "canceled" : "failed",
          timestamps: {
            completedAt,
          },
        };
      });
      this.#emitChange({
        runId: job.runId,
        slug: job.slug,
        type: canceled ? "canceled" : "failed",
      });
    }
  }

  async #markRunCanceled(job, { message }) {
    const completedAt = this.#nowDate();
    let transitioned = false;
    const updated = await this.#store.updateRun(job.slug, job.runId, (current) => {
      if (current.status === "canceled" && current.error?.code === "RUN_CANCELED") {
        transitioned = true;
        return {};
      }
      if (!ACTIVE_STATUSES.has(current.status)) {
        return {};
      }
      transitioned = true;
      return {
        error: {
          code: "RUN_CANCELED",
          message,
        },
        phase: "Canceled",
        status: "canceled",
        timestamps: {
          completedAt,
        },
      };
    });
    if (transitioned) this.#emitChange({ runId: job.runId, slug: job.slug, type: "canceled" });
    return transitioned ? updated : null;
  }

  async #cancelOpenStages(job, { message }) {
    if (job.pendingEventWrites?.size > 0) {
      await Promise.allSettled([...job.pendingEventWrites]);
    }

    let timings;
    try {
      timings = await this.#store.readTimings(job.slug, job.runId);
    } catch (error) {
      if (error?.code === "ENOENT") {
        return;
      }
      throw error;
    }
    const stagesToCancel = timings.stages
      .filter(
        (stage) => !stage.endedAt || (stage.stageId === "run.total" && stage.status !== "canceled"),
      )
      .reverse();
    if (stagesToCancel.length === 0) {
      return;
    }

    const canceledAt = this.#nowDate().toISOString();
    for (const stage of stagesToCancel) {
      await this.#store.recordStageEvent(job.slug, job.runId, {
        at: canceledAt,
        attempt: stage.attempt,
        error: {
          code: "RUN_CANCELED",
          message,
        },
        label: stage.label,
        parentStageId: stage.parentStageId,
        stageId: stage.stageId,
        status: "canceled",
        type: "stage-finish",
      });
    }
  }

  async #updateLiveMetrics(job, event) {
    const metrics = event.metrics || {};
    const patch = {};

    if (event.stageId === "input.fetch.snapshot" || event.stageId === "input.fetch.metadata") {
      patch.headSha = metrics.headSha || null;
      patch.metrics = {
        additions: metrics.additions ?? 0,
        changedFiles: metrics.changedFiles ?? 0,
        deletions: metrics.deletions ?? 0,
      };
    } else if (event.stageId === "inventory") {
      patch.metrics = {
        changedFiles: metrics.fileCount ?? 0,
        changedLines: metrics.changedLineCount ?? 0,
      };
    }

    if (Object.keys(patch).length > 0) {
      await this.#store.updateRun(job.slug, job.runId, patch);
    }
  }

  async #findReusableSource(parsed) {
    const slug = parsed.slug;
    const runs = (await this.#store.scanRuns()).filter(
      (run) =>
        run.slug === slug &&
        !ACTIVE_STATUSES.has(run.status) &&
        pullRequestIdentityMatches(run, parsed),
    );

    for (const run of runs) {
      try {
        return await this.#store.resolveFrozenSource({
          slug,
          sourceRunId: run.runId,
        });
      } catch (error) {
        if (
          error?.code !== "SOURCE_INPUT_MISSING" &&
          error?.code !== "INVALID_SOURCE_INPUT" &&
          error?.code !== "ENOENT"
        ) {
          throw error;
        }
      }
    }
    return null;
  }

  async #enqueueRun(
    {
      prUrl,
      model,
      reasoningEffort,
      refresh = false,
      sourceRunId = null,
      sourceSlug = null,
      title = "",
    },
    resolvedSource = null,
  ) {
    const parsed = parseGitHubPrUrl(prUrl);
    const selectedModel = this.#resolveModel(model);
    const selectedProvider = this.#resolveProvider(selectedModel);
    const selectedReasoningEffort = this.#resolveReasoningEffort(selectedModel, reasoningEffort);
    const frozenSource = await this.#resolveRequestedSource({
      parsed,
      refresh,
      resolvedSource,
      sourceRunId,
      sourceSlug,
    });
    const runId = createRunId(this.#now());
    const sourceRun = frozenSource?.run;
    const inputFingerprint = frozenSource
      ? await resolveFrozenInputFingerprint(frozenSource)
      : null;
    const manifest = await this.#createQueuedRun({
      inputFingerprint,
      model: selectedModel,
      parsed,
      prUrl,
      provider: selectedProvider,
      reasoningEffort: selectedReasoningEffort,
      runId,
      sourceRun,
      sourceRunId: frozenSource?.run.runId || null,
      title,
    });

    this.#startDrain();
    return manifest;
  }

  async #enqueueFrozenSource(source, model) {
    const sourceModel =
      model ||
      (this.#configuration?.models.includes(source.run.metrics?.model)
        ? source.run.metrics.model
        : undefined);
    return this.#enqueueRun(
      {
        model: sourceModel,
        prUrl: source.run.url,
        sourceRunId: source.run.runId,
        sourceSlug: source.run.slug,
      },
      source,
    );
  }

  async #createQueuedRun({
    batchId = null,
    batchIndex = null,
    batchSize = null,
    inputFingerprint,
    model,
    parsed,
    prUrl,
    provider,
    reasoningEffort,
    runId,
    sourceRun,
    sourceRunId,
    title,
  }) {
    const sourceMode = sourceRunId ? "frozen" : "fresh";
    const metrics = {
      ...(inputFingerprint ? { inputFingerprint } : {}),
      model,
      provider,
      reasoningEffort,
    };
    if (batchId) {
      Object.assign(metrics, {
        batchId,
        batchIndex,
        batchSize,
      });
    }

    const manifest = await this.#store.createRun({
      baseSha: sourceRun?.baseSha || null,
      gitCommit: null,
      headSha: sourceRun?.headSha || null,
      metrics,
      number: Number(parsed.number),
      owner: parsed.owner,
      repo: parsed.repo,
      runId,
      slug: parsed.slug,
      sourceMode,
      sourceRunId,
      status: "queued",
      title: sourceRun?.title || title,
      url: sourceRun?.url || prUrl,
    });

    this.#jobs.push({
      batchId,
      model,
      prUrl: manifest.url,
      provider,
      reasoningEffort,
      runId,
      slug: parsed.slug,
      sourceRunId,
    });
    this.#emitChange({ runId, slug: parsed.slug, type: "queued" });
    return manifest;
  }

  async #resolveRequestedSource({ parsed, refresh, resolvedSource, sourceRunId, sourceSlug }) {
    const slug = parsed.slug;
    if (sourceSlug && sourceSlug !== slug) {
      throw new Error(`Frozen source ${sourceSlug} does not match requested PR ${slug}.`);
    }

    const frozenSource =
      resolvedSource ??
      (sourceRunId
        ? await this.#store.resolveFrozenSource({ slug, sourceRunId })
        : refresh
          ? null
          : await this.#findReusableSource(parsed));
    if (frozenSource) {
      assertFrozenSourceIdentity(frozenSource.run, parsed);
    }
    return frozenSource;
  }

  #assertOpen() {
    if (this.#closed) {
      throw new Error("The dashboard service is closed.");
    }
  }

  #resolveModel(model) {
    const selected =
      typeof model === "string" && model.trim() ? model.trim() : this.#configuration.defaultModel;
    if (!this.#configuration.models.includes(selected)) {
      const error = new Error(
        `Unsupported model "${selected}". Select one of: ${this.#configuration.models.join(", ")}.`,
      );
      error.code = "INVALID_MODEL";
      throw error;
    }
    return selected;
  }

  #resolveReasoningEffort(model, reasoningEffort) {
    const supported =
      this.#configuration.modelReasoningEfforts[model] || this.#configuration.reasoningEfforts;
    const preferred =
      analysisModelReasoningEffort(model) ||
      (supported.includes("xhigh")
        ? "xhigh"
        : supported.includes("max")
          ? "max"
          : supported.at(-1));
    const selected =
      typeof reasoningEffort === "string" && reasoningEffort.trim()
        ? reasoningEffort.trim()
        : preferred;
    if (!supported.includes(selected)) {
      const error = new Error(`Unsupported reasoning effort "${selected}" for ${model}.`);
      error.code = "INVALID_REASONING_EFFORT";
      throw error;
    }
    return selected;
  }

  #resolveProvider(model) {
    return this.#configuration.modelProviders[model] || inferModelProvider(model);
  }

  #nowDate() {
    const value = this.#now();
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.valueOf())) {
      throw new TypeError("now returned an invalid date.");
    }
    return date;
  }

  #emitChange(change) {
    try {
      this.#onChange(change);
    } catch (error) {
      console.error("Dashboard change listener failed:", error);
    }
  }
}

async function runDefaultAnalysis(options) {
  const { createBenchmarkRun } = await import("../../analysis-worker/review-run.js");
  return createBenchmarkRun(options);
}

async function publishDefaultReview(options) {
  const { publishStableReview } = await import("../../analysis-worker/review-run.js");
  return publishStableReview(options);
}

function assertFrozenSourceIdentity(run, parsed) {
  if (pullRequestIdentityMatches(run, parsed)) {
    return;
  }

  const error = new Error(
    `Frozen source ${run?.slug || "unknown"} does not belong to ` +
      `${parsed.owner}/${parsed.repo}#${parsed.number}.`,
  );
  error.code = "INVALID_SOURCE_RUN";
  throw error;
}

function pullRequestIdentityMatches(run, parsed) {
  if (
    normalizeGitHubName(run?.owner) !== normalizeGitHubName(parsed.owner) ||
    normalizeGitHubName(run?.repo) !== normalizeGitHubName(parsed.repo) ||
    Number(run?.number) !== Number(parsed.number)
  ) {
    return false;
  }

  try {
    const urlIdentity = parseGitHubPrUrl(run.url);
    return (
      normalizeGitHubName(urlIdentity.owner) === normalizeGitHubName(parsed.owner) &&
      normalizeGitHubName(urlIdentity.repo) === normalizeGitHubName(parsed.repo) &&
      Number(urlIdentity.number) === Number(parsed.number)
    );
  } catch {
    return false;
  }
}

function normalizeGitHubName(value) {
  return typeof value === "string" ? value.toLowerCase() : "";
}

function createRunId(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.valueOf())) {
    throw new TypeError("now returned an invalid date.");
  }
  return `${date.toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
}

function createBatchId(value) {
  return `batch-${createRunId(value)}`;
}

function resolveHeadSha(metadata) {
  return metadata?.headRefOid || metadata?.commits?.at(-1)?.oid || null;
}

function resolveBaseSha(metadata) {
  return metadata?.baseRefOid || null;
}

function isUnavailableFrozenSourceError(error) {
  return new Set([
    "ENOENT",
    "INVALID_RUN_DOCUMENT",
    "INVALID_SOURCE_INPUT",
    "SOURCE_INPUT_MISSING",
  ]).has(error?.code);
}

function createAbortError(message) {
  const error = new Error(message);
  error.name = "AbortError";
  error.code = "ABORT_ERR";
  return error;
}

function throwIfAborted(signal) {
  if (!signal.aborted) {
    return;
  }
  throw signal.reason instanceof Error ? signal.reason : createAbortError("Analysis was canceled.");
}

function isAbortError(error) {
  return error?.name === "AbortError" || error?.code === "ABORT_ERR";
}

function isStageFinishEvent(event) {
  return STAGE_FINISH_EVENT_TYPES.has(event?.type);
}

function cancellationEventError(error) {
  if (error && typeof error === "object" && !Array.isArray(error)) {
    return {
      code: typeof error.code === "string" && error.code ? error.code : "RUN_CANCELED",
      message:
        typeof error.message === "string" && error.message
          ? error.message
          : "Analysis was canceled.",
    };
  }
  if (typeof error === "string" && error) {
    return {
      code: "RUN_CANCELED",
      message: error,
    };
  }
  return {
    code: "RUN_CANCELED",
    message: "Analysis was canceled.",
  };
}

function createCancellationTargetNotFound(message) {
  const error = new Error(message);
  error.code = "CANCEL_TARGET_NOT_FOUND";
  return error;
}

function createHistoryTargetNotFound(message) {
  const error = new Error(message);
  error.code = "HISTORY_TARGET_NOT_FOUND";
  return error;
}

function createHistoryTargetActive(message) {
  const error = new Error(message);
  error.code = "HISTORY_TARGET_ACTIVE";
  return error;
}
