import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { normalizeSettingsAnalysisModel } from "../../shared/analysis-models.js";
import {
  ACTIVITY_SIGNAL_KINDS,
  LIFECYCLE_SCORES,
  lifecycleForQueueItem,
  SIGNAL_LABELS,
  SIGNAL_WEIGHTS,
} from "../../shared/queue-policy.js";
import { fetchPullRequestConversation } from "../review/github-review-client.js";
import { databasePath, queuePath, settingsPath } from "../runtime-config.js";
import {
  getGitHubNotifications,
  markGitHubNotificationThreadDone,
} from "./github-notifications.js";
import {
  automaticallyQueueNewAnalyses,
  sortPullRequestsBySize,
} from "./inbox-service/analysis-queue.js";
import { createInboxApi } from "./inbox-service/api.js";
import {
  apiMutationRejection,
  requestHostRejection,
  sendJson,
} from "./inbox-service/http-guards.js";
import { createInboxStore } from "./inbox-store.js";

const exec = promisify(execFile);
const searchFields =
  "author,commentsCount,createdAt,id,isDraft,labels,number,repository,state,title,updatedAt,url";
const repositoryFields = "author,createdAt,id,isDraft,number,state,title,updatedAt,url";
const hour = 60 * 60 * 1_000;
const day = 24 * hour;

export { sortPullRequestsBySize };

export const trackedRepositories = Object.freeze([
  "PicnicSupermarket/picnic-store-config",
  "PicnicSupermarket/picnic-store-app",
  "PicnicSupermarket/picnic-page-platform-modules",
]);

export const weights = SIGNAL_WEIGHTS;
export const lifecycleScores = LIFECYCLE_SCORES;

const lifecycleLabels = Object.freeze({
  reviewed: "Reviewed",
  new: "Unreviewed",
  approved: "Approved",
  merged: "Merged",
  draft: "Draft",
  mine: "My PR",
  other: "Other PR notification",
});

const signalLabels = SIGNAL_LABELS;

const activitySignalKinds = new Set(ACTIVITY_SIGNAL_KINDS);

const usernamePattern = /^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i;
const teamPattern = /^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?\/[a-z\d](?:[a-z\d-]{0,98}[a-z\d])?$/i;

function validNotificationThreadId(value) {
  const id = typeof value === "string" || typeof value === "number" ? String(value) : "";
  return /^\d+$/.test(id) ? id : null;
}

const activityQuery = `
  query($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        additions
        changedFiles
        deletions
        headRefOid
        title
        url
        state
        reviewDecision
        createdAt
        updatedAt
        mergedAt
        isDraft
        author { login }
        labels(first: 4) { nodes { name color } }
        commits(last: 1) { nodes { commit { committedDate } } }
        comments(last: 100) {
          totalCount
          nodes { author { login } createdAt url }
        }
        reviews(last: 100) {
          nodes { author { login } state submittedAt url }
        }
        reviewThreads(first: 100) {
          nodes {
            isResolved
            isOutdated
            comments(first: 100) {
              nodes { author { login } createdAt url }
            }
          }
        }
      }
    }
  }
`;

async function ghJson(args, timeout = 45_000) {
  const { stdout } = await exec("gh", args, {
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
    timeout,
  });
  return JSON.parse(stdout);
}

async function markGitHubNotificationDone(threadId) {
  await markGitHubNotificationThreadDone(threadId);
}

let detectedUser;
async function getDetectedUser() {
  detectedUser ??= ghJson(["api", "user"])
    .then((user) => user.login)
    .catch((error) => {
      detectedUser = undefined;
      throw error;
    });
  return detectedUser;
}

function parseList(value, pattern, limit) {
  const parts = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  return [...new Set(parts.map((part) => String(part).trim()).filter(Boolean))]
    .filter((part) => pattern.test(part))
    .slice(0, limit);
}

export function normalizeSettings(value = {}) {
  const username = typeof value.username === "string" ? value.username.trim() : "";
  return {
    username: usernamePattern.test(username) ? username : "",
    people: parseList(value.people, usernamePattern, 20),
    teams: parseList(value.teams, teamPattern, 10),
    autoQueue: value.autoQueue === true,
    showMinimap: value.showMinimap === true,
    defaultAnalysisModel: normalizeSettingsAnalysisModel(value.defaultAnalysisModel),
  };
}

let inboxStorePromise;
export function getInboxStore() {
  inboxStorePromise ??= createInboxStore({
    databasePath,
    legacyQueuePath: queuePath,
    legacySettingsPath: settingsPath,
    normalizeQueueState,
    normalizeSettings,
  });
  return inboxStorePromise;
}

export async function closeInboxStore() {
  const pendingStore = inboxStorePromise;
  inboxStorePromise = undefined;
  if (pendingStore) (await pendingStore).close();
}

async function readSettings() {
  return normalizeSettings((await getInboxStore()).readSettings());
}

async function saveSettings(value) {
  const settings = normalizeSettings({ ...(await readSettings()), ...value });
  return (await getInboxStore()).saveSettings(settings);
}

