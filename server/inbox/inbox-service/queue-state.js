import {
  ACTIVITY_SIGNAL_KINDS,
  isOpenAuthoredPullRequest,
  SIGNAL_LABELS,
  SIGNAL_WEIGHTS,
} from "../../../shared/queue-policy.js";
import {
  isMyPrNotification,
  prKey,
  repositoryNamePattern,
  usernamePattern,
  validNotificationThreadId,
} from "./identity.js";

const signalLabels = SIGNAL_LABELS;
const weights = SIGNAL_WEIGHTS;
const activitySignalKinds = new Set(ACTIVITY_SIGNAL_KINDS);

export function normalizeQueueState(value = {}) {
  const items = {};
  for (const [id, record] of Object.entries(value.items ?? {}).slice(0, 20_000)) {
    if (typeof id !== "string" || id.length > 200 || !record || typeof record !== "object") {
      continue;
    }
    const item = queueItemFromRecord(id, record);
    items[id] = {
      url: typeof record.url === "string" ? record.url : "",
      updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : "",
      version: typeof record.version === "string" ? record.version : "",
      lastSeenAt: typeof record.lastSeenAt === "string" ? record.lastSeenAt : "",
      notificationUpdatedAt:
        typeof record.notificationUpdatedAt === "string" ? record.notificationUpdatedAt : "",
      ...(item ? { item: queueItemSnapshot(item) } : {}),
      ...(typeof record.doneVersion === "string" ? { doneVersion: record.doneVersion } : {}),
      ...(typeof record.activeVersion === "string" ? { activeVersion: record.activeVersion } : {}),
      ...(typeof record.readVersion === "string" ? { readVersion: record.readVersion } : {}),
      ...(record.readSnapshot && typeof record.readSnapshot === "object"
        ? { readSnapshot: readSnapshot({ item: record.readSnapshot }) }
        : item && record.readVersion === record.version
          ? { readSnapshot: readSnapshot({ item }) }
          : {}),
      ...(record.doneSnapshot && typeof record.doneSnapshot === "object"
        ? { doneSnapshot: readSnapshot({ item: record.doneSnapshot }) }
        : item && record.doneVersion === record.version
          ? { doneSnapshot: readSnapshot({ item }) }
          : {}),
    };
  }
  const sync = value.sync && typeof value.sync === "object" ? value.sync : {};
  return {
    version: 2,
    sync: {
      lastSyncedAt: typeof sync.lastSyncedAt === "string" ? sync.lastSyncedAt : "",
      notificationPollIntervalSeconds:
        Number.isInteger(sync.notificationPollIntervalSeconds) &&
        sync.notificationPollIntervalSeconds > 0
          ? sync.notificationPollIntervalSeconds
          : 60,
      notificationsSyncedAt:
        typeof sync.notificationsSyncedAt === "string" ? sync.notificationsSyncedAt : "",
      username:
        typeof sync.username === "string" && usernamePattern.test(sync.username)
          ? sync.username
          : "",
      repositories: (Array.isArray(sync.repositories) ? sync.repositories : [])
        .filter(
          (repository) => typeof repository === "string" && repositoryNamePattern.test(repository),
        )
        .slice(0, 200),
    },
    items,
  };
}

export function queueVersion(item) {
  if (item.kind === "notification") {
    return `${item.updatedAt}:${item.unread ? "unread" : "read"}`;
  }
  return [item.updatedAt, item.notificationUpdatedAt].filter(Boolean).sort().at(-1) ?? "";
}

