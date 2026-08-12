import {
  ANALYSIS_QUEUE_BANDS,
  compareAnalysisQueueJobs,
} from "../../../shared/analysis-queue-policy.js";
import {
  inferModelProvider,
  normalizeModelProvider,
  normalizeOptionalName,
} from "./configuration.js";

export function uniqueJobs(jobs) {
  const seen = new Set();
  return jobs.filter((job) => {
    const key = runKey(job.slug, job.runId);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function queueFieldsFromRun(run) {
  const metrics = run.metrics ?? {};
  const band =
    typeof metrics.queueBand === "string" && metrics.queueBand in ANALYSIS_QUEUE_BANDS
      ? metrics.queueBand
      : "none";
  return {
    additions: Number.isInteger(metrics.additions) ? metrics.additions : null,
    batchId: normalizeOptionalName(metrics.batchId),
    batchIndex: Number.isInteger(metrics.batchIndex) ? metrics.batchIndex : null,
    bumpedAt: typeof metrics.bumpedAt === "string" ? metrics.bumpedAt : null,
    changedFiles: Number.isInteger(metrics.changedFiles) ? metrics.changedFiles : null,
    deletions: Number.isInteger(metrics.deletions) ? metrics.deletions : null,
    inboxScore: Number.isFinite(metrics.inboxScore) ? metrics.inboxScore : 0,
    queueBand: band,
    queuedAt: run.timestamps?.queuedAt || run.timestamps?.createdAt || null,
  };
}

export function orderQueuedRunsForResume(runs) {
  const byId = new Map(runs.map((run) => [runKey(run.slug, run.runId), run]));
  const ordered = [];
  const added = new Set();

  const addWithSource = (run) => {
    const key = runKey(run.slug, run.runId);
    if (added.has(key)) return;
    added.add(key);
    const source = run.sourceRunId ? byId.get(runKey(run.slug, run.sourceRunId)) : null;
    if (source) addWithSource(source);
    ordered.push(run);
  };

  for (const run of [...runs]
    .map((run) => ({ ...run, ...queueFieldsFromRun(run) }))
    .sort(compareAnalysisQueueJobs)) {
    addWithSource(byId.get(runKey(run.slug, run.runId)));
  }
  return ordered;
}

export function queuedJobFromManifest(run, configuration, attemptOffsets) {
  const storedModel = normalizeOptionalName(run.metrics?.model);
  if (!configuration.models.includes(storedModel)) {
    throw unsupportedConfiguration(
      run,
      `model "${storedModel || "(missing)"}" is no longer configured`,
    );
  }
  const model = storedModel;
  const efforts = configuration.modelReasoningEfforts[model] || configuration.reasoningEfforts;
  const storedEffort = normalizeOptionalName(run.metrics?.reasoningEffort);
  if (!efforts.includes(storedEffort)) {
    throw unsupportedConfiguration(
      run,
      `reasoning effort "${storedEffort || "(missing)"}" is not supported by "${model}"`,
    );
  }
  const configuredProvider = configuration.modelProviders[model] || inferModelProvider(model);
  const storedProviderValue = normalizeOptionalName(run.metrics?.provider);
  const storedProvider = normalizeModelProvider(storedProviderValue);
  if (storedProviderValue && !storedProvider) {
    throw unsupportedConfiguration(run, `provider "${storedProviderValue}" is not supported`);
  }
  if (storedProvider && storedProvider !== configuredProvider) {
    throw unsupportedConfiguration(
      run,
      `provider "${storedProvider}" does not match "${configuredProvider}" for "${model}"`,
    );
  }

  return {
    attemptOffsets,
    model,
    prUrl: run.url,
    provider: configuredProvider,
    reasoningEffort: storedEffort,
    runId: run.runId,
    slug: run.slug,
    sourceRunId: run.sourceRunId,
    ...queueFieldsFromRun(run),
  };
}

function unsupportedConfiguration(run, reason) {
  const error = new Error(`Queued run "${run.slug}/${run.runId}" cannot resume: ${reason}.`);
  error.code = "UNSUPPORTED_STORED_CONFIGURATION";
  return error;
}

export function runKey(slug, runId) {
  return `${slug}\0${runId}`;
}

export function stageAttemptOffsets(timings) {
  const offsets = new Map();
  for (const stage of timings.stages) {
    offsets.set(stage.stageId, Math.max(offsets.get(stage.stageId) || 0, stage.attempt));
  }
  return offsets;
}

export function eventForResumedJob(job, event) {
  const offset = job.attemptOffsets?.get(event.stageId) || 0;
  return offset ? { ...event, attempt: (event.attempt || 1) + offset } : event;
}

export function compareFrozenSourceCandidates(left, right) {
  const statusDifference =
    (left.status === "succeeded" ? 0 : 1) - (right.status === "succeeded" ? 0 : 1);
  if (statusDifference !== 0) return statusDifference;
  const leftIndex = Number(left.metrics?.batchIndex);
  const rightIndex = Number(right.metrics?.batchIndex);
  return (
    (Number.isFinite(leftIndex) ? leftIndex : Number.MAX_SAFE_INTEGER) -
    (Number.isFinite(rightIndex) ? rightIndex : Number.MAX_SAFE_INTEGER)
  );
}
