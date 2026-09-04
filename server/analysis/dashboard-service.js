import path from "node:path";
import { parseGitHubPrUrl } from "../../analysis-worker/workflow/02-fetch-pr/github.js";
import { sortAnalysisQueueJobs } from "../../shared/analysis-queue-policy.js";
import {
  runCompletedMs,
  shouldDeleteTerminalRun,
  shouldExpireAnalysis,
} from "../../shared/analysis-retention.js";
import {
  analysisModelReasoningEffort,
  DEFAULT_ANALYSIS_REASONING_EFFORT,
  DEFAULT_REASONING_EFFORTS,
  inferModelProvider,
  isAnalysisModelId,
  loadDashboardConfiguration,
  normalizeAnalysisProvider,
  normalizeDashboardConfiguration,
} from "./dashboard-service/configuration.js";
import {
  createQueuedRun,
  enqueueFrozenSource,
  enqueueRun,
  resolveRequestedSource,
} from "./dashboard-service/enqueue.js";
import {
  createInputFingerprint,
  readCodeVersion,
  resolveFrozenInputFingerprint,
} from "./dashboard-service/input-snapshot.js";
import {
  cancelOpenStages,
  executeJob,
  markRunCanceled,
} from "./dashboard-service/job-execution.js";
import {
  ACTIVE_STATUSES,
  createAbortError,
  createBatchId,
  createCancellationTargetNotFound,
  createHistoryTargetActive,
  createHistoryTargetNotFound,
  createRunId,
  isUnavailableFrozenSourceError,
} from "./dashboard-service/run-ids.js";
import {
  compareFrozenSourceCandidates,
  orderQueuedRunsForResume,
  queuedJobFromManifest,
  runKey,
  stageAttemptOffsets,
  uniqueJobs,
} from "./dashboard-service/run-resume.js";
import { assertStorageId, RunStore } from "./run-store.js";

const MAX_CONCURRENT_JOBS = 1;