export function queueItemFromRecord(id, record) {
  const stored = record.item ?? {};
  const value = typeof stored.url === "string" ? stored.url : record.url;
  try {
    const url = new URL(value);
    const notificationMatch = /^notification:(\d+)$/.exec(id);
    if (notificationMatch) {
      const updatedAt = typeof stored.updatedAt === "string" ? stored.updatedAt : record.updatedAt;
      if (url.protocol !== "https:" || url.hostname !== "github.com" || !updatedAt) return null;
      return {
        id,
        kind: "notification",
        title:
          typeof stored.title === "string" && stored.title ? stored.title : "GitHub notification",
        url: url.href,
        repository:
          typeof stored.repository === "string" && stored.repository
            ? stored.repository.slice(0, 200)
            : "GitHub",
        subjectType:
          typeof stored.subjectType === "string"
            ? stored.subjectType.slice(0, 100)
            : "Notification",
        reason: typeof stored.reason === "string" ? stored.reason.slice(0, 100) : "",
        updatedAt,
        unread: Boolean(stored.unread),
        notificationThreadId: notificationMatch[1],
      };
    }
    const match = url.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/([1-9]\d*)\/?$/);
    if (url.protocol !== "https:" || url.hostname !== "github.com" || !match) return null;
    const repository = `${match[1]}/${match[2]}`;
    const number = Number.parseInt(match[3], 10);
    if (id !== `${repository}#${number}`) return null;
    const updatedAt = typeof stored.updatedAt === "string" ? stored.updatedAt : record.updatedAt;
    if (!updatedAt) return null;
    return {
      id,
      number,
      title:
        typeof stored.title === "string" && stored.title ? stored.title : `Pull request #${number}`,
      url: `https://github.com/${repository}/pull/${number}`,
      repository,
      author: typeof stored.author === "string" ? stored.author : "",
      state: typeof stored.state === "string" ? stored.state.toUpperCase() : "UNKNOWN",
      comments: Number.isInteger(stored.comments) ? stored.comments : 0,
      createdAt: typeof stored.createdAt === "string" ? stored.createdAt : updatedAt,
      updatedAt,
      mergedAt: typeof stored.mergedAt === "string" ? stored.mergedAt : null,
      draft: Boolean(stored.draft),
      labels: (Array.isArray(stored.labels) ? stored.labels : [])
        .filter(
          (label) => label && typeof label.name === "string" && typeof label.color === "string",
        )
        .slice(0, 4)
        .map((label) => ({ name: label.name, color: label.color })),
      signals: (Array.isArray(stored.signals) ? stored.signals : [])
        .filter((signal) => signal && Object.hasOwn(signalLabels, signal.kind))
        .slice(0, 12)
        .map((signal) => ({
          kind: signal.kind,
          label: signalLabels[signal.kind],
          detail: typeof signal.detail === "string" ? signal.detail : "",
          weight: weights[signal.kind],
          href: typeof signal.href === "string" ? signal.href : value,
        })),
      notification: null,
      authored: Boolean(stored.authored),
      reviewed: Boolean(stored.reviewed),
      latestReviewState:
        typeof stored.latestReviewState === "string" ? stored.latestReviewState : null,
      reviewDecision: typeof stored.reviewDecision === "string" ? stored.reviewDecision : null,
      notificationThreadId: validNotificationThreadId(stored.notificationThreadId),
      additions: Number.isInteger(stored.additions) ? stored.additions : null,
      deletions: Number.isInteger(stored.deletions) ? stored.deletions : null,
      changedFiles: Number.isInteger(stored.changedFiles) ? stored.changedFiles : null,
      headSha: typeof stored.headSha === "string" ? stored.headSha : "",
      notificationUpdatedAt:
        typeof record.notificationUpdatedAt === "string" ? record.notificationUpdatedAt : "",
    };
  } catch {
    return null;
  }
}

export function queueItemSnapshot(item) {
  return {
    id: item.id,
    kind: item.kind,
    number: item.number,
    title: item.title,
    url: item.url,
    repository: item.repository,
    author: item.author,
    state: item.state,
    comments: item.comments,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    mergedAt: item.mergedAt,
    draft: item.draft,
    labels: item.labels,
    signals: item.signals,
    authored: item.authored,
    reviewed: item.reviewed,
    latestReviewState: item.latestReviewState,
    reviewDecision: item.reviewDecision,
    notificationThreadId: item.notificationThreadId,
    subjectType: item.subjectType,
    reason: item.reason,
    unread: item.unread,
    additions: item.additions,
    deletions: item.deletions,
    changedFiles: item.changedFiles,
    headSha: item.headSha,
  };
}

