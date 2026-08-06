import { execFile } from "node:child_process";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { homedir } from "node:os";
import { dirname, extname, join, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
export const defaultPort = 4397;
const port = Number.parseInt(process.env.PORT ?? String(defaultPort), 10);
const host = "127.0.0.1";
const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const clientRoot = join(projectRoot, "client");
const cockpitOrigin = `http://${host}:${port}`;
const reviewsDir = join(projectRoot, ".reviews");
const settingsPath = join(homedir(), ".config", "pr-review-cockpit", "settings.json");
const queuePath = join(homedir(), ".config", "pr-review-cockpit", "queue.json");
const queueLockPath = `${queuePath}.lock`;
const searchFields =
  "author,commentsCount,createdAt,id,isDraft,labels,number,repository,state,title,updatedAt,url";
const repositoryFields = "author,createdAt,id,isDraft,number,state,title,updatedAt,url";
const hour = 60 * 60 * 1_000;
const day = 24 * hour;

export const trackedRepositories = Object.freeze([
  "PicnicSupermarket/picnic-store-config",
  "PicnicSupermarket/picnic-store-app",
  "PicnicSupermarket/picnic-page-platform-modules",
]);

export const weights = Object.freeze({
  "direct-review": 10,
  "post-merge-comment": 10,
  "teammate-pr": 7,
  "review-reply": 6,
  "direct-mention": 6,
  "my-pr-activity": 5,
  "new-commits": 3,
  "team-review": 3,
  "new-comments": 2,
  "team-mention": 2,
  "team-covered": -4,
});

export const lifecycleScores = Object.freeze({
  reviewed: 10,
  new: 0,
  approved: -5,
  merged: -5,
  draft: -10,
  mine: 0,
  other: 0,
});

const lifecycleLabels = Object.freeze({
  reviewed: "Reviewed",
  new: "Unreviewed",
  approved: "Approved",
  merged: "Merged",
  draft: "Draft",
  mine: "My PR",
  other: "Other PR notification",
});

const signalLabels = Object.freeze({
  "direct-review": "Direct review request",
  "post-merge-comment": "Comment after merge",
  "teammate-pr": "Teammate PR",
  "review-reply": "Reply to your review",
  "direct-mention": "Mentioned you",
  "my-pr-activity": "Activity on your PR",
  "new-commits": "New commits",
  "team-review": "Team review request",
  "new-comments": "New comments",
  "team-mention": "Team mentioned",
  "team-covered": "Covered by teammate",
});

const activitySignalKinds = new Set([
  "direct-review",
  "post-merge-comment",
  "review-reply",
  "direct-mention",
  "my-pr-activity",
  "new-commits",
  "team-review",
  "new-comments",
  "team-mention",
]);

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
  await exec("gh", ["api", "--method", "DELETE", `notifications/threads/${threadId}`], {
    encoding: "utf8",
    timeout: 45_000,
  });
}

let detectedUser;
async function getDetectedUser() {
  detectedUser ??= ghJson(["api", "user"]).then((user) => user.login);
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
  };
}

async function readSettings() {
  try {
    return normalizeSettings(JSON.parse(await readFile(settingsPath, "utf8")));
  } catch (error) {
    if (error.code === "ENOENT") return normalizeSettings();
    throw error;
  }
}