function normalizeQueueState(value = {}) {
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
      notificationLastModified:
        typeof sync.notificationLastModified === "string" ? sync.notificationLastModified : "",
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
      repositories: (Array.isArray(sync.repositories) ? sync.repositories : []).filter(
        (repository) => trackedRepositories.includes(repository),
      ),
    },
    items,
  };
}

async function readQueueState(options) {
  return normalizeQueueState((await getInboxStore()).readQueueState(options));
}

export function queueVersion(item) {
  if (item.kind === "notification") {
    return `${item.updatedAt}:${item.unread ? "unread" : "read"}`;
  }
  return [item.updatedAt, item.notificationUpdatedAt].filter(Boolean).sort().at(-1) ?? "";
}

function queueItemFromRecord(id, record) {
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

function queueItemSnapshot(item) {
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

function trackedQueueNotifications(state) {
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

function readSnapshot(record) {
  const item = record.item ?? {};
  return {
    title: typeof item.title === "string" ? item.title : "",
    state: typeof item.state === "string" ? item.state : "UNKNOWN",
    comments: Number.isInteger(item.comments) ? item.comments : 0,
    headSha: typeof item.headSha === "string" ? item.headSha : "",
    draft: Boolean(item.draft),
  };
}

function currentQueueRecordVersion(record) {
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

export function applyAutomaticDone(state, entries, now = Date.now()) {
  for (const item of entries) {
    const record = state.items[item.id];
    const updatedAt = new Date(item.updatedAt).getTime();
    if (!record?.version || !Number.isFinite(updatedAt)) continue;
    const maximumAge = item.state === "MERGED" ? day : 7 * day;
    if (
      now - updatedAt > maximumAge &&
      record.doneVersion !== record.version &&
      record.activeVersion !== record.version
    ) {
      record.doneVersion = record.version;
      record.doneSnapshot = readSnapshot(record);
    }
  }
  return state;
}

async function mutateQueueState(callback, options) {
  return (await getInboxStore()).mutateQueueState(callback, options);
}

async function attachQueueState(inbox) {
  return mutateQueueState((state) => {
    const entries = [...inbox.items, ...inbox.notifications];
    rememberQueueItems(state, entries, inbox.fetchedAt);
    return {
      ...inbox,
      items: applyQueueState(inbox.items, state),
      notifications: applyQueueState(inbox.notifications, state),
    };
  });
}

async function searchPrs(args, repositories = trackedRepositories) {
  return ghJson([
    "search",
    "prs",
    ...args,
    ...repositories.flatMap((repository) => ["--repo", repository]),
    "--state",
    "open",
    "--sort",
    "updated",
    "--order",
    "desc",
    "--limit",
    "100",
    "--json",
    searchFields,
  ]);
}

function repositoryName(pr) {
  return typeof pr.repository === "string" ? pr.repository : pr.repository.nameWithOwner;
}

function prKey(pr) {
  return `${repositoryName(pr)}#${pr.number}`;
}

function normalizePr(pr) {
  return {
    id: prKey(pr),
    number: pr.number,
    title: pr.title,
    url: pr.url,
    repository: repositoryName(pr),
    author: pr.author?.login ?? "",
    state: typeof pr.state === "string" ? pr.state.toUpperCase() : "OPEN",
    comments: pr.commentsCount ?? 0,
    createdAt: pr.createdAt ?? pr.updatedAt,
    updatedAt: pr.updatedAt,
    mergedAt: pr.mergedAt ?? null,
    draft: pr.isDraft ?? false,
    labels: (pr.labels ?? []).slice(0, 4).map((label) => ({
      name: label.name,
      color: label.color,
    })),
    signals: [],
    notification: null,
    authored: false,
    reviewed: false,
    latestReviewState: null,
    reviewDecision: typeof pr.reviewDecision === "string" ? pr.reviewDecision : null,
    notificationThreadId: validNotificationThreadId(pr.notificationThreadId),
    additions: pr.additions ?? null,
    deletions: pr.deletions ?? null,
    changedFiles: pr.changedFiles ?? null,
    headSha: pr.headSha ?? pr.headRefOid ?? "",
  };
}

function mergePr(item, pr) {
  const incoming = normalizePr(pr);
  return {
    ...item,
    title: incoming.title || item.title,
    url: incoming.url || item.url,
    author: incoming.author || item.author,
    state: typeof pr.state === "string" ? pr.state.toUpperCase() : item.state,
    comments: pr.commentsCount == null ? item.comments : incoming.comments,
    createdAt: pr.createdAt ?? item.createdAt,
    updatedAt:
      new Date(incoming.updatedAt) > new Date(item.updatedAt) ? incoming.updatedAt : item.updatedAt,
    mergedAt: pr.mergedAt ?? item.mergedAt,
    draft: typeof pr.isDraft === "boolean" ? incoming.draft : item.draft,
    labels: incoming.labels.length ? incoming.labels : item.labels,
    additions: pr.additions ?? item.additions,
    deletions: pr.deletions ?? item.deletions,
    changedFiles: pr.changedFiles ?? item.changedFiles,
    headSha: pr.headSha ?? pr.headRefOid ?? item.headSha,
    reviewDecision: typeof pr.reviewDecision === "string" ? pr.reviewDecision : item.reviewDecision,
    notificationThreadId:
      validNotificationThreadId(pr.notificationThreadId) ?? item.notificationThreadId,
  };
}

export function addSignal(items, pr, kind, detail = "", href = pr.url) {
  const key = prKey(pr);
  const item = items.has(key) ? mergePr(items.get(key), pr) : normalizePr(pr);
  if (!item.signals.some((signal) => signal.kind === kind)) {
    item.signals.push({
      kind,
      label: signalLabels[kind],
      detail,
      weight: weights[kind],
      href,
    });
  }
  items.set(key, item);
}

export function addSource(items, pr, source, detail = "") {
  const key = prKey(pr);
  const existing = items.get(key);
  const item = !existing
    ? normalizePr(pr)
    : source === "notification"
      ? existing
      : mergePr(existing, pr);
  if (source === "notification") {
    item.notification = {
      reason: detail,
      updatedAt: pr.updatedAt,
    };
    item.notificationThreadId =
      validNotificationThreadId(pr.notificationThreadId) ?? item.notificationThreadId;
  }
  if (source === "authored") item.authored = true;
  if (source === "reviewed") item.reviewed = true;
  items.set(key, item);
}

export function addReviewRequests(items, prs, kind, detail = "") {
  for (const item of prs) addSignal(items, item, kind, detail);
}

export function trackedPrs(items, prs) {
  return prs.filter((pr) => items.has(prKey(pr)));
}

export function rankItems(items) {
  return [...items.values()]
    .map((item) => {
      const lifecycle = lifecycleForQueueItem(item);
      item.signals.sort((a, b) => b.weight - a.weight);
      let reviewRequestScore = 0;
      const signalScore = item.signals.reduce((total, signal) => {
        if (signal.kind === "direct-review" || signal.kind === "team-review") {
          reviewRequestScore = Math.max(reviewRequestScore, signal.weight);
          return total;
        }
        return total + signal.weight;
      }, 0);
      return {
        ...item,
        lifecycle,
        lifecycleLabel: lifecycleLabels[lifecycle],
        lifecycleScore: lifecycleScores[lifecycle],
        score: lifecycleScores[lifecycle] + signalScore + reviewRequestScore,
        actionUrl: item.signals.find((signal) => signal.weight > 0)?.href ?? item.url,
      };
    })
    .sort(
      (a, b) =>
        b.score - a.score || new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    );
}

export function inboxFromQueue(state, username = state.sync?.username ?? "") {
  const items = rankItems(new Map(trackedQueueItems(state).map((item) => [item.id, item])));
  const notifications = trackedQueueNotifications(state);
  return {
    username,
    fetchedAt: state.sync?.lastSyncedAt || null,
    repositories: trackedRepositories,
    items: applyQueueState(items, state),
    notifications: applyQueueState(notifications, state),
    notificationSummary: {
      total: notifications.length,
      pullRequests: 0,
      nonPullRequests: notifications.length,
    },
    warnings: [],
  };
}

export function summarizeActivity(activity, username, teammates = []) {
  const normalizedUser = username.toLowerCase();
  const teammateSet = new Set(teammates.map((person) => person.toLowerCase()));
  const reviews = activity.reviews?.nodes ?? [];
  const myReviews = reviews.filter(
    (review) => review.author?.login?.toLowerCase() === normalizedUser,
  );
  const latestReview = myReviews.at(-1) ?? null;
  const latestReviewAt = latestReview?.submittedAt ?? null;
  let newestReply = null;

  for (const thread of activity.reviewThreads?.nodes ?? []) {
    const comments = thread.comments?.nodes ?? [];
    const latestMine = [...comments]
      .reverse()
      .find((comment) => comment.author?.login?.toLowerCase() === normalizedUser);
    const latest = comments.at(-1);
    if (
      latestMine &&
      latest?.author?.login?.toLowerCase() !== normalizedUser &&
      new Date(latest.createdAt) > new Date(latestMine.createdAt) &&
      (!latestReviewAt || new Date(latest.createdAt) > new Date(latestReviewAt)) &&
      (!newestReply || new Date(latest.createdAt) > new Date(newestReply.createdAt))
    ) {
      newestReply = latest;
    }
  }

  const lastCommitAt = activity.commits?.nodes?.at(-1)?.commit?.committedDate ?? null;
  const newComment = latestReviewAt
    ? [...(activity.comments?.nodes ?? [])]
        .reverse()
        .find(
          (comment) =>
            comment.author?.login?.toLowerCase() !== normalizedUser &&
            new Date(comment.createdAt) > new Date(latestReviewAt),
        )
    : null;
  const coveringReview = reviews.find(
    (review) =>
      teammateSet.has(review.author?.login?.toLowerCase()) &&
      !["DISMISSED", "PENDING"].includes(review.state),
  );
  const postMergeComment = activity.mergedAt
    ? ([
        ...(activity.comments?.nodes ?? []),
        ...(activity.reviewThreads?.nodes ?? []).flatMap((thread) => thread.comments?.nodes ?? []),
      ]
        .filter(
          (comment) =>
            comment.author?.login?.toLowerCase() !== normalizedUser &&
            new Date(comment.createdAt) > new Date(activity.mergedAt),
        )
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0] ?? null)
    : null;

  return {
    latestReviewState: latestReview?.state ?? null,
    latestReviewAt,
    newestReply,
    newComment,
    postMergeComment,
    hasNewCommits:
      Boolean(latestReviewAt && lastCommitAt) && new Date(lastCommitAt) > new Date(latestReviewAt),
    coveringTeammate: coveringReview?.author?.login ?? "",
  };
}

async function mapLimited(values, limit, callback) {
  const results = [];
  let cursor = 0;

  async function worker() {
    while (cursor < values.length) {
      const index = cursor++;
      results[index] = await callback(values[index]);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, worker));
  return results;
}

export async function cacheReviewConversations(
  items,
  { fetchConversation = fetchPullRequestConversation, store } = {},
) {
  const candidates = new Map();
  for (const item of items) {
    const coordinates = conversationCoordinates(item);
    if (coordinates) {
      candidates.set(`${coordinates.owner}/${coordinates.repo}#${coordinates.number}`, coordinates);
    }
  }

  const conversationStore = store ?? (await getInboxStore());
  const outcomes = await mapLimited([...candidates.values()], 3, async (coordinates) => {
    try {
      const conversation = await fetchConversation(coordinates);
      conversationStore.saveReviewConversation({ ...coordinates, conversation });
      return true;
    } catch {
      return false;
    }
  });
  return {
    cached: outcomes.filter(Boolean).length,
    warnings: outcomes.some((cached) => !cached)
      ? ["Some pull request conversations could not be cached."]
      : [],
  };
}

function conversationCoordinates(item) {
  if (item?.kind === "notification" || !Number.isInteger(item?.number)) return null;
  const [owner, repo, ...rest] = String(item.repository || "").split("/");
  return owner && repo && rest.length === 0 ? { number: item.number, owner, repo } : null;
}

function activeQueueItems(state) {
  return Object.entries(state.items)
    .filter(([, record]) => record?.version && record.doneVersion !== record.version)
    .map(([id, record]) => queueItemFromRecord(id, record))
    .filter((item) => item && item.kind !== "notification");
}

export function prFromNotification(thread) {
  if (thread.subject?.type !== "PullRequest" || !thread.subject.url) return null;

  try {
    const number = Number.parseInt(new URL(thread.subject.url).pathname.split("/").at(-1), 10);
    const repository = thread.repository?.full_name;
    if (!repository || !Number.isInteger(number)) return null;
    return {
      number,
      title: thread.subject.title,
      url: `https://github.com/${repository}/pull/${number}`,
      repository: { nameWithOwner: repository },
      updatedAt: thread.updated_at,
      state: "UNKNOWN",
      notificationThreadId: validNotificationThreadId(thread.id),
    };
  } catch {
    return null;
  }
}

function notificationWebUrl(thread) {
  const repositoryUrl =
    thread.repository?.html_url ?? `https://github.com/${thread.repository?.full_name ?? ""}`;
  try {
    const parts = new URL(thread.subject.url).pathname.replace(/^\/repos\//, "").split("/");
    const [owner, repository, resource, value] = parts;
    const route = {
      pulls: "pull",
      commits: "commit",
      issues: "issues",
      discussions: "discussions",
    }[resource];
    return route && owner && repository && value
      ? `https://github.com/${owner}/${repository}/${route}/${value}`
      : repositoryUrl;
  } catch {
    return repositoryUrl;
  }
}

export function otherNotificationFromThread(thread) {
  if (thread.subject?.type === "PullRequest") return null;
  return {
    id: `notification:${thread.id}`,
    kind: "notification",
    title: thread.subject?.title ?? "GitHub notification",
    url: notificationWebUrl(thread),
    repository: thread.repository?.full_name ?? "GitHub",
    subjectType: thread.subject?.type ?? "Notification",
    reason: thread.reason,
    updatedAt: thread.updated_at,
    unread: Boolean(thread.unread),
    notificationThreadId: validNotificationThreadId(thread.id),
  };
}

async function getNotifications({ lastModified, since } = {}) {
  const result = await getGitHubNotifications({ lastModified, since });
  const threads = result.threads;
  const pullRequests = threads
    .map((thread) => ({ thread, pr: prFromNotification(thread) }))
    .filter(({ pr }) => pr);
  return {
    lastModified: result.lastModified,
    notModified: result.notModified,
    pollIntervalSeconds: result.pollIntervalSeconds,
    total: threads.length,
    pullRequests,
    other: threads.map(otherNotificationFromThread).filter(Boolean),
  };
}

export function seedNotificationPullRequests(
  items,
  pullRequestNotifications,
  repositories = trackedRepositories,
) {
  const allowed = new Set(repositories);
  for (const { thread, pr } of pullRequestNotifications) {
    if (
      allowed.has(repositoryName(pr)) &&
      (items.has(prKey(pr)) || thread.reason === "review_requested")
    ) {
      addSource(items, pr, "notification", thread.reason);
    }
  }
  return items;
}

export function activityCandidates(items, pullRequestNotifications, limit = 60) {
  const notificationTimes = new Map();
  for (const { thread, pr } of pullRequestNotifications) {
    const id = prKey(pr);
    if (!items.has(id)) continue;
    const timestamp = new Date(thread.updated_at).getTime();
    if (!Number.isFinite(timestamp)) continue;
    notificationTimes.set(id, Math.max(notificationTimes.get(id) ?? 0, timestamp));
  }

  const candidates = [...items.values()].map((item) => {
    const itemTimestamp = new Date(item.updatedAt).getTime();
    const updatedAt = Number.isFinite(itemTimestamp) ? itemTimestamp : 0;
    const notificationAt = notificationTimes.get(item.id) ?? 0;
    const seenNotificationAt = new Date(item.notificationUpdatedAt).getTime() || 0;
    return {
      item,
      changed:
        notificationAt > seenNotificationAt &&
        (notificationAt > updatedAt || (item.state === "UNKNOWN" && notificationAt >= updatedAt)),
      priority: Math.max(updatedAt, notificationAt),
    };
  });
  candidates.sort(
    (left, right) => Number(right.changed) - Number(left.changed) || right.priority - left.priority,
  );

  const changedCount = candidates.filter(({ changed }) => changed).length;
  return candidates.slice(0, Math.max(limit, changedCount)).map(({ item }) => item);
}

async function listRepositoryPullRequests(repository, historical, since) {
  if (historical) {
    const pullRequests = await ghJson(
      [
        "pr",
        "list",
        "--repo",
        repository,
        "--state",
        "all",
        "--limit",
        "10000",
        "--json",
        repositoryFields,
      ],
      120_000,
    );
    return pullRequests
      .filter((pr) => ["OPEN", "MERGED"].includes(pr.state))
      .map((pr) => ({
        ...pr,
        repository: { nameWithOwner: repository },
      }));
  }

  const [open, merged] = await Promise.all([
    ghJson(
      [
        "pr",
        "list",
        "--repo",
        repository,
        "--state",
        "open",
        "--limit",
        "1000",
        "--json",
        repositoryFields,
      ],
      60_000,
    ),
    ghJson(
      [
        "pr",
        "list",
        "--repo",
        repository,
        "--state",
        "merged",
        "--search",
        `updated:>=${since}`,
        "--limit",
        "1000",
        "--json",
        repositoryFields,
      ],
      60_000,
    ),
  ]);
  return [...new Map([...open, ...merged].map((pr) => [pr.url, pr])).values()].map((pr) => ({
    ...pr,
    repository: { nameWithOwner: repository },
  }));
}

export async function refreshNotificationItems(
  items,
  pullRequestNotifications,
  touched,
  { getActivity = getPrActivity, username = "" } = {},
) {
  const before = new Set(items.keys());
  const notificationTimes = new Map();
  for (const { thread, pr } of pullRequestNotifications) {
    const id = prKey(pr);
    if (items.has(id)) touched.add(id);
    const timestamp = new Date(thread.updated_at).getTime();
    if (Number.isFinite(timestamp)) {
      notificationTimes.set(id, Math.max(notificationTimes.get(id) ?? 0, timestamp));
    }
  }
  seedNotificationPullRequests(items, pullRequestNotifications, trackedRepositories);
  for (const id of items.keys()) {
    if (!before.has(id)) touched.add(id);
  }

  const warnings = [];
  const inspected = await mapLimited(
    activityCandidates(items, pullRequestNotifications, 0),
    5,
    async (item) => {
      try {
        return { item, activity: await getActivity(item) };
      } catch {
        return { failed: true };
      }
    },
  );
  for (const result of inspected) {
    if (result.failed) {
      warnings.push("Some notified pull requests could not be refreshed.");
      continue;
    }
    const pr = prFromActivity(result.item, result.activity);
    addSource(items, pr, "activity");
    const item = items.get(prKey(pr));
    item.authored ||= pr.author?.login?.toLowerCase() === username.toLowerCase();
    item.latestReviewState = summarizeActivity(result.activity, username).latestReviewState;
    item.reviewed ||= Boolean(item.latestReviewState);
    items.set(item.id, item);
    const id = prKey(pr);
    const notificationAt = notificationTimes.get(id);
    if (notificationAt) {
      items.get(id).notificationUpdatedAt = new Date(notificationAt).toISOString();
    }
    touched.add(id);
  }
  return warnings;
}

export async function syncNotifications(now = new Date(), { dashboardService } = {}) {
  const startedAt = now.toISOString();
  const [initialState, saved] = await Promise.all([readQueueState(), readSettings()]);
  const username = saved.username || initialState.sync.username || (await getDetectedUser());
  const previousSync = new Date(
    initialState.sync.notificationsSyncedAt || initialState.sync.lastSyncedAt,
  ).getTime();
  const since = new Date(
    (Number.isFinite(previousSync) ? previousSync : now.getTime() - 7 * day) - 5 * 60_000,
  ).toISOString();
  const notifications = await getNotifications({
    lastModified: initialState.sync.notificationLastModified,
    since,
  });
  if (notifications.notModified) {
    const automaticAnalysis =
      dashboardService && saved.autoQueue
        ? await automaticallyQueueNewAnalyses(
            inboxFromQueue(initialState).items,
            dashboardService,
            {
              model: saved.defaultAnalysisModel,
            },
          )
        : { runs: [], warnings: [] };
    return {
      added: 0,
      autoQueued: automaticAnalysis.runs.length,
      fetched: 0,
      notModified: true,
      pollIntervalSeconds: notifications.pollIntervalSeconds,
      tracked: Object.keys(initialState.items).length,
      warnings: automaticAnalysis.warnings,
    };
  }
  const items = new Map(trackedQueueItems(initialState).map((item) => [item.id, item]));
  const initialIds = new Set(Object.keys(initialState.items));
  const touched = new Set();
  const warnings = await refreshNotificationItems(items, notifications.pullRequests, touched, {
    username,
  });
  const entries = [
    ...[...touched].map((id) => items.get(id)).filter(Boolean),
    ...notifications.other,
  ];

  const summary = await mutateQueueState(
    (state) => {
      rememberQueueItems(state, entries, startedAt);
      for (const notification of notifications.other) {
        if (!notification.unread) setQueueItemDone(state, notification.id, true);
      }
      state.sync.notificationLastModified = notifications.lastModified;
      state.sync.notificationPollIntervalSeconds = notifications.pollIntervalSeconds;
      state.sync.notificationsSyncedAt = startedAt;
      state.sync.username = username;
      const added = entries.filter((item) => !initialIds.has(item.id)).length;
      return {
        fetched: entries.length,
        added,
        tracked: initialIds.size + added,
        warnings: [...new Set(warnings)],
      };
    },
    { ids: entries.map((item) => item.id), updateSync: true },
  );
  const queueState = await readQueueState();
  const [conversationCache, automaticAnalysis] = await Promise.all([
    cacheReviewConversations(entries),
    dashboardService && saved.autoQueue
      ? automaticallyQueueNewAnalyses(inboxFromQueue(queueState).items, dashboardService, {
          model: saved.defaultAnalysisModel,
        })
      : { runs: [], warnings: [] },
  ]);
  return {
    ...summary,
    autoQueued: automaticAnalysis.runs.length,
    notModified: false,
    pollIntervalSeconds: notifications.pollIntervalSeconds,
    warnings: [
      ...new Set([
        ...summary.warnings,
        ...conversationCache.warnings,
        ...automaticAnalysis.warnings,
      ]),
    ],
  };
}

export async function syncQueue(now = new Date(), { dashboardService } = {}) {
  const startedAt = now.toISOString();
  const [initialState, saved] = await Promise.all([readQueueState(), readSettings()]);
  const username = saved.username || initialState.sync.username || (await getDetectedUser());
  const backfilled = new Set(initialState.sync.repositories);
  const previousSync = new Date(initialState.sync.lastSyncedAt).getTime();
  const since = new Date(
    (Number.isFinite(previousSync) ? previousSync : now.getTime() - day) - 5 * 60_000,
  ).toISOString();
  const repositoryTasks = trackedRepositories.map(async (repository) => ({
    repository,
    historical: !backfilled.has(repository),
    pullRequests: await listRepositoryPullRequests(repository, !backfilled.has(repository), since),
  }));
  const [notificationsResult, ...repositoryResults] = await Promise.allSettled([
    getNotifications({
      lastModified: initialState.sync.notificationLastModified,
      since,
    }),
    ...repositoryTasks,
  ]);

  const items = new Map(trackedQueueItems(initialState).map((item) => [item.id, item]));
  const initialIds = new Set(Object.keys(initialState.items));
  const touched = new Set();
  const warnings = [];

  for (const result of repositoryResults) {
    if (result.status === "rejected") {
      warnings.push("One repository could not be synchronized.");
      continue;
    }
    for (const pr of result.value.pullRequests) {
      addSource(items, pr, "repository");
      touched.add(prKey(pr));
    }
  }

  let pullRequestNotifications = [];
  if (notificationsResult.status === "fulfilled") {
    pullRequestNotifications = notificationsResult.value.pullRequests;
    warnings.push(
      ...(await refreshNotificationItems(items, pullRequestNotifications, touched, {
        username,
      })),
    );
  } else {
    warnings.push("GitHub notifications could not be synchronized.");
  }

  const notificationItems =
    notificationsResult.status === "fulfilled" ? notificationsResult.value.other : [];
  const entries = [
    ...[...touched].map((id) => items.get(id)).filter(Boolean),
    ...notificationItems,
  ];
  const summary = await mutateQueueState((state) => {
    rememberQueueItems(state, entries, startedAt);
    for (const notification of notificationItems) {
      if (!notification.unread) setQueueItemDone(state, notification.id, true);
    }
    applyAutomaticDone(
      state,
      [
        ...trackedQueueItems(state).filter((item) => trackedRepositories.includes(item.repository)),
        ...trackedQueueNotifications(state),
      ],
      now.getTime(),
    );
    for (const result of repositoryResults) {
      if (result.status === "fulfilled" && result.value.historical) {
        backfilled.add(result.value.repository);
      }
    }
    state.sync.repositories = [...backfilled].filter((repository) =>
      trackedRepositories.includes(repository),
    );
    if (notificationsResult.status === "fulfilled") {
      state.sync.notificationLastModified = notificationsResult.value.lastModified;
      state.sync.notificationPollIntervalSeconds = notificationsResult.value.pollIntervalSeconds;
      state.sync.notificationsSyncedAt = startedAt;
    }
    if (repositoryResults.every((result) => result.status === "fulfilled")) {
      state.sync.lastSyncedAt = startedAt;
    }
    state.sync.username = username;

    return {
      fetched: entries.length,
      added: entries.filter((item) => !initialIds.has(item.id)).length,
      tracked: Object.keys(state.items).length,
      done: Object.values(state.items).filter((record) => record.doneVersion === record.version)
        .length,
      repositories: state.sync.repositories,
      warnings: [...new Set(warnings)],
    };
  });

  const queueState = await readQueueState();
  const [conversationCache, inbox] = await Promise.all([
    cacheReviewConversations(activeQueueItems(queueState)),
    collectInbox({
      username,
      teammates: saved.people,
      teams: saved.teams,
      queueState,
      notificationData:
        notificationsResult.status === "fulfilled" ? notificationsResult.value : undefined,
    }).then(attachQueueState),
  ]);
  const automaticAnalysis =
    dashboardService && saved.autoQueue
      ? await automaticallyQueueNewAnalyses(inbox.items, dashboardService, {
          model: saved.defaultAnalysisModel,
        })
      : { runs: [], warnings: [] };
  return {
    ...summary,
    active: inbox.items.filter((item) => !item.done).length,
    autoQueued: automaticAnalysis.runs.length,
    pollIntervalSeconds:
      notificationsResult.status === "fulfilled"
        ? notificationsResult.value.pollIntervalSeconds
        : initialState.sync.notificationPollIntervalSeconds,
    warnings: [
      ...new Set([
        ...summary.warnings,
        ...conversationCache.warnings,
        ...inbox.warnings,
        ...automaticAnalysis.warnings,
      ]),
    ],
  };
}

async function getPrActivity(pr) {
  const [owner, name] = repositoryName(pr).split("/");
  const result = await ghJson([
    "api",
    "graphql",
    "-f",
    `query=${activityQuery}`,
    "-f",
    `owner=${owner}`,
    "-f",
    `name=${name}`,
    "-F",
    `number=${pr.number}`,
  ]);
  const activity = result.data?.repository?.pullRequest;
  if (!activity) throw new Error("Pull request activity unavailable");
  return activity;
}

function prFromActivity(item, activity) {
  const reviewCommentCount = (activity.reviewThreads?.nodes ?? []).reduce(
    (total, thread) => total + (thread.comments?.nodes?.length ?? 0),
    0,
  );
  return {
    number: item.number,
    title: activity.title,
    url: activity.url,
    repository: { nameWithOwner: item.repository },
    author: { login: activity.author?.login ?? "" },
    state: activity.state,
    reviewDecision: activity.reviewDecision,
    commentsCount: (activity.comments?.totalCount ?? 0) + reviewCommentCount,
    createdAt: activity.createdAt,
    updatedAt: activity.updatedAt,
    mergedAt: activity.mergedAt,
    isDraft: activity.isDraft,
    additions: activity.additions,
    deletions: activity.deletions,
    changedFiles: activity.changedFiles,
    headSha: activity.headRefOid,
    labels: activity.labels?.nodes ?? [],
  };
}

export async function collectInbox({
  username,
  teammates,
  teams,
  repositories = trackedRepositories,
  queueState = { items: {} },
  notificationData,
}) {
  const items = new Map(
    trackedQueueItems(queueState).map((item) => [
      item.id,
      { ...item, signals: [], notification: null },
    ]),
  );
  const warnings = [];
  let notifications = [];
  let pullRequestNotifications = [];
  let notificationSummary = { total: 0, pullRequests: 0, nonPullRequests: 0 };
  const tasks = [
    {
      kind: "direct-review",
      args: [`user-review-requested:${username}`],
    },
    ...teammates
      .filter((person) => person.toLowerCase() !== username.toLowerCase())
      .map((person) => ({
        kind: "teammate-pr",
        detail: person,
        args: ["--author", person],
      })),
    ...teams.flatMap((team) => [
      {
        kind: "team-review",
        detail: team,
        args: [`team-review-requested:${team}`],
      },
    ]),
  ];

  const [notificationsResult, authoredResult, reviewedResult, ...taskResults] =
    await Promise.allSettled([
      notificationData ? Promise.resolve(notificationData) : getNotifications(),
      searchPrs(["--author", username], repositories),
      searchPrs(["--reviewed-by", username], repositories),
      ...tasks.map(async (task) => ({
        task,
        prs: await searchPrs(task.args, repositories),
      })),
    ]);

  if (notificationsResult.status === "fulfilled") {
    const result = notificationsResult.value;
    notifications = result.other.filter((item) => item.unread);
    pullRequestNotifications = result.pullRequests;
    seedNotificationPullRequests(items, pullRequestNotifications, repositories);
    notificationSummary = {
      total: result.total,
      pullRequests: result.pullRequests.length,
      nonPullRequests: notifications.length,
    };
  } else {
    warnings.push("GitHub notifications could not be loaded.");
  }

  if (authoredResult.status === "fulfilled") {
    for (const pr of authoredResult.value) addSource(items, pr, "authored");
  } else {
    warnings.push("Your pull requests could not be loaded.");
  }

  for (const result of taskResults) {
    if (
      result.status === "fulfilled" &&
      ["direct-review", "team-review"].includes(result.value.task.kind)
    ) {
      const { task, prs } = result.value;
      addReviewRequests(items, prs, task.kind, task.detail);
    }
  }

  if (reviewedResult.status === "fulfilled") {
    for (const pr of trackedPrs(items, reviewedResult.value)) {
      addSource(items, pr, "reviewed");
    }
  } else {
    warnings.push("Your reviewed pull requests could not be loaded.");
  }

  for (const result of taskResults) {
    if (result.status === "rejected") {
      warnings.push("One GitHub search could not be loaded.");
      continue;
    }
    const { task, prs } = result.value;
    if (["direct-review", "team-review"].includes(task.kind)) continue;
    for (const pr of trackedPrs(items, prs)) {
      addSignal(items, pr, task.kind, task.detail);
    }
  }

  // ponytail: inspect the newest 60 plus any tracked PR with a newer notification.
  const candidates = activityCandidates(items, pullRequestNotifications);
  const inspected = await mapLimited(candidates, 5, async (item) => {
    try {
      return { item, activity: await getPrActivity(item) };
    } catch {
      return { failed: true };
    }
  });

  let failedInspections = 0;
  for (const result of inspected) {
    if (result.failed) {
      failedInspections++;
      continue;
    }

    const pr = prFromActivity(result.item, result.activity);
    addSource(items, pr, "activity");
    const summary = summarizeActivity(result.activity, username, teammates);
    const item = items.get(prKey(pr));
    item.authored ||= pr.author?.login?.toLowerCase() === username.toLowerCase();
    item.latestReviewState = summary.latestReviewState;
    item.reviewed ||= Boolean(summary.latestReviewState);
    items.set(item.id, item);

    if (summary.postMergeComment) {
      addSignal(
        items,
        pr,
        "post-merge-comment",
        summary.postMergeComment.author?.login ?? "",
        summary.postMergeComment.url ?? pr.url,
      );
    } else if (summary.newestReply) {
      addSignal(
        items,
        pr,
        "review-reply",
        summary.newestReply.author?.login ?? "",
        summary.newestReply.url ?? pr.url,
      );
    }
    if (summary.hasNewCommits && pr.state !== "MERGED") {
      addSignal(items, pr, "new-commits");
    }

    const current = items.get(prKey(pr));
    if (
      summary.newComment &&
      !summary.postMergeComment &&
      !current.signals.some((signal) => ["review-reply", "direct-mention"].includes(signal.kind))
    ) {
      addSignal(
        items,
        pr,
        "new-comments",
        summary.newComment.author?.login ?? "",
        summary.newComment.url ?? pr.url,
      );
    }

    const enriched = items.get(prKey(pr));
    if (
      summary.coveringTeammate &&
      enriched.signals.some((signal) => signal.kind === "team-review") &&
      !enriched.signals.some((signal) => signal.kind === "teammate-pr")
    ) {
      addSignal(items, pr, "team-covered", summary.coveringTeammate);
    }
  }
  if (failedInspections) warnings.push("Some pull request activity could not be inspected.");

  return {
    username,
    fetchedAt: new Date().toISOString(),
    items: rankItems(items),
    notifications,
    notificationSummary,
    warnings: [...new Set(warnings)],
  };
}

export function rejectUntrustedApiMutation(request, response, pathname) {
  const rejection = apiMutationRejection(request, pathname);
  if (!rejection) return false;
  sendJson(response, rejection.status, { error: rejection.error });
  return true;
}

export function rejectUntrustedRequestHost(request, response) {
  const rejection = requestHostRejection(request);
  if (!rejection) return false;
  sendJson(response, rejection.status, { error: rejection.error });
  return true;
}

export { apiMutationRejection, requestHostRejection } from "./inbox-service/http-guards.js";

export const handleApiRequest = createInboxApi({
  getInboxStore,
  getNotifications,
  inboxFromQueue,
  markGitHubNotificationDone,
  mutateQueueState,
  prKey,
  readQueueState,
  readSettings,
  saveSettings,
  setQueueItemDone,
  setQueueItemRead,
  setQueueItemsDone,
  validNotificationThreadId,
});
