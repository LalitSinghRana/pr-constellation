import {
  analysisHistoryBand,
  changedLineCount,
  compareAnalysisQueueJobs,
  isActiveAnalysisStatus,
} from "../../../shared/analysis-queue-policy.js";

export function normalizeAnalysisCandidate(value) {
  const url = new URL(value?.url);
  const match = url.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/([1-9]\d*)\/?$/);
  if (url.protocol !== "https:" || url.hostname !== "github.com" || !match) {
    throw new Error("A valid GitHub pull request URL is required.");
  }
  return {
    url: `https://github.com/${match[1]}/${match[2]}/pull/${match[3]}`,
    title: typeof value.title === "string" ? value.title.slice(0, 500) : "",
    additions: Number.isInteger(value.additions) ? value.additions : null,
    deletions: Number.isInteger(value.deletions) ? value.deletions : null,
    changedFiles: Number.isInteger(value.changedFiles) ? value.changedFiles : null,
    headSha: typeof value.headSha === "string" ? value.headSha : "",
    inboxScore: Number.isFinite(value.score) ? value.score : Number(value.inboxScore) || 0,
    prioritize: value.prioritize === true,
  };
}

/** @deprecated Prefer sortAnalysisCandidates — kept for size-only call sites/tests. */
export function sortPullRequestsBySize(values) {
  return [...values].sort(
    (left, right) =>
      changedLineCount(left) - changedLineCount(right) ||
      (left.changedFiles ?? Number.MAX_SAFE_INTEGER) -
        (right.changedFiles ?? Number.MAX_SAFE_INTEGER) ||
      left.url.localeCompare(right.url),
  );
}

export function sortAnalysisCandidates(values, historyByUrl = new Map()) {
  return [...values]
    .map((candidate) => ({
      ...candidate,
      queueBand: analysisHistoryBand(historyByUrl.get(candidate.url) ?? []),
      inboxScore: Number.isFinite(candidate.inboxScore)
        ? candidate.inboxScore
        : Number.isFinite(candidate.score)
          ? candidate.score
          : 0,
    }))
    .sort(compareAnalysisQueueJobs);
}

function alreadyAnalyzed(dashboard, candidate) {
  const pullRequest = (dashboard.prs ?? dashboard.pullRequests ?? []).find(
    (item) => item.url === candidate.url,
  );
  return pullRequest?.runs?.some(
    (run) =>
      isActiveAnalysisStatus(run.status) ||
      (run.status === "succeeded" && (!candidate.headSha || run.headSha === candidate.headSha)),
  );
}

function historyByUrlFromDashboard(dashboard) {
  const map = new Map();
  for (const pullRequest of dashboard.prs ?? dashboard.pullRequests ?? []) {
    map.set(pullRequest.url, pullRequest.runs ?? []);
  }
  return map;
}

const ANALYSIS_QUEUE_LIMIT = 1_000;

export async function enqueueMissingAnalyses(values, dashboardService, options = {}) {
  const candidates = values.slice(0, ANALYSIS_QUEUE_LIMIT).map(normalizeAnalysisCandidate);
  const dashboard = await dashboardService.snapshot();
  const historyByUrl = historyByUrlFromDashboard(dashboard);
  const ordered = sortAnalysisCandidates(candidates, historyByUrl);
  const model =
    typeof options.model === "string" && options.model.trim() ? options.model.trim() : undefined;
  const provider =
    typeof options.provider === "string" && options.provider.trim()
      ? options.provider.trim()
      : undefined;
  const reasoningEffort =
    typeof options.reasoningEffort === "string" && options.reasoningEffort.trim()
      ? options.reasoningEffort.trim()
      : undefined;
  const runs = [];
  for (const candidate of ordered) {
    if (alreadyAnalyzed(dashboard, candidate)) continue;
    runs.push(
      await dashboardService.enqueue({
        inboxScore: candidate.inboxScore,
        model,
        provider,
        prioritize: candidate.prioritize,
        prUrl: candidate.url,
        queueBand: candidate.queueBand,
        reasoningEffort,
        refresh: true,
        title: candidate.title,
        additions: candidate.additions,
        deletions: candidate.deletions,
        changedFiles: candidate.changedFiles,
      }),
    );
  }
  return runs;
}

export function inboxItemsForAnalysisQueue(items) {
  return items.filter((item) => item && !item.done && !item.authored && item.url);
}

export async function queueInboxAnalyses(items, dashboardService, options = {}) {
  return enqueueMissingAnalyses(inboxItemsForAnalysisQueue(items), dashboardService, options);
}

export async function automaticallyQueueNewAnalyses(items, dashboardService, options = {}) {
  try {
    return {
      runs: await enqueueMissingAnalyses(
        items.filter((item) => item.lifecycle === "new" && !item.done),
        dashboardService,
        options,
      ),
      warnings: [],
    };
  } catch (error) {
    console.error("Automatic analysis queue failed:", error);
    return {
      runs: [],
      warnings: [
        "New PRs could not be queued for AI analysis; the next background sync will retry.",
      ],
    };
  }
}