async function saveSettings(value) {
  const settings = normalizeSettings(value);
  const temporaryPath = `${settingsPath}.tmp`;
  await mkdir(dirname(settingsPath), { recursive: true });
  await writeFile(temporaryPath, `${JSON.stringify(settings, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporaryPath, settingsPath);
  return settings;
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

async function readQueueState() {
  try {
    return normalizeQueueState(JSON.parse(await readFile(queuePath, "utf8")));
  } catch (error) {
    if (error.code === "ENOENT") return normalizeQueueState();
    throw error;
  }
}

async function writeQueueState(state) {
  const temporaryPath = `${queuePath}.${process.pid}.tmp`;
  await mkdir(dirname(queuePath), { recursive: true });
  await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporaryPath, queuePath);
}

export function queueVersion(item) {
  return [item.updatedAt, item.notificationUpdatedAt].filter(Boolean).sort().at(-1) ?? "";
}

function queueItemFromRecord(id, record) {
  const stored = record.item ?? {};
  const value = typeof stored.url === "string" ? stored.url : record.url;
  try {
    const url = new URL(value);
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
    additions: item.additions,
    deletions: item.deletions,
    changedFiles: item.changedFiles,
    headSha: item.headSha,
  };
}

export function trackedQueueItems(state) {
  return Object.entries(state.items)
    .map(([id, record]) => queueItemFromRecord(id, record))
    .filter(Boolean);
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

async function withQueueLock(callback) {
  await mkdir(dirname(queueLockPath), { recursive: true });
  for (let attempt = 0; ; attempt++) {
    try {
      await mkdir(queueLockPath);
      break;
    } catch (error) {
      if (error.code !== "EEXIST" || attempt === 100) throw error;
      const lock = await stat(queueLockPath).catch(() => null);
      if (lock && Date.now() - lock.mtimeMs > 2 * 60_000) {
        await rm(queueLockPath, { recursive: true, force: true });
      } else {
        await delay(100);
      }
    }
  }
  try {
    return await callback();
  } finally {
    await rm(queueLockPath, { recursive: true, force: true });
  }
}

let queueMutation = Promise.resolve();
function mutateQueueState(callback) {
  const operation = queueMutation.then(() =>
    withQueueLock(async () => {
      const state = await readQueueState();
      const result = await callback(state);
      await writeQueueState(state);
      return result;
    }),
  );
  queueMutation = operation.catch(() => {});
  return operation;
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

function lifecycleFor(item) {
  if (item.state === "MERGED") return "merged";
  if (item.draft) return "draft";
  if (item.authored) return "mine";
  if (item.latestReviewState === "APPROVED") return "approved";
  if (item.latestReviewState || item.reviewed) return "reviewed";
  if (item.state === "OPEN" || item.signals.some((signal) => signal.kind !== "team-covered")) {
    return "new";
  }
  return "other";
}

export function rankItems(items) {
  return [...items.values()]
    .map((item) => {
      const lifecycle = lifecycleFor(item);
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
  return {
    username,
    fetchedAt: state.sync?.lastSyncedAt || null,
    repositories: trackedRepositories,
    items: applyQueueState(items, state),
    notifications: [],
    notificationSummary: { total: 0, pullRequests: 0, nonPullRequests: 0 },
    warnings: [],
  };
}

export function findReviewReply(comments, username) {
  const normalizedUser = username.toLowerCase();
  const threads = new Map();

  for (const comment of comments) {
    const rootId = comment.in_reply_to_id ?? comment.id;
    const thread = threads.get(rootId) ?? [];
    thread.push(comment);
    threads.set(rootId, thread);
  }

  let newestReply = null;
  for (const thread of threads.values()) {
    thread.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    const latest = thread.at(-1);
    const latestMine = [...thread]
      .reverse()
      .find((comment) => comment.user?.login?.toLowerCase() === normalizedUser);

    if (
      latestMine &&
      latest?.user?.login?.toLowerCase() !== normalizedUser &&
      new Date(latest.created_at) > new Date(latestMine.created_at) &&
      (!newestReply || new Date(latest.created_at) > new Date(newestReply.created_at))
    ) {
      newestReply = latest;
    }
  }

  return newestReply;
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
    title: thread.subject?.title ?? "GitHub notification",
    url: notificationWebUrl(thread),
    repository: thread.repository?.full_name ?? "GitHub",
    subjectType: thread.subject?.type ?? "Notification",
    reason: thread.reason,
    updatedAt: thread.updated_at,
    notificationThreadId: validNotificationThreadId(thread.id),
  };
}

async function getNotifications() {
  const pages = await ghJson([
    "api",
    "--paginate",
    "--slurp",
    "notifications?all=true&per_page=50",
  ]);
  const threads = Array.isArray(pages[0]) ? pages.flat() : pages;
  const pullRequests = threads
    .map((thread) => ({ thread, pr: prFromNotification(thread) }))
    .filter(({ pr }) => pr);
  return {
    total: threads.length,
    pullRequests,
    other: threads
      .filter((thread) => thread.unread)
      .map(otherNotificationFromThread)
      .filter(Boolean),
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

async function refreshNotificationItems(items, pullRequestNotifications, touched) {
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
        return { item, activity: await getPrActivity(item) };
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
    const id = prKey(pr);
    const notificationAt = notificationTimes.get(id);
    if (notificationAt) {
      items.get(id).notificationUpdatedAt = new Date(notificationAt).toISOString();
    }
    touched.add(id);
  }
  return warnings;
}

export async function syncNotifications(now = new Date()) {
  const startedAt = now.toISOString();
  const initialState = await readQueueState();
  const notifications = await getNotifications();
  const items = new Map(trackedQueueItems(initialState).map((item) => [item.id, item]));
  const initialIds = new Set(items.keys());
  const touched = new Set();
  const warnings = await refreshNotificationItems(items, notifications.pullRequests, touched);
  const entries = [...touched].map((id) => items.get(id)).filter(Boolean);

  const summary = await mutateQueueState((state) => {
    rememberQueueItems(state, entries, startedAt);
    applyAutomaticDone(state, trackedQueueItems(state), now.getTime());
    return {
      fetched: entries.length,
      added: entries.filter((item) => !initialIds.has(item.id)).length,
      tracked: Object.keys(state.items).length,
      warnings: [...new Set(warnings)],
    };
  });
  const inbox = inboxFromQueue(await readQueueState());
  const automaticAnalysis = await automaticallyQueueNewAnalyses(inbox.items);
  return {
    ...summary,
    autoQueued: automaticAnalysis.runs.length,
    warnings: [...new Set([...summary.warnings, ...automaticAnalysis.warnings])],
  };
}

export async function syncQueue(now = new Date()) {
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
    getNotifications(),
    ...repositoryTasks,
  ]);

  const items = new Map(trackedQueueItems(initialState).map((item) => [item.id, item]));
  const initialIds = new Set(items.keys());
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
    warnings.push(...(await refreshNotificationItems(items, pullRequestNotifications, touched)));
  } else {
    warnings.push("GitHub notifications could not be synchronized.");
  }

  const entries = [...touched].map((id) => items.get(id)).filter(Boolean);
  const summary = await mutateQueueState((state) => {
    rememberQueueItems(state, entries, startedAt);
    applyAutomaticDone(
      state,
      trackedQueueItems(state).filter((item) => trackedRepositories.includes(item.repository)),
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
  const inbox = await attachQueueState(
    await collectInbox({
      username,
      teammates: saved.people,
      teams: saved.teams,
      queueState,
    }),
  );
  const automaticAnalysis = await automaticallyQueueNewAnalyses(inbox.items);
  return {
    ...summary,
    active: inbox.items.filter((item) => !item.done).length,
    autoQueued: automaticAnalysis.runs.length,
    warnings: [...new Set([...summary.warnings, ...inbox.warnings, ...automaticAnalysis.warnings])],
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
      getNotifications(),
      searchPrs(["--author", username], repositories),
      searchPrs(["--reviewed-by", username], repositories),
      ...tasks.map(async (task) => ({
        task,
        prs: await searchPrs(task.args, repositories),
      })),
    ]);

  if (notificationsResult.status === "fulfilled") {
    const result = notificationsResult.value;
    notifications = result.other;
    pullRequestNotifications = result.pullRequests;
    seedNotificationPullRequests(items, pullRequestNotifications, repositories);
    notificationSummary = {
      total: result.total,
      pullRequests: result.pullRequests.length,
      nonPullRequests: result.other.length,
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

function secureHeaders(contentType) {
  return {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
    "Content-Security-Policy":
      "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  };
}

function sendJson(response, status, value) {
  response.writeHead(status, secureHeaders("application/json; charset=utf-8"));
  response.end(JSON.stringify(value));
}

async function cockpitJson(pathname, options) {
  const response = await fetch(`${cockpitOrigin}${pathname}`, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body.error || `Review service returned ${response.status}.`);
  }
  return body;
}

function normalizeAnalysisCandidate(value) {
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
  };
}

function changedLineCount(value) {
  return Number.isInteger(value.additions) && Number.isInteger(value.deletions)
    ? value.additions + value.deletions
    : Number.MAX_SAFE_INTEGER;
}

export function sortPullRequestsBySize(values) {
  return [...values].sort(
    (left, right) =>
      changedLineCount(left) - changedLineCount(right) ||
      (left.changedFiles ?? Number.MAX_SAFE_INTEGER) -
        (right.changedFiles ?? Number.MAX_SAFE_INTEGER) ||
      left.url.localeCompare(right.url),
  );
}

function alreadyAnalyzed(dashboard, candidate) {
  const pullRequest = (dashboard.prs ?? dashboard.pullRequests ?? []).find(
    (item) => item.url === candidate.url,
  );
  return pullRequest?.runs?.some(
    (run) =>
      ["queued", "running"].includes(run.status) ||
      (run.status === "succeeded" && (!candidate.headSha || run.headSha === candidate.headSha)),
  );
}

async function enqueueMissingAnalyses(values) {
  const candidates = sortPullRequestsBySize(values.slice(0, 100).map(normalizeAnalysisCandidate));
  const dashboard = await cockpitJson("/api/dashboard");
  const runs = [];
  for (const candidate of candidates) {
    if (alreadyAnalyzed(dashboard, candidate)) continue;
    const result = await cockpitJson("/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prUrl: candidate.url, refresh: true, title: candidate.title }),
    });
    runs.push(result.run);
  }
  return runs;
}

async function automaticallyQueueNewAnalyses(items) {
  try {
    return {
      runs: await enqueueMissingAnalyses(
        items.filter((item) => item.lifecycle === "new" && !item.done),
      ),
      warnings: [],
    };
  } catch {
    return {
      runs: [],
      warnings: [
        "New PRs could not be queued for AI analysis; the next background sync will retry.",
      ],
    };
  }
}

async function readRequestJson(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (Buffer.byteLength(body) > 64 * 1024) throw new Error("Request too large");
  }
  return JSON.parse(body || "{}");
}

async function handleApiRequest(request, response) {
  const url = new URL(request.url, `http://${request.headers.host ?? host}`);

  if (url.pathname === "/api/analyses" && request.method === "GET") {
    try {
      sendJson(response, 200, await cockpitJson("/api/dashboard"));
    } catch (error) {
      sendJson(response, 502, { error: error.message });
    }
    return true;
  }

  if (url.pathname === "/api/analyses" && request.method === "POST") {
    try {
      const candidate = normalizeAnalysisCandidate(await readRequestJson(request));
      const result = await cockpitJson("/api/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prUrl: candidate.url, refresh: true, title: candidate.title }),
      });
      sendJson(response, 202, result);
    } catch (error) {
      sendJson(response, 400, { error: error.message });
    }
    return true;
  }

  if (url.pathname === "/api/analyses/queue" && request.method === "POST") {
    try {
      const body = await readRequestJson(request);
      const runs = await enqueueMissingAnalyses(
        Array.isArray(body.pullRequests) ? body.pullRequests : [],
      );
      sendJson(response, 202, { runs });
    } catch (error) {
      sendJson(response, 400, { error: error.message });
    }
    return true;
  }

  if (url.pathname === "/api/settings" && request.method === "GET") {
    response.writeHead(200, secureHeaders("application/json; charset=utf-8"));
    response.end(JSON.stringify(await readSettings()));
    return true;
  }

  if (url.pathname === "/api/settings" && request.method === "PUT") {
    try {
      const settings = await saveSettings(await readRequestJson(request));
      response.writeHead(200, secureHeaders("application/json; charset=utf-8"));
      response.end(JSON.stringify(settings));
    } catch {
      response.writeHead(400, secureHeaders("application/json; charset=utf-8"));
      response.end(JSON.stringify({ error: "Settings could not be saved." }));
    }
    return true;
  }

  if (url.pathname === "/api/inbox/items" && request.method === "PUT") {
    try {
      const body = await readRequestJson(request);
      const mutations = ["done", "read"].filter((field) => typeof body[field] === "boolean");
      const ids = Array.isArray(body.ids) ? [...new Set(body.ids)] : null;
      const bulkDone = Boolean(
        ids?.length &&
          ids.length === body.ids.length &&
          ids.length <= 100 &&
          ids.every((id) => typeof id === "string" && id && id.length <= 200) &&
          body.id === undefined &&
          body.done === true &&
          mutations.length === 1,
      );
      if (
        !bulkDone &&
        (typeof body.id !== "string" || !body.id || body.id.length > 200 || mutations.length !== 1)
      ) {
        throw new Error("One tracked queue item update is required.");
      }
      const result = await mutateQueueState((state) =>
        bulkDone
          ? setQueueItemsDone(state, ids)
          : mutations[0] === "done"
            ? setQueueItemDone(state, body.id, body.done)
            : setQueueItemRead(state, body.id, body.read),
      );
      if (!result) throw new Error("That queue item is not tracked.");
      if (body.done) {
        const state = await readQueueState();
        const doneIds = ids ?? [body.id];
        const threadIds = new Set(
          doneIds.flatMap((id) => {
            const stored = state.items[id]?.item?.notificationThreadId;
            const threadId =
              /^notification:(\d+)$/.exec(id)?.[1] ?? validNotificationThreadId(stored);
            return threadId ? [threadId] : [];
          }),
        );
        try {
          if (threadIds.size < doneIds.length) {
            for (const { pr } of (await getNotifications()).pullRequests) {
              if (doneIds.includes(prKey(pr)) && pr.notificationThreadId) {
                threadIds.add(pr.notificationThreadId);
              }
            }
          }
          const outcomes = await Promise.allSettled([...threadIds].map(markGitHubNotificationDone));
          if (outcomes.some(({ status }) => status === "rejected")) {
            throw new Error("GitHub notification update failed");
          }
        } catch {
          result.warning = "Saved locally, but GitHub could not mark the notification done.";
        }
      }
      sendJson(response, 200, result);
    } catch (error) {
      sendJson(response, 400, { error: error.message });
    }
    return true;
  }

  if (url.pathname === "/api/inbox/sync" && request.method === "POST") {
    try {
      sendJson(response, 200, await syncQueue());
    } catch (error) {
      sendJson(response, 502, {
        error:
          error?.code === "ENOENT"
            ? "GitHub CLI is not installed."
            : "GitHub could not be reached. Run `gh auth status` and try again.",
      });
    }
    return true;
  }

  if (url.pathname === "/api/inbox/notifications/sync" && request.method === "POST") {
    try {
      sendJson(response, 200, await syncNotifications());
    } catch (error) {
      sendJson(response, 502, {
        error:
          error?.code === "ENOENT"
            ? "GitHub CLI is not installed."
            : "GitHub notifications could not be refreshed.",
      });
    }
    return true;
  }

  if (request.method === "GET" && url.pathname === "/api/inbox") {
    try {
      const queueState = await readQueueState();
      const saved = await readSettings();
      const inbox = inboxFromQueue(queueState, saved.username || queueState.sync.username);
      response.writeHead(200, secureHeaders("application/json; charset=utf-8"));
      response.end(JSON.stringify(inbox));
    } catch {
      sendJson(response, 500, { error: "The local queue could not be loaded." });
    }
    return true;
  }

  return false;
}

