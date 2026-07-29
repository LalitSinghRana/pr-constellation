import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import {
  createBenchmarkRun,
  publishStableReview,
} from "./review-run.js";
import { assertStorageId, RunStore } from "./run-store.js";
import { parseGitHubPrUrl } from "../workflows/pr-graph-analysis/02-fetch-pr/github.js";

const execFileAsync = promisify(execFile);
const ACTIVE_STATUSES = new Set(["queued", "running"]);
const STAGE_FINISH_EVENT_TYPES = new Set([
  "end",
  "finish",
  "complete",
  "stage-end",
  "stage-finish",
  "fail",
  "error",
]);
const DEFAULT_CODEX_MODEL = "gpt-5.5";
const DEFAULT_CLAUDE_MODEL = "claude-opus-4-6[1m]";
export const DEFAULT_REASONING_EFFORTS = Object.freeze([
  "low",
  "medium",
  "high",
  "xhigh",
]);
export const DEFAULT_CLAUDE_REASONING_EFFORTS = Object.freeze([
  "low",
  "medium",
  "high",
  "max",
]);
const REASONING_EFFORT_ORDER = Object.freeze([
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

export async function createDashboardService(options) {
  const service = new DashboardService(options);
  await service.initialize();
  return service;
}

export class DashboardService {
  #activeJob = null;
  #closed = false;
  #configuration;
  #drainPromise = null;
  #getCodeVersion;
  #initialized = false;
  #jobs = [];
  #now;
  #projectRoot;
  #publishReview;
  #runExecutor;
  #store;

  constructor({
    getCodeVersion = readCodeVersion,
    configuration = null,
    now = () => new Date(),
    projectRoot = process.cwd(),
    publishReview = publishStableReview,
    reviewsDir,
    runExecutor = createBenchmarkRun,
    store = new RunStore({ reviewsDir }),
  }) {
    if (!reviewsDir) {
      throw new TypeError("reviewsDir is required.");
    }

    this.reviewsDir = path.resolve(reviewsDir);
    this.#configuration = configuration
      ? normalizeDashboardConfiguration(configuration)
      : null;
    this.#getCodeVersion = getCodeVersion;
    this.#now = now;
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
    await this.#store.markStaleRunsInterrupted();
    this.#initialized = true;
  }

  async enqueueBatch({
    prUrl,
    model,
    refresh = false,
    sourceRunId = null,
    sourceSlug = null,
  }) {
    await this.initialize();
    this.#assertOpen();

    const parsed = parseGitHubPrUrl(prUrl);
    const selectedModel = this.#resolveModel(model);
    const selectedProvider = this.#resolveProvider(selectedModel);
    const reasoningEfforts =
      this.#configuration.modelReasoningEfforts[selectedModel]
      || this.#configuration.reasoningEfforts;
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
      const effectiveSourceRunId = frozenSource?.run.runId
        || (usesFrozenSource ? firstRunId : null);
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
  }) {
    await this.initialize();
    this.#assertOpen();

    const parsed = parseGitHubPrUrl(prUrl);
    const selectedModel = this.#resolveModel(model);
    const selectedProvider = this.#resolveProvider(selectedModel);
    const selectedReasoningEffort = this.#resolveReasoningEffort(
      selectedModel,
      reasoningEffort,
    );
    const frozenSource = await this.#resolveRequestedSource({
      parsed,
      refresh,
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
    });

    this.#startDrain();
    return manifest;
  }

  async enqueueFrozenRerun({ runId, slug, model }) {
    await this.initialize();
    this.#assertOpen();
    const source = await this.#store.resolveFrozenSource({
      slug,
      sourceRunId: runId,
    });
    const sourceModel = model || (
      this.#configuration?.models.includes(source.run.metrics?.model)
        ? source.run.metrics.model
        : undefined
    );
    return this.enqueue({
      model: sourceModel,
      prUrl: source.run.url,
      sourceRunId: source.run.runId,
      sourceSlug: slug,
    });
  }

  async enqueueFrozenBatchRerun({ batchId, model }) {
    await this.initialize();
    this.#assertOpen();
    assertStorageId(batchId, "batchId");

    const candidates = (await this.#store.scanRuns())
      .filter((run) => run.metrics?.batchId === batchId)
      .sort(compareFrozenSourceCandidates);
    if (candidates.length === 0) {
      throw createHistoryTargetNotFound(
        `Analysis batch "${batchId}" was not found.`,
      );
    }

    for (const candidate of candidates) {
      try {
        await this.#store.resolveFrozenSource({
          slug: candidate.slug,
          sourceRunId: candidate.runId,
        });
        return this.enqueueFrozenRerun({
          model,
          runId: candidate.runId,
          slug: candidate.slug,
        });
      } catch (error) {
        if (!isUnavailableFrozenSourceError(error)) {
          throw error;
        }
      }
    }

    throw createHistoryTargetNotFound(
      `Analysis batch "${batchId}" has no saved PR input to rerun.`,
    );
  }

  async snapshot() {
    await this.initialize();
    const dashboard = await this.#store.scanDashboard();
    const pullRequests = dashboard.pullRequests.map((pr) => ({
      ...pr,
      runs: pr.runs.map((run) => ({
        ...run,
        ...run.timestamps,
        currentStage: run.phase,
      })),
    }));

    return {
      ...dashboard,
      configuration: structuredClone(this.#configuration),
      prs: pullRequests,
      pullRequests,
      queue: {
        activeRunId: this.#activeJob?.runId || null,
        queuedRunIds: this.#jobs.map((job) => job.runId),
      },
    };
  }

  async waitForIdle() {
    while (this.#drainPromise) {
      await this.#drainPromise;
    }
  }

  async cancelBatch({ batchId }) {
    await this.initialize();
    assertStorageId(batchId, "batchId");

    const activeJob = this.#activeJob?.batchId === batchId
      ? this.#activeJob
      : null;
    const queuedJobs = this.#jobs.filter((job) => job.batchId === batchId);
    this.#jobs = this.#jobs.filter((job) => job.batchId !== batchId);

    const storedActiveRuns = (await this.#store.scanRuns())
      .filter((run) => (
        run.metrics?.batchId === batchId
        && ACTIVE_STATUSES.has(run.status)
      ));
    const targets = uniqueJobs([
      ...queuedJobs,
      ...(activeJob ? [activeJob] : []),
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
    activeJob?.abortController?.abort(createAbortError(message));
    const canceledTargets = (
      await Promise.all(
        targets.map(async (job) => ({
          job,
          run: await this.#markRunCanceled(job, { message }),
        })),
      )
    ).filter(({ run }) => Boolean(run));
    const canceledRuns = canceledTargets.map(({ run }) => run);
    await Promise.all(
      canceledTargets.map(({ job }) => this.#cancelOpenStages(job, { message })),
    );

    if (canceledRuns.length === 0) {
      throw createCancellationTargetNotFound(
        `Batch "${batchId}" has no queued or running analysis runs.`,
      );
    }

    return {
      batchId,
      canceled: true,
      activeRunId: activeJob?.runId || null,
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
        throw createCancellationTargetNotFound(
          `Run "${slug}/${runId}" was not found.`,
        );
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

    const activeJob =
      this.#activeJob?.slug === slug && this.#activeJob?.runId === runId
        ? this.#activeJob
        : null;
    const queuedJob = this.#jobs.find(
      (job) => job.slug === slug && job.runId === runId,
    );
    if (!ACTIVE_STATUSES.has(manifest.status) || (!activeJob && !queuedJob)) {
      throw createCancellationTargetNotFound(
        `Run "${slug}/${runId}" is not queued or running.`,
      );
    }

    this.#jobs = this.#jobs.filter(
      (job) => job.slug !== slug || job.runId !== runId,
    );
    const message = `Analysis run "${slug}/${runId}" was canceled by the user.`;
    activeJob?.abortController?.abort(createAbortError(message));
    const canceledRun = await this.#markRunCanceled(
      activeJob || queuedJob,
      { message },
    );
    if (!canceledRun) {
      throw createCancellationTargetNotFound(
        `Run "${slug}/${runId}" is not queued or running.`,
      );
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
        throw createHistoryTargetNotFound(
          `Run "${slug}/${runId}" was not found.`,
        );
      }
      throw error;
    }
    this.#assertHistoryRunCanBeDeleted(manifest);
    await this.#store.deleteRun(slug, runId);
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

    const manifests = (await this.#store.scanRuns())
      .filter((run) => run.metrics?.batchId === batchId);
    if (manifests.length === 0) {
      throw createHistoryTargetNotFound(
        `Analysis batch "${batchId}" was not found.`,
      );
    }
    for (const manifest of manifests) {
      this.#assertHistoryRunCanBeDeleted(manifest);
    }

    await Promise.all(
      manifests.map((manifest) => (
        this.#store.deleteRun(manifest.slug, manifest.runId)
      )),
    );
    return {
      batchId,
      deleted: true,
      deletedRunCount: manifests.length,
      deletedRunIds: manifests.map((run) => run.runId),
      slug: manifests[0].slug,
    };
  }

  close() {
    this.#closed = true;
    this.#activeJob?.abortController?.abort(
      createAbortError("The dashboard service was closed."),
    );
  }

  #assertHistoryRunCanBeDeleted(manifest) {
    const queued = this.#jobs.some((job) => (
      job.slug === manifest.slug && job.runId === manifest.runId
    ));
    const active = (
      this.#activeJob?.slug === manifest.slug
      && this.#activeJob?.runId === manifest.runId
    );
    const usedByActiveOrQueuedRun = [
      ...(this.#activeJob ? [this.#activeJob] : []),
      ...this.#jobs,
    ].some((job) => (
      job.slug === manifest.slug && job.sourceRunId === manifest.runId
    ));
    if (
      ACTIVE_STATUSES.has(manifest.status)
      || active
      || queued
      || usedByActiveOrQueuedRun
    ) {
      throw createHistoryTargetActive(
        `Run "${manifest.slug}/${manifest.runId}" is queued, running, or supplying frozen input to queued work. Cancel or finish that work before deleting its history.`,
      );
    }
  }

  #startDrain() {
    if (this.#drainPromise) {
      return;
    }

    this.#drainPromise = this.#drainQueue()
      .catch((error) => {
        console.error("Dashboard analysis queue failed:", error);
      })
      .finally(() => {
        this.#drainPromise = null;
        if (this.#jobs.length > 0 && !this.#closed) {
          this.#startDrain();
        }
      });
  }

  async #drainQueue() {
    while (this.#jobs.length > 0 && !this.#closed) {
      const job = this.#jobs.shift();
      job.abortController = new AbortController();
      job.pendingEventWrites = new Set();
      this.#activeJob = job;
      try {
        await this.#executeJob(job);
      } finally {
        this.#activeJob = null;
      }
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
      const canceledFinish = signal.aborted && isStageFinishEvent(event);
      if (signal.aborted && !canceledFinish) {
        return;
      }
      const cancellationEvent = canceledFinish
        ? {
          ...event,
          error: cancellationEventError(event.error),
          status: "canceled",
        }
        : event;
      const normalizedEvent =
        cancellationEvent.stageId !== "run.total"
        && !cancellationEvent.parentStageId
          ? { ...cancellationEvent, parentStageId: "run.total" }
          : cancellationEvent;

      await this.#store.recordStageEvent(
        job.slug,
        job.runId,
        normalizedEvent,
      );

      if (normalizedEvent.type === "stage-start" && !signal.aborted) {
        await this.#store.updateRun(job.slug, job.runId, {
          phase: normalizedEvent.label || normalizedEvent.stageId,
        });
      } else if (normalizedEvent.type === "stage-finish") {
        await this.#updateLiveMetrics(job, normalizedEvent);
      }
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
        this.#store.recordStageEvent(job.slug, job.runId, {
          at: startedAt.toISOString(),
          label: "Total analysis run",
          stageId: "run.total",
          type: "stage-start",
        }),
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
          ...(frozenSource.run.baseSha
            ? { baseSha: frozenSource.run.baseSha }
            : {}),
          ...(frozenSource.run.headSha
            ? { headSha: frozenSource.run.headSha }
            : {}),
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
        this.#store.recordStageEvent(job.slug, job.runId, {
          at: completedAt.toISOString(),
          metrics: { elapsedMs },
          stageId: "run.total",
          status: "completed",
          type: "stage-finish",
        }),
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
          graphUrl: `/reviews/${job.slug}/${job.runId}/`,
          headSha: resolveHeadSha(result.metadata),
          metrics: {
            additions: result.metadata?.additions ?? 0,
            changedFiles:
              result.metadata?.changedFiles
              ?? result.diffSummary?.files?.length
              ?? 0,
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
          : createAbortError(
            "Analysis was canceled before success could be committed.",
          );
      }

      const hasPublicationPath = Boolean(
        result.htmlPath || result.stableHtmlPath,
      );
      if (hasPublicationPath) {
        if (
          typeof result.htmlPath !== "string"
          || typeof result.stableHtmlPath !== "string"
        ) {
          throw new Error(
            "A completed review must provide both htmlPath and stableHtmlPath.",
          );
        }
        await this.#publishReview({
          htmlPath: result.htmlPath,
          stableHtmlPath: result.stableHtmlPath,
        });
      }
    } catch (error) {
      const inputFingerprint = await tryReadInputFingerprint(runDir);
      const usage = normalizeTokenUsage(
        error?.usage || completedResult?.usage,
      );
      const completedAt = this.#nowDate();
      const elapsedMs = Math.round((performance.now() - startedNs) * 1000) / 1000;
      const message = error instanceof Error ? error.message : String(error);
      const canceled = !successCommitted && (
        signal.aborted || isAbortError(error)
      );
      const errorDetails = canceled
        ? {
          code: "RUN_CANCELED",
          message: message || "Analysis was canceled.",
          ...(typeof error?.code === "string"
            ? { causeCode: error.code }
            : {}),
        }
        : {
          code: "RUN_FAILED",
          message,
        };

      if (totalStageStarted) {
        await trackPendingWrite(
          this.#store.recordStageEvent(job.slug, job.runId, {
            at: completedAt.toISOString(),
            error: errorDetails,
            metrics: { elapsedMs },
            stageId: "run.total",
            status: canceled ? "canceled" : "failed",
            type: "stage-finish",
          }),
        );
      }
      await this.#store.updateRun(job.slug, job.runId, (current) => {
        const canFinalize = (
          ACTIVE_STATUSES.has(current.status)
          || (canceled && current.status === "canceled")
          || (successCommitted && current.status === "succeeded")
        );
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
    }
  }

  async #markRunCanceled(job, { message }) {
    const completedAt = this.#nowDate();
    let transitioned = false;
    const updated = await this.#store.updateRun(
      job.slug,
      job.runId,
      (current) => {
        if (
          current.status === "canceled"
          && current.error?.code === "RUN_CANCELED"
        ) {
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
      },
    );
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
      .filter((stage) => (
        !stage.endedAt
        || (
          stage.stageId === "run.total"
          && stage.status !== "canceled"
        )
      ))
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

    if (
      event.stageId === "input.fetch.snapshot"
      || event.stageId === "input.fetch.metadata"
    ) {
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
    const runs = (await this.#store.scanRuns())
      .filter((run) => (
        run.slug === slug
        && !ACTIVE_STATUSES.has(run.status)
        && pullRequestIdentityMatches(run, parsed)
      ));

    for (const run of runs) {
      try {
        return await this.#store.resolveFrozenSource({
          slug,
          sourceRunId: run.runId,
        });
      } catch (error) {
        if (
          error?.code !== "SOURCE_INPUT_MISSING"
          && error?.code !== "INVALID_SOURCE_INPUT"
          && error?.code !== "ENOENT"
        ) {
          throw error;
        }
      }
    }
    return null;
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
      title: sourceRun?.title || "",
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
    return manifest;
  }

  async #resolveRequestedSource({
    parsed,
    refresh,
    sourceRunId,
    sourceSlug,
  }) {
    const slug = parsed.slug;
    if (sourceSlug && sourceSlug !== slug) {
      throw new Error(
        `Frozen source ${sourceSlug} does not match requested PR ${slug}.`,
      );
    }

    const frozenSource = sourceRunId
      ? await this.#store.resolveFrozenSource({ slug, sourceRunId })
      : refresh
        ? null
        : await this.#findReusableSource(parsed);
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
    const selected = typeof model === "string" && model.trim()
      ? model.trim()
      : this.#configuration.defaultModel;
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
      this.#configuration.modelReasoningEfforts[model]
      || this.#configuration.reasoningEfforts;
    const selected = typeof reasoningEffort === "string" && reasoningEffort.trim()
      ? reasoningEffort.trim()
      : supported.includes("xhigh")
        ? "xhigh"
        : supported.includes("max")
          ? "max"
          : supported.at(-1);
    if (!supported.includes(selected)) {
      const error = new Error(
        `Unsupported reasoning effort "${selected}" for ${model}.`,
      );
      error.code = "INVALID_REASONING_EFFORT";
      throw error;
    }
    return selected;
  }

  #resolveProvider(model) {
    return this.#configuration.modelProviders[model]
      || inferModelProvider(model);
  }

  #nowDate() {
    const value = this.#now();
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.valueOf())) {
      throw new TypeError("now returned an invalid date.");
    }
    return date;
  }
}