export function trackedQueueItems(state) {
  return Object.entries(state.items)
    .map(([id, record]) => queueItemFromRecord(id, record))
    .filter((item) => item && item.kind !== "notification");
}

export function trackedQueueNotifications(state) {
  return Object.entries(state.items)
    .map(([id, record]) => queueItemFromRecord(id, record))
    .filter((item) => item?.kind === "notification");
}

export function rememberQueueItems(state, entries, seenAt) {
  for (const item of entries) {
    state.items[item.id] = {
      ...state.items[item.id],
      url: item.url,
      updatedAt: item.updatedAt,
      version: queueVersion(item),
      lastSeenAt: seenAt,
      notificationUpdatedAt: item.notificationUpdatedAt ?? "",
      item: queueItemSnapshot(item),
    };
  }
  return state;
}

export function applyQueueState(entries, state) {
  return entries.map((item) => {
    const version = queueVersion(item);
    const record = state.items[item.id] ?? {};
    const doneVersion = record.doneVersion;
    const hasDoneUpdates = Boolean(doneVersion && doneVersion !== version);
    const hasReadUpdates = Boolean(record.readVersion && record.readVersion !== version);
    return {
      ...item,
      queueVersion: version,
      done: Boolean(doneVersion && doneVersion === version),
      hasUpdates: hasDoneUpdates,
      read: record.readVersion === version,
      hasUnreadUpdates: hasDoneUpdates || hasReadUpdates,
      updatesSinceRead:
        hasDoneUpdates || hasReadUpdates
          ? describeUpdates(item, hasDoneUpdates ? record.doneSnapshot : record.readSnapshot)
          : [],
      changesSince: hasDoneUpdates ? "marked done" : "last open",
    };
  });
}

export function describeUpdates(item, snapshot) {
  if (item.kind === "notification") return ["Notification activity changed"];
  if (!snapshot) return ["PR activity changed"];
  const updates = [];
  if (snapshot.state !== item.state) {
    updates.push(
      item.state === "MERGED" ? "Merged" : `State changed to ${item.state.toLowerCase()}`,
    );
  }
  if (snapshot.headSha && item.headSha && snapshot.headSha !== item.headSha) {
    updates.push("New commits");
  }
  const newComments = item.comments - snapshot.comments;
  if (newComments > 0) {
    updates.push(`${newComments} new ${newComments === 1 ? "comment" : "comments"}`);
  }
  if (snapshot.draft !== item.draft) {
    updates.push(item.draft ? "Converted to draft" : "Ready for review");
  }
  if (snapshot.title !== item.title) updates.push("Title changed");
  if (updates.length) return updates;
  const signalUpdates = item.signals
    .filter((signal) => activitySignalKinds.has(signal.kind))
    .map((signal) => signal.label);
  return signalUpdates.length ? signalUpdates : ["PR activity changed"];
}

export function readSnapshot(record) {
  const item = record.item ?? {};
  return {
    title: typeof item.title === "string" ? item.title : "",
    state: typeof item.state === "string" ? item.state : "UNKNOWN",
    comments: Number.isInteger(item.comments) ? item.comments : 0,
    headSha: typeof item.headSha === "string" ? item.headSha : "",
    draft: Boolean(item.draft),
  };
}

export function currentQueueRecordVersion(record) {
  return (
    (record?.item
      ? queueVersion({
          ...record.item,
          notificationUpdatedAt: record.notificationUpdatedAt,
        })
      : "") || record?.version
  );
}

export function setQueueItemDone(state, id, done) {
  const record = state.items[id];
  const version = currentQueueRecordVersion(record);
  if (!version) return null;
  record.version = version;
  if (done) {
    record.doneVersion = version;
    record.doneSnapshot = readSnapshot(record);
    delete record.activeVersion;
  } else {
    delete record.doneVersion;
    delete record.doneSnapshot;
    record.activeVersion = record.version;
  }
  return { id, done, hasUpdates: false };
}