export {
  createInputFingerprint,
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
  #runExecutor;
  #store;

  constructor({
    getCodeVersion = readCodeVersion,
    configuration = null,
    now = () => new Date(),
    onChange = () => {},
    projectRoot = process.cwd(),
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
    this.#runExecutor = runExecutor;
    this.#store = store;
  }

  get store() {
    return this.#store;
  }

  #runtime() {
    return {
      configuration: this.#configuration,
      emitChange: (change) => this.#emitChange(change),
      getCodeVersion: this.#getCodeVersion,
      now: () => this.#now(),
      nowDate: () => this.#nowDate(),
      projectRoot: this.#projectRoot,
      queueJob: (job) => {
        this.#jobs.push(job);
        this.#sortJobs();
      },
      resolveModel: (model, provider) => this.#resolveModel(model, provider),
      resolveProvider: (model, provider) => this.#resolveProvider(model, provider),
      resolveReasoningEffort: (model, reasoningEffort, provider) =>
        this.#resolveReasoningEffort(model, reasoningEffort, provider),
      reviewsDir: this.reviewsDir,
      runExecutor: this.#runExecutor,
      startDrain: () => this.#startDrain(),
      store: this.#store,
    };
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
    this.#sortJobs();
    this.#initialized = true;
    this.#startDrain();
  }

  #sortJobs() {
    this.#jobs = sortAnalysisQueueJobs(this.#jobs);
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
    provider,
    refresh = false,
    sourceRunId = null,
    sourceSlug = null,
    title = "",
  }) {
    await this.initialize();
    this.#assertOpen();

    const parsed = parseGitHubPrUrl(prUrl);
    const selectedModel = this.#resolveModel(model, provider);
    const selectedProvider = this.#resolveProvider(selectedModel, provider);
    const reasoningEfforts =
      this.#configuration.modelReasoningEfforts[selectedModel] ||
      this.#configuration.reasoningEfforts;
    const frozenSource = await resolveRequestedSource(this.#runtime(), {
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
      const manifest = await createQueuedRun(this.#runtime(), {
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
    provider,
    reasoningEffort,
    refresh = false,
    sourceRunId = null,
    sourceSlug = null,
    title = "",
    inboxScore = 0,
    queueBand = null,
    prioritize = false,
    additions = null,
    deletions = null,
    changedFiles = null,
  }) {
    await this.initialize();
    this.#assertOpen();
    return enqueueRun(this.#runtime(), {
      additions,
      changedFiles,
      deletions,
      inboxScore,
      model,
      prioritize,
      provider,
      prUrl,
      queueBand,
      reasoningEffort,
      refresh,
      sourceRunId,
      sourceSlug,
      title,
    });
  }

  async prioritizeRun({ runId, slug }) {
    await this.initialize();
    this.#assertOpen();
    assertStorageId(slug, "slug");
    assertStorageId(runId, "runId");

    const job = this.#jobs.find(
      (candidate) => candidate.slug === slug && candidate.runId === runId,
    );
    if (!job) {
      throw createCancellationTargetNotFound(`Run "${slug}/${runId}" is not queued.`);
    }

    const bumpedAt = this.#nowDate().toISOString();
    job.bumpedAt = bumpedAt;
    const manifest = await this.#store.updateRun(slug, runId, {
      metrics: { bumpedAt, queueBand: job.queueBand || "none" },
    });
    this.#sortJobs();
    this.#emitChange({ runId, slug, type: "prioritized" });
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
    return enqueueFrozenSource(this.#runtime(), source, model);
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
      return enqueueFrozenSource(this.#runtime(), source, model);
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
          run: await markRunCanceled(this.#runtime(), job, { message }),
        })),
      )
    ).filter(({ run }) => Boolean(run));
    const canceledRuns = canceledTargets.map(({ run }) => run);
    await Promise.all(
      canceledTargets.map(({ job }) => cancelOpenStages(this.#runtime(), job, { message })),
    );

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
    const canceledRun = await markRunCanceled(this.#runtime(), activeJob || queuedJob, { message });
    if (!canceledRun) {
      throw createCancellationTargetNotFound(`Run "${slug}/${runId}" is not queued or running.`);
    }
    await cancelOpenStages(this.#runtime(), activeJob || queuedJob, { message });

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

  async deleteSlugHistory({ slug }) {
    await this.initialize();
    assertStorageId(slug, "slug");
    const manifests = (await this.#store.scanRuns()).filter((run) => run.slug === slug);
    for (const manifest of manifests) {
      this.#assertHistoryRunCanBeDeleted(manifest);
    }
    const deletedRunIds = [];
    for (const manifest of manifests) {
      await this.#store.deleteRun(manifest.slug, manifest.runId);
      deletedRunIds.push(manifest.runId);
    }
    await this.#store.removeSlugDir(slug);
    if (deletedRunIds.length) {
      this.#emitChange({ slug, type: "deleted" });
    }
    return {
      deleted: true,
      deletedRunCount: deletedRunIds.length,
      deletedRunIds,
      slug,
    };
  }

  async deleteExpiredAnalysis({ deleteDraft, now = this.#nowDate(), queueItems = [] } = {}) {
    await this.initialize();
    const itemsBySlug = new Map();
    for (const item of queueItems) {
      if (typeof item?.url !== "string" || !item.url) continue;
      try {
        itemsBySlug.set(parseGitHubPrUrl(item.url).slug, item);
      } catch {
        // Inbox rows that are not GitHub pull requests are not analysis slugs.
      }
    }
    const manifests = await this.#store.scanRuns();
    const runsBySlug = new Map();
    for (const manifest of manifests) {
      const runs = runsBySlug.get(manifest.slug) ?? [];
      runs.push(manifest);
      runsBySlug.set(manifest.slug, runs);
    }
    const deletedSlugs = [];
    for (const [slug, runs] of runsBySlug) {
      const item = itemsBySlug.get(slug) ?? null;
      if (
        shouldExpireAnalysis({
          item,
          latestRun: runs[0],
          now,
        })
      ) {
        try {
          await this.deleteSlugHistory({ slug });
          deleteDraft?.(slug);
          deletedSlugs.push(slug);
        } catch (error) {
          if (error?.code === "HISTORY_TARGET_ACTIVE") {
            continue;
          }
          throw error;
        }
        continue;
      }

      const latestSucceededRunId = runs
        .filter((run) => run.status === "succeeded")
        .sort((left, right) => runCompletedMs(right) - runCompletedMs(left))[0]?.runId;
      const remaining = [];
      for (const run of runs) {
        if (!shouldDeleteTerminalRun({ item, latestSucceededRunId, now, run })) {
          remaining.push(run);
          continue;
        }
        try {
          this.#assertHistoryRunCanBeDeleted(run);
          await this.#store.deleteRun(run.slug, run.runId);
        } catch (error) {
          if (error?.code === "HISTORY_TARGET_ACTIVE") {
            remaining.push(run);
            continue;
          }
          throw error;
        }
      }
      if (remaining.length === 0) {
        await this.#store.removeSlugDir(slug);
        deleteDraft?.(slug);
        deletedSlugs.push(slug);
      }
    }
    return { deletedSlugs };
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
      execution = executeJob(this.#runtime(), job)
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

  #assertOpen() {
    if (this.#closed) {
      throw new Error("The dashboard service is closed.");
    }
  }

  #resolveModel(model, provider) {
    const selected =
      typeof model === "string" && model.trim() ? model.trim() : this.#configuration.defaultModel;
    if (this.#configuration.models.includes(selected)) return selected;
    if (normalizeAnalysisProvider(provider) && isAnalysisModelId(selected)) return selected;
    const error = new Error(
      `Unsupported model "${selected}". Select one of: ${this.#configuration.models.join(", ")}.`,
    );
    error.code = "INVALID_MODEL";
    throw error;
  }

  #resolveReasoningEffort(model, reasoningEffort, provider) {
    const supported =
      this.#configuration.modelReasoningEfforts[model] || this.#configuration.reasoningEfforts;
    const preferred =
      analysisModelReasoningEffort(model, provider) ||
      (supported.includes(DEFAULT_ANALYSIS_REASONING_EFFORT)
        ? DEFAULT_ANALYSIS_REASONING_EFFORT
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

  #resolveProvider(model, provider) {
    return (
      normalizeAnalysisProvider(provider) ||
      this.#configuration.modelProviders[model] ||
      inferModelProvider(model)
    );
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