export async function readCodeVersion({ cwd = process.cwd() } = {}) {
  try {
    const [{ stdout: commitOutput }, { stdout: diffOutput }, { stdout: untrackedOutput }] =
      await Promise.all([
        execFileAsync("git", ["rev-parse", "HEAD"], { cwd }),
        execFileAsync("git", ["diff", "--binary", "HEAD"], {
          cwd,
          maxBuffer: 1024 * 1024 * 100,
        }),
        execFileAsync(
          "git",
          ["ls-files", "--others", "--exclude-standard", "-z"],
          { cwd, encoding: "buffer", maxBuffer: 1024 * 1024 * 20 },
        ),
      ]);
    const commit = commitOutput.trim();
    const hash = createHash("sha256");
    hash.update(diffOutput);
    const untrackedFiles = Buffer.from(untrackedOutput)
      .toString("utf8")
      .split("\0")
      .filter(Boolean)
      .sort();

    for (const relativeFile of untrackedFiles) {
      hash.update(relativeFile);
      hash.update(await readFile(path.join(cwd, relativeFile)));
    }

    const dirty = diffOutput.length > 0 || untrackedFiles.length > 0;
    const dirtyHash = hash.digest("hex").slice(0, 12);
    return {
      commit,
      dirty,
      fingerprint: dirty
        ? `${commit.slice(0, 12)}-dirty-${dirtyHash}`
        : commit,
    };
  } catch {
    return {
      commit: null,
      dirty: null,
      fingerprint: "unknown",
    };
  }
}

