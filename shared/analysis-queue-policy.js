export const ANALYSIS_QUEUE_BANDS = Object.freeze({
  bumped: 0,
  none: 1,
  "past-fail-cancel": 2,
  "past-success": 3,
});

const TERMINAL_STATUSES = new Set(["succeeded", "failed", "canceled", "interrupted"]);
const ACTIVE_STATUSES = new Set(["queued", "running"]);

export function analysisHistoryBand(runs = []) {
  const terminal = runs.filter((run) => TERMINAL_STATUSES.has(run.status));
  if (terminal.length === 0) return "none";
  if (terminal.some((run) => run.status === "succeeded")) return "past-success";
  return "past-fail-cancel";
}

export function changedLineCount(value) {
  return Number.isInteger(value?.additions) && Number.isInteger(value?.deletions)
    ? value.additions + value.deletions
    : Number.isInteger(value?.changedLines)
      ? value.changedLines
      : Number.MAX_SAFE_INTEGER;
}

function effectiveBandRank(job) {
  if (job.bumpedAt) return ANALYSIS_QUEUE_BANDS.bumped;
  const band = job.queueBand;
  return ANALYSIS_QUEUE_BANDS[band] ?? ANALYSIS_QUEUE_BANDS.none;
}

function queuedAtMs(job) {
  const value = job.queuedAt || job.timestamps?.queuedAt || job.timestamps?.createdAt;
  const time = value ? new Date(value).getTime() : Number.NaN;
  return Number.isFinite(time) ? time : Number.MAX_SAFE_INTEGER;
}

/**
 * Drain / enqueue order:
 * bumped → none → past-fail-cancel → past-success,
 * then higher inbox score, then smaller diff, then older queuedAt.
 */
export function compareAnalysisQueueJobs(left, right) {
  const leftBatchId = left.batchId || left.metrics?.batchId || null;
  const rightBatchId = right.batchId || right.metrics?.batchId || null;
  const leftBatchIndex = Number(left.batchIndex ?? left.metrics?.batchIndex);
  const rightBatchIndex = Number(right.batchIndex ?? right.metrics?.batchIndex);
  if (
    left.slug &&
    left.slug === right.slug &&
    leftBatchId &&
    leftBatchId === rightBatchId &&
    Number.isFinite(leftBatchIndex) &&
    Number.isFinite(rightBatchIndex) &&
    leftBatchIndex !== rightBatchIndex
  ) {
    return leftBatchIndex - rightBatchIndex;
  }

  const bandDiff = effectiveBandRank(left) - effectiveBandRank(right);
  if (bandDiff !== 0) return bandDiff;

  if (left.bumpedAt && right.bumpedAt) {
    const bumpDiff = new Date(right.bumpedAt).getTime() - new Date(left.bumpedAt).getTime();
    if (bumpDiff !== 0) return bumpDiff;
  }

  const scoreDiff = (right.inboxScore ?? 0) - (left.inboxScore ?? 0);
  if (scoreDiff !== 0) return scoreDiff;

  const sizeDiff = changedLineCount(left) - changedLineCount(right);
  if (sizeDiff !== 0) return sizeDiff;

  const filesDiff =
    (left.changedFiles ?? Number.MAX_SAFE_INTEGER) -
    (right.changedFiles ?? Number.MAX_SAFE_INTEGER);
  if (filesDiff !== 0) return filesDiff;

  const timeDiff = queuedAtMs(left) - queuedAtMs(right);
  if (timeDiff !== 0) return timeDiff;

  return String(left.runId || left.url || "").localeCompare(String(right.runId || right.url || ""));
}

export function sortAnalysisQueueJobs(jobs) {
  return [...jobs].sort(compareAnalysisQueueJobs);
}

export function isActiveAnalysisStatus(status) {
  return ACTIVE_STATUSES.has(status);
}
