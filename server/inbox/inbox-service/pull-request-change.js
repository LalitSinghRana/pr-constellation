import { prKey } from "./identity.js";
import { currentQueueRecordVersion } from "./queue-state.js";

function isDoneQueueRecord(record) {
  return Boolean(record?.doneVersion);
}

export function shouldRefreshInboxActivity(
  item,
  { authoredOpenIds = null, inboxIds = null, pinned = false, wasDone = false } = {},
) {
  if (!item || item.kind === "notification") return false;
  const authored =
    authoredOpenIds instanceof Set ? authoredOpenIds : new Set(authoredOpenIds ?? []);
  if (inboxIds instanceof Set && inboxIds.has(item.id)) return true;
  if (authored.has(item.id) || pinned) return true;
  if (wasDone) return false;
  return false;
}

function parseGitHubTime(value) {
  const parsed = Date.parse(value ?? "");
  return Number.isFinite(parsed) ? parsed : 0;
}

export function notificationTimesFromPullRequests(pullRequestNotifications = []) {
  const times = new Map();
  for (const { thread, pr } of pullRequestNotifications) {
    if (!pr) continue;
    const id = prKey(pr);
    const timestamp = parseGitHubTime(thread?.updated_at);
    if (timestamp) times.set(id, Math.max(times.get(id) ?? 0, timestamp));
  }
  return times;
}

export function authoredSnapshotsFromPullRequests(authoredPullRequests = []) {
  const snapshots = new Map();
  for (const pr of authoredPullRequests) {
    if (!pr) continue;
    snapshots.set(prKey(pr), {
      headSha: pr.headSha ?? pr.headRefOid ?? "",
      updatedAt: pr.updatedAt ?? "",
    });
  }
  return snapshots;
}

export function previousGitHubSnapshotFromQueueRecord(record) {
  if (!record) return null;
  const item = record.item ?? {};
  return {
    headSha: typeof item.headSha === "string" ? item.headSha : "",
    notificationUpdatedAt:
      typeof record.notificationUpdatedAt === "string" ? record.notificationUpdatedAt : "",
    updatedAt:
      typeof item.updatedAt === "string"
        ? item.updatedAt
        : typeof record.updatedAt === "string"
          ? record.updatedAt
          : "",
  };
}

export function hasPullRequestChangeToken(
  id,
  {
    authoredOpenIds = null,
    authoredSnapshot = null,
    inboxIds = null,
    notificationAt = 0,
    queueRecord = null,
  } = {},
) {
  if (!currentQueueRecordVersion(queueRecord)) return true;

  const previous = previousGitHubSnapshotFromQueueRecord(queueRecord);
  const authored =
    authoredOpenIds instanceof Set ? authoredOpenIds : new Set(authoredOpenIds ?? []);

  if (inboxIds instanceof Set && inboxIds.has(id) && notificationAt > 0) {
    if (notificationAt > parseGitHubTime(previous.notificationUpdatedAt)) return true;
  }

  if (authored.has(id) && authoredSnapshot) {
    const nextUpdatedAt = parseGitHubTime(authoredSnapshot.updatedAt);
    const previousUpdatedAt = parseGitHubTime(previous.updatedAt);
    if (nextUpdatedAt > previousUpdatedAt) return true;
    const nextHeadSha = authoredSnapshot.headSha ?? "";
    const previousHeadSha = previous.headSha ?? "";
    if (nextHeadSha && nextHeadSha !== previousHeadSha) return true;
  }

  return false;
}

export function pullRequestRefreshIds({
  authoredOpenIds = null,
  authoredPullRequests = [],
  inboxIds = null,
  items,
  pullRequestNotifications = [],
  queueRecords = {},
}) {
  const notificationTimes = notificationTimesFromPullRequests(pullRequestNotifications);
  const authoredSnapshots = authoredSnapshotsFromPullRequests(authoredPullRequests);
  const refreshIds = new Set();

  for (const item of items.values()) {
    if (
      !shouldRefreshInboxActivity(item, {
        authoredOpenIds,
        inboxIds,
        pinned: queueRecords[item.id]?.pinned === true,
        wasDone: isDoneQueueRecord(queueRecords[item.id]),
      })
    ) {
      continue;
    }
    if (
      hasPullRequestChangeToken(item.id, {
        authoredOpenIds,
        authoredSnapshot: authoredSnapshots.get(item.id),
        inboxIds,
        notificationAt: notificationTimes.get(item.id) ?? 0,
        queueRecord: queueRecords[item.id],
      })
    ) {
      refreshIds.add(item.id);
    }
  }

  return refreshIds;
}
