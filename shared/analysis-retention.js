export const ANALYSIS_RETENTION_AFTER_CLOSE_MS = 7 * 24 * 60 * 60 * 1_000;
export const ANALYSIS_RETENTION_IDLE_MS = 90 * 24 * 60 * 60 * 1_000;
export const ANALYSIS_RETENTION_TERMINAL_RUN_MS = 2 * 24 * 60 * 60 * 1_000;

const terminalRunStatuses = new Set(["succeeded", "failed", "interrupted", "canceled"]);

export function timestampMs(value) {
  if (typeof value !== "string" || !value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function githubActivityMs(item) {
  const times = [timestampMs(item?.updatedAt), timestampMs(item?.notificationUpdatedAt)].filter(
    (value) => value != null,
  );
  return times.length ? Math.max(...times) : null;
}

export function pullRequestTerminalMs(item) {
  const state = typeof item?.state === "string" ? item.state.toUpperCase() : "";
  if (state === "MERGED") {
    return timestampMs(item.mergedAt) ?? timestampMs(item.closedAt) ?? timestampMs(item.updatedAt);
  }
  if (state === "CLOSED") {
    return timestampMs(item.closedAt) ?? timestampMs(item.updatedAt);
  }
  return null;
}

export function latestRunActivityMs(run) {
  return (
    timestampMs(run?.timestamps?.updatedAt) ??
    timestampMs(run?.timestamps?.completedAt) ??
    timestampMs(run?.timestamps?.createdAt)
  );
}

export function runCompletedMs(run) {
  return (
    timestampMs(run?.timestamps?.completedAt) ??
    timestampMs(run?.timestamps?.updatedAt) ??
    timestampMs(run?.timestamps?.createdAt)
  );
}

export function shouldExpireAnalysis({ item, latestRun, now }) {
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
  if (!Number.isFinite(nowMs)) return false;

  const doneAtMs = timestampMs(item?.doneAt);
  if (doneAtMs != null && nowMs - doneAtMs >= ANALYSIS_RETENTION_AFTER_CLOSE_MS) {
    return true;
  }

  const terminalMs = pullRequestTerminalMs(item);
  if (terminalMs != null && nowMs - terminalMs >= ANALYSIS_RETENTION_AFTER_CLOSE_MS) {
    return true;
  }

  const activityMs = githubActivityMs(item) ?? latestRunActivityMs(latestRun);
  return activityMs != null && nowMs - activityMs >= ANALYSIS_RETENTION_IDLE_MS;
}

export function isActiveInboxAnalysisItem(item, now) {
  if (!item || item.done) return false;
  return !shouldExpireAnalysis({ item, now });
}

export function shouldDeleteTerminalRun({ item, latestSucceededRunId, now, run }) {
  if (!terminalRunStatuses.has(run?.status)) return false;
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
  const completedMs = runCompletedMs(run);
  if (!Number.isFinite(nowMs) || completedMs == null) return false;
  if (nowMs - completedMs < ANALYSIS_RETENTION_TERMINAL_RUN_MS) return false;
  if (
    run.status === "succeeded" &&
    run.runId === latestSucceededRunId &&
    isActiveInboxAnalysisItem(item, now)
  ) {
    return false;
  }
  return true;
}