export function reviewArtifactPath(pathname) {
  if (!/^\/reviews\/[^/]/.test(pathname)) return null;
  let relativePath;
  try {
    relativePath = decodeURIComponent(pathname.slice("/reviews/".length));
  } catch {
    return null;
  }
  const filePath = resolve(reviewsDir, relativePath);
  return filePath.startsWith(`${reviewsDir}${sep}`) ? filePath : null;
}

async function serveReviewArtifact(request, response) {
  const pathname = new URL(request.url, cockpitOrigin).pathname;
  let filePath = reviewArtifactPath(pathname);
  if (!filePath) return false;
  if (!["GET", "HEAD"].includes(request.method)) {
    response.writeHead(405, { Allow: "GET, HEAD" });
    response.end();
    return true;
  }

  try {
    if ((await stat(filePath)).isDirectory()) filePath = join(filePath, "index.html");
    const body = await readFile(filePath);
    const contentType =
      {
        ".css": "text/css; charset=utf-8",
        ".html": "text/html; charset=utf-8",
        ".js": "text/javascript; charset=utf-8",
        ".json": "application/json; charset=utf-8",
        ".svg": "image/svg+xml",
      }[extname(filePath)] ?? "application/octet-stream";
    response.writeHead(200, { "Cache-Control": "no-store", "Content-Type": contentType });
    response.end(request.method === "HEAD" ? undefined : body);
  } catch (error) {
    response.writeHead(error.code === "ENOENT" ? 404 : 500, {
      "Content-Type": "text/plain; charset=utf-8",
    });
    response.end(error.code === "ENOENT" ? "Review not found" : "Review could not be loaded");
  }
  return true;
}