export function createInputFingerprint({ diff, metadata }) {
  if (typeof diff !== "string") {
    throw new TypeError("PR input diff must be a string.");
  }
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new TypeError("PR input metadata must be an object.");
  }

  const hash = createHash("sha256");
  hash.update("pr-input-snapshot/v1\0");
  hash.update(JSON.stringify(sortJsonValue(metadata)));
  hash.update("\0");
  hash.update(diff);
  return hash.digest("hex");
}

async function resolveFrozenInputFingerprint(frozenSource) {
  const stored = frozenSource.run?.metrics?.inputFingerprint;
  if (typeof stored === "string" && stored.length > 0) {
    return stored;
  }

  const [metadataText, diff] = await Promise.all([
    readFile(frozenSource.metadataPath, "utf8"),
    readFile(frozenSource.diffPath, "utf8"),
  ]);
  return createInputFingerprint({
    diff,
    metadata: JSON.parse(metadataText),
  });
}

async function readInputFingerprint(runDir) {
  const [metadataText, diff] = await Promise.all([
    readFile(path.join(runDir, "metadata.json"), "utf8"),
    readFile(path.join(runDir, "diff.patch"), "utf8"),
  ]);
  return createInputFingerprint({
    diff,
    metadata: JSON.parse(metadataText),
  });
}

