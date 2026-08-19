import { parseGitHubPrUrl } from "../../../analysis-worker/workflow/02-fetch-pr/github.js";
import {
  ANALYSIS_QUEUE_BANDS,
  analysisHistoryBand,
} from "../../../shared/analysis-queue-policy.js";
import { resolveFrozenInputFingerprint } from "./input-snapshot.js";
import { ACTIVE_STATUSES, createRunId } from "./run-ids.js";

export async function findReusableSource(dashboard, parsed) {
  const slug = parsed.slug;
  const runs = (await dashboard.store.scanRuns()).filter(
    (run) =>
      run.slug === slug &&
      !ACTIVE_STATUSES.has(run.status) &&
      pullRequestIdentityMatches(run, parsed),
  );

  for (const run of runs) {
    try {
      return await dashboard.store.resolveFrozenSource({
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

export async function enqueueRun(dashboard, options, resolvedSource = null) {
  const {
    additions = null,
    changedFiles = null,
    deletions = null,
    inboxScore = 0,
    prUrl,
    model,
    prioritize = false,
    provider,
    queueBand = null,
    reasoningEffort,
    refresh = false,
    sourceRunId = null,
    sourceSlug = null,
    title = "",
  } = options;
  const parsed = parseGitHubPrUrl(prUrl);
  const selectedModel = dashboard.resolveModel(model, provider);
  const selectedProvider = dashboard.resolveProvider(selectedModel, provider);
  const selectedReasoningEffort = dashboard.resolveReasoningEffort(
    selectedModel,
    reasoningEffort,
    selectedProvider,
  );
  const frozenSource = await resolveRequestedSource(dashboard, {
    parsed,
    refresh,
    resolvedSource,
    sourceRunId,
    sourceSlug,
  });
  const runId = createRunId(dashboard.now());
  const sourceRun = frozenSource?.run;
  const inputFingerprint = frozenSource ? await resolveFrozenInputFingerprint(frozenSource) : null;
  const resolvedBand =
    typeof queueBand === "string" && queueBand in ANALYSIS_QUEUE_BANDS
      ? queueBand
      : await historyBandForSlug(dashboard, parsed.slug);
  const bumpedAt = prioritize ? dashboard.nowDate().toISOString() : null;
  const manifest = await createQueuedRun(dashboard, {
    additions,
    bumpedAt,
    changedFiles,
    deletions,
    inboxScore: Number.isFinite(inboxScore) ? inboxScore : 0,
    inputFingerprint,
    model: selectedModel,
    parsed,
    prUrl,
    provider: selectedProvider,
    queueBand: resolvedBand,
    reasoningEffort: selectedReasoningEffort,
    runId,
    sourceRun,
    sourceRunId: frozenSource?.run.runId || null,
    title,
  });

  dashboard.startDrain();
  return manifest;
}

export async function historyBandForSlug(dashboard, slug) {
  const runs = (await dashboard.store.scanRuns()).filter((run) => run.slug === slug);
  return analysisHistoryBand(runs);
}

export async function enqueueFrozenSource(dashboard, source, model) {
  const sourceModel =
    model ||
    (dashboard.configuration?.models.includes(source.run.metrics?.model)
      ? source.run.metrics.model
      : undefined);
  return enqueueRun(
    dashboard,
    {
      model: sourceModel,
      prUrl: source.run.url,
      sourceRunId: source.run.runId,
      sourceSlug: source.run.slug,
    },
    source,
  );
}

export async function createQueuedRun(
  dashboard,
  {
    additions = null,
    batchId = null,
    batchIndex = null,
    batchSize = null,
    bumpedAt = null,
    changedFiles = null,
    deletions = null,
    inboxScore = 0,
    inputFingerprint,
    model,
    parsed,
    prUrl,
    provider,
    queueBand = "none",
    reasoningEffort,
    runId,
    sourceRun,
    sourceRunId,
    title,
  },
) {
  const sourceMode = sourceRunId ? "frozen" : "fresh";
  const metrics = {
    ...(inputFingerprint ? { inputFingerprint } : {}),
    ...(Number.isInteger(additions) ? { additions } : {}),
    ...(Number.isInteger(deletions) ? { deletions } : {}),
    ...(Number.isInteger(changedFiles) ? { changedFiles } : {}),
    ...(bumpedAt ? { bumpedAt } : {}),
    inboxScore: Number.isFinite(inboxScore) ? inboxScore : 0,
    model,
    provider,
    queueBand: queueBand in ANALYSIS_QUEUE_BANDS ? queueBand : "none",
    reasoningEffort,
  };
  if (batchId) {
    Object.assign(metrics, {
      batchId,
      batchIndex,
      batchSize,
    });
  }

  const manifest = await dashboard.store.createRun({
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

  dashboard.queueJob({
    additions: Number.isInteger(additions) ? additions : null,
    batchId,
    batchIndex,
    bumpedAt,
    changedFiles: Number.isInteger(changedFiles) ? changedFiles : null,
    deletions: Number.isInteger(deletions) ? deletions : null,
    inboxScore: metrics.inboxScore,
    model,
    prUrl: manifest.url,
    provider,
    queueBand: metrics.queueBand,
    queuedAt: manifest.timestamps?.queuedAt || manifest.timestamps?.createdAt || null,
    reasoningEffort,
    runId,
    slug: parsed.slug,
    sourceRunId,
  });
  dashboard.emitChange({ runId, slug: parsed.slug, type: "queued" });
  return manifest;
}

export async function resolveRequestedSource(
  dashboard,
  { parsed, refresh, resolvedSource, sourceRunId, sourceSlug },
) {
  const slug = parsed.slug;
  if (sourceSlug && sourceSlug !== slug) {
    throw new Error(`Frozen source ${sourceSlug} does not match requested PR ${slug}.`);
  }

  const frozenSource =
    resolvedSource ??
    (sourceRunId
      ? await dashboard.store.resolveFrozenSource({ slug, sourceRunId })
      : refresh
        ? null
        : await findReusableSource(dashboard, parsed));
  if (frozenSource) {
    assertFrozenSourceIdentity(frozenSource.run, parsed);
  }
  return frozenSource;
}

export function assertFrozenSourceIdentity(run, parsed) {
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

export function pullRequestIdentityMatches(run, parsed) {
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