export async function startServer() {
  const { createServer: createViteServer } = await import("vite");
  const { createDashboardVitePlugin } = await import("./dashboard-vite-plugin.js");
  const server = createHttpServer();
  const dashboardPlugin = createDashboardVitePlugin({ projectRoot, reviewsDir });
  const appVite = await createViteServer({
    appType: "spa",
    configFile: join(clientRoot, "vite.config.js"),
    plugins: [dashboardPlugin],
    root: clientRoot,
    server: { middlewareMode: true, ws: { server } },
  });

  server.on("request", (request, response) => {
    handleApiRequest(request, response)
      .then(async (handled) => {
        if (handled) return;
        if (await serveReviewArtifact(request, response)) return;
        appVite.middlewares(request, response, () => {
          response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
          response.end("Not found");
        });
      })
      .catch(() => {
        if (!response.headersSent) {
          response.writeHead(500, secureHeaders("text/plain; charset=utf-8"));
        }
        response.end("Unexpected server error");
      });
  });
  server.once("close", () => {
    dashboardPlugin.getDashboardService()?.close();
    appVite.close();
  });
  return server.listen(port, host, () => {
    console.log(`PR Review Cockpit: ${cockpitOrigin}/`);
    console.log(`Analysis queue: ${cockpitOrigin}/analysis`);
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const command = process.argv[2] === "--sync" ? syncQueue() : startServer();
  command
    .then((result) => {
      if (process.argv[2] === "--sync") {
        console.log(JSON.stringify(result));
      }
    })
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