async function tryReadInputFingerprint(runDir) {
  try {
    return await readInputFingerprint(runDir);
  } catch {
    return null;
  }
}

function sortJsonValue(value) {
  if (Array.isArray(value)) {
    return value.map(sortJsonValue);
  }
  if (!value || typeof value !== "object") {
    return value;
  }

  const sorted = {};
  for (const key of Object.keys(value).sort()) {
    sorted[key] = sortJsonValue(value[key]);
  }
  return sorted;
}

function assertFrozenSourceIdentity(run, parsed) {
  if (pullRequestIdentityMatches(run, parsed)) {
    return;
  }

  const error = new Error(
    `Frozen source ${run?.slug || "unknown"} does not belong to `
    + `${parsed.owner}/${parsed.repo}#${parsed.number}.`,
  );
  error.code = "INVALID_SOURCE_RUN";
  throw error;
}

function pullRequestIdentityMatches(run, parsed) {
  if (
    normalizeGitHubName(run?.owner) !== normalizeGitHubName(parsed.owner)
    || normalizeGitHubName(run?.repo) !== normalizeGitHubName(parsed.repo)
    || Number(run?.number) !== Number(parsed.number)
  ) {
    return false;
  }

  try {
    const urlIdentity = parseGitHubPrUrl(run.url);
    return (
      normalizeGitHubName(urlIdentity.owner) === normalizeGitHubName(parsed.owner)
      && normalizeGitHubName(urlIdentity.repo) === normalizeGitHubName(parsed.repo)
      && Number(urlIdentity.number) === Number(parsed.number)
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

export async function loadDashboardConfiguration({
  env = process.env,
  homeDir = os.homedir(),
  isClaudeAvailable = detectClaudeCli,
} = {}) {
  const codexHome = typeof env.CODEX_HOME === "string" && env.CODEX_HOME.trim()
    ? path.resolve(env.CODEX_HOME.trim())
    : path.join(homeDir, ".codex");
  const configuredModel =
    normalizeOptionalName(env.PRC_CODEX_MODEL)
    || await readConfiguredCodexModel(path.join(codexHome, "config.toml"))
    || DEFAULT_CODEX_MODEL;
  const configuredEfforts = parseNameList(env.PRC_CODEX_REASONING_EFFORTS);
  const reasoningEfforts = configuredEfforts.length > 0
    ? orderedReasoningEfforts(configuredEfforts)
    : [...DEFAULT_REASONING_EFFORTS];
  const configuredModels = parseNameList(env.PRC_CODEX_MODELS);
  const cachedModels = configuredModels.length > 0
    ? []
    : await readVisibleCodexModels(path.join(codexHome, "models_cache.json"));
  const codexModels = uniqueNames([
    configuredModel,
    ...(configuredModels.length > 0
      ? configuredModels
      : cachedModels.map((model) => model.slug)),
  ]);
  const configuredClaudeModels = parseNameList(env.PRC_CLAUDE_MODELS);
  const explicitClaudeModel = normalizeOptionalName(env.PRC_CLAUDE_MODEL);
  const configuredClaudeModel = explicitClaudeModel || DEFAULT_CLAUDE_MODEL;
  const claudeAvailable = Boolean(explicitClaudeModel)
    || configuredClaudeModels.length > 0
    || await isClaudeAvailable();
  const claudeModels = claudeAvailable
    ? uniqueNames([
        configuredClaudeModel,
        ...configuredClaudeModels,
      ])
    : [];
  const models = uniqueNames([...codexModels, ...claudeModels]);
  const modelProviders = Object.fromEntries([
    ...codexModels.map((model) => [model, "codex"]),
    ...claudeModels.map((model) => [model, "claude"]),
  ]);
  const configuredClaudeEfforts = parseNameList(
    env.PRC_CLAUDE_REASONING_EFFORTS,
  );
  const claudeReasoningEfforts = configuredClaudeEfforts.length > 0
    ? orderedReasoningEfforts(configuredClaudeEfforts)
    : [...DEFAULT_CLAUDE_REASONING_EFFORTS];
  const cachedModelsBySlug = new Map(
    cachedModels.map((model) => [model.slug, model]),
  );
  const modelReasoningEfforts = Object.fromEntries(
    models.map((model) => {
      if (modelProviders[model] === "claude") {
        return [model, [...claudeReasoningEfforts]];
      }
      const cached = cachedModelsBySlug.get(model);
      const supported = orderedReasoningEfforts(
        (cached?.supportedReasoningEfforts || []).filter((effort) =>
          reasoningEfforts.includes(effort),
        ),
      );
      return [
        model,
        supported.length > 0 ? supported : [...reasoningEfforts],
      ];
    }),
  );

  return normalizeDashboardConfiguration({
    defaultModel: configuredModel,
    modelProviders,
    modelReasoningEfforts,
    models,
    reasoningEfforts,
  });
}

function normalizeDashboardConfiguration(configuration) {
  if (!configuration || typeof configuration !== "object") {
    throw new TypeError("Dashboard configuration must be an object.");
  }

  const defaultModel =
    normalizeOptionalName(configuration.defaultModel)
    || DEFAULT_CODEX_MODEL;
  const models = uniqueNames([
    defaultModel,
    ...(Array.isArray(configuration.models) ? configuration.models : []),
  ]);
  const reasoningEfforts = orderedReasoningEfforts(
    Array.isArray(configuration.reasoningEfforts)
      ? configuration.reasoningEfforts
      : DEFAULT_REASONING_EFFORTS,
  );
  if (reasoningEfforts.length === 0) {
    throw new TypeError(
      "Dashboard configuration must include at least one reasoning effort.",
    );
  }

  const configuredByModel =
    configuration.modelReasoningEfforts
    && typeof configuration.modelReasoningEfforts === "object"
      ? configuration.modelReasoningEfforts
      : {};
  const configuredProviders =
    configuration.modelProviders
    && typeof configuration.modelProviders === "object"
      ? configuration.modelProviders
      : {};
  const modelProviders = Object.fromEntries(
    models.map((model) => [
      model,
      normalizeModelProvider(configuredProviders[model])
        || inferModelProvider(model),
    ]),
  );
  const modelReasoningEfforts = Object.fromEntries(
    models.map((model) => {
      const configured = Array.isArray(configuredByModel[model])
        ? configuredByModel[model]
        : modelProviders[model] === "claude"
          ? DEFAULT_CLAUDE_REASONING_EFFORTS
          : reasoningEfforts;
      const supported = orderedReasoningEfforts(configured);
      const fallback = modelProviders[model] === "claude"
        ? DEFAULT_CLAUDE_REASONING_EFFORTS
        : reasoningEfforts;
      return [model, supported.length > 0 ? supported : [...fallback]];
    }),
  );

  return {
    defaultModel,
    models,
    modelProviders,
    reasoningEfforts,
    modelReasoningEfforts,
  };
}

async function detectClaudeCli() {
  try {
    await execFileAsync("claude", ["--version"], {
      timeout: 3_000,
      windowsHide: true,
    });
    const { stdout } = await execFileAsync(
      "claude",
      ["auth", "status", "--json"],
      {
        timeout: 3_000,
        windowsHide: true,
      },
    );
    return JSON.parse(stdout)?.loggedIn === true;
  } catch {
    return false;
  }
}

async function readConfiguredCodexModel(configPath) {
  try {
    const contents = await readFile(configPath, "utf8");
    const match = contents.match(
      /^\s*model\s*=\s*(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s#\r\n]+))/m,
    );
    return normalizeOptionalName(match?.[1] || match?.[2] || match?.[3]);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    return null;
  }
}

async function readVisibleCodexModels(cachePath) {
  try {
    const document = JSON.parse(await readFile(cachePath, "utf8"));
    const models = Array.isArray(document?.models) ? document.models : [];
    return models
      .filter((model) => (
        model?.visibility === "list"
        && typeof model.slug === "string"
        && model.slug.trim().length > 0
      ))
      .map((model) => ({
        slug: model.slug.trim(),
        supportedReasoningEfforts: Array.isArray(model.supported_reasoning_levels)
          ? model.supported_reasoning_levels
            .map((level) => normalizeOptionalName(level?.effort))
            .filter(Boolean)
          : [],
      }));
  } catch {
    return [];
  }
}

function orderedReasoningEfforts(values) {
  const names = new Set(uniqueNames(values));
  return [
    ...REASONING_EFFORT_ORDER.filter((effort) => names.delete(effort)),
    ...names,
  ];
}

function parseNameList(value) {
  return typeof value === "string"
    ? uniqueNames(value.split(","))
    : [];
}

function uniqueNames(values) {
  return [...new Set(
    values
      .map(normalizeOptionalName)
      .filter(Boolean),
  )];
}

function normalizeOptionalName(value) {
  return typeof value === "string" && value.trim()
    ? value.trim()
    : null;
}

function normalizeModelProvider(value) {
  const provider = normalizeOptionalName(value)?.toLowerCase();
  return provider === "codex" || provider === "claude" ? provider : null;
}

function inferModelProvider(model) {
  return /^claude(?:-|$)/i.test(model) ? "claude" : "codex";
}

function normalizeTokenUsage(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const aliases = {
    inputTokens: ["inputTokens", "input_tokens"],
    cachedInputTokens: [
      "cachedInputTokens",
      "cached_input_tokens",
      "cachedTokens",
    ],
    outputTokens: ["outputTokens", "output_tokens"],
    totalTokens: ["totalTokens", "total_tokens"],
  };
  const usage = {};
  for (const [target, candidates] of Object.entries(aliases)) {
    const metric = candidates
      .map((candidate) => value[candidate])
      .find((candidate) => (
        typeof candidate === "number"
        && Number.isFinite(candidate)
        && candidate >= 0
      ));
    if (metric !== undefined) {
      usage[target] = metric;
    }
  }
  return Object.keys(usage).length > 0 ? usage : null;
}

function uniqueJobs(jobs) {
  const seen = new Set();
  return jobs.filter((job) => {
    const key = `${job.slug}\0${job.runId}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function compareFrozenSourceCandidates(left, right) {
  const statusRank = (run) => run.status === "succeeded" ? 0 : 1;
  const statusDifference = statusRank(left) - statusRank(right);
  if (statusDifference !== 0) {
    return statusDifference;
  }
  const leftIndex = Number(left.metrics?.batchIndex);
  const rightIndex = Number(right.metrics?.batchIndex);
  return (
    (Number.isFinite(leftIndex) ? leftIndex : Number.MAX_SAFE_INTEGER)
    - (Number.isFinite(rightIndex) ? rightIndex : Number.MAX_SAFE_INTEGER)
  );
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
  throw signal.reason instanceof Error
    ? signal.reason
    : createAbortError("Analysis was canceled.");
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
      code:
        typeof error.code === "string" && error.code
          ? error.code
          : "RUN_CANCELED",
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