export function setQueueItemsDone(state, ids) {
  if (ids.some((id) => !state.items[id]?.version)) return null;
  for (const id of ids) setQueueItemDone(state, id, true);
  return { ids, done: true, hasUpdates: false };
}

export function setQueueItemRead(state, id, read) {
  const record = state.items[id];
  const version = currentQueueRecordVersion(record);
  if (!version) return null;
  record.version = version;
  if (read) {
    record.readVersion = version;
    record.readSnapshot = readSnapshot(record);
  } else {
    delete record.readVersion;
    delete record.readSnapshot;
  }
  return { id, read, hasUnreadUpdates: false, updatesSinceRead: [] };
}

export function inboxIdsFromNotifications(pullRequestNotifications = [], otherNotifications = []) {
  const ids = new Set();
  for (const { pr } of pullRequestNotifications) {
    if (!pr) continue;
    ids.add(prKey(pr));
  }
  for (const item of otherNotifications) {
    if (item?.id) ids.add(item.id);
  }
  return ids;
}

export function applyInboxMembership(state, inboxIds, authoredOpenIds = []) {
  const present = inboxIds == null ? null : inboxIds instanceof Set ? inboxIds : new Set(inboxIds);
  const authored = authoredOpenIds instanceof Set ? authoredOpenIds : new Set(authoredOpenIds);
  for (const id of Object.keys(state.items)) {
    const record = state.items[id];
    const done = Boolean(record?.version && record.doneVersion === record.version);
    if (present?.has(id)) {
      if (done) setQueueItemDone(state, id, false);
      continue;
    }
    if (authored.has(id)) continue;
    if (present && record?.version && !done) {
      setQueueItemDone(state, id, true);
      continue;
    }
    if (present == null && record?.version && !done && isOpenAuthoredPullRequest(record.item)) {
      setQueueItemDone(state, id, true);
    }
  }
  return state;
}

export function authoredPullRequestNotifications(pullRequestNotifications = [], authoredIds = []) {
  const authored = authoredIds instanceof Set ? authoredIds : new Set(authoredIds);
  return pullRequestNotifications.filter(({ pr }) => isMyPrNotification(pr, authored));
}

export function stampAuthoredNotificationTimes(
  items,
  pullRequestNotifications = [],
  authoredIds = [],
) {
  const ids = new Set();
  for (const { thread, pr } of authoredPullRequestNotifications(
    pullRequestNotifications,
    authoredIds,
  )) {
    if (!pr) continue;
    const id = prKey(pr);
    const item = items.get(id);
    const timestamp = new Date(thread.updated_at).getTime();
    if (!item || !Number.isFinite(timestamp)) continue;
    const next = new Date(timestamp).toISOString();
    if (!item.notificationUpdatedAt || next > item.notificationUpdatedAt) {
      item.notificationUpdatedAt = next;
    }
    ids.add(id);
  }
  return ids;
}

export function applyAuthoredReadState(state, authoredOpenIds, authoredNotificationIds = null) {
  const authored = authoredOpenIds instanceof Set ? authoredOpenIds : new Set(authoredOpenIds);
  const notified =
    authoredNotificationIds == null
      ? null
      : authoredNotificationIds instanceof Set
        ? authoredNotificationIds
        : new Set(authoredNotificationIds);
  for (const id of authored) {
    const record = state.items[id];
    if (!currentQueueRecordVersion(record)) continue;
    const done = Boolean(record.version && record.doneVersion === record.version);
    if (done) setQueueItemDone(state, id, false);
    if (notified && !notified.has(id)) setQueueItemRead(state, id, true);
  }
  return state;
}

export function authoredOpenIdsFromItems(items) {
  return new Set(
    [...items.values()].filter((item) => isOpenAuthoredPullRequest(item)).map((item) => item.id),
  );
}

export function activeInboxEntries(state) {
  return applyQueueState(
    [...trackedQueueItems(state), ...trackedQueueNotifications(state)],
    state,
  ).filter((item) => !item.done);
}
