import {
  normalizeSettingsAnalysisChoice,
  settingsAnalysisRunOptions,
} from "../../shared/analysis-models.js";
import { normalizeReviewUiSettings } from "../../shared/review-ui-settings.js";
import { databasePath, queuePath, settingsPath } from "../runtime-config.js";
import {
  getGitHubAuthoredPullRequests,
  markGitHubNotificationThreadDone,
} from "./github-notifications.js";
import {
  activityCandidates,
  applyInboxActivity,
  ghJson,
  refreshNotificationItems,
  reviewRequestSignals,
  summarizeActivity,
} from "./inbox-service/activity.js";
import {
  automaticallyQueueNewAnalyses,
  sortPullRequestsBySize,
} from "./inbox-service/analysis-queue.js";
import { createInboxApi } from "./inbox-service/api.js";
import { cacheReviewConversations as cacheQueuedReviewConversations } from "./inbox-service/conversation-cache.js";
import {
  apiMutationRejection,
  requestHostRejection,
  sendJson,
} from "./inbox-service/http-guards.js";
import {
  prKey,
  teamPattern,
  usernamePattern,
  validNotificationThreadId,
} from "./inbox-service/identity.js";
import {
  excludeAuthoredPullRequestNotifications,
  getNotifications,
  otherNotificationFromThread,
  prFromNotification,
  seedAuthoredPullRequests,
  seedNotificationPullRequests,
} from "./inbox-service/notification-map.js";
import {
  addReviewRequests,
  addSignal,
  addSource,
  inboxFromQueue,
  inboxRepositories,
  lifecycleScores,
  rankItems,
  weights,
} from "./inbox-service/pr-items.js";
import {
  activeInboxEntries,
  applyAuthoredReadState,
  applyInboxMembership,
  applyQueueState,
  authoredOpenIdsFromItems,
  inboxIdsFromNotifications,
  normalizeQueueState,
  queueVersion,
  rememberQueueItems,
  setQueueItemDone,
  setQueueItemRead,
  setQueueItemsDone,
  stampAuthoredNotificationTimes,
  trackedQueueItems,
} from "./inbox-service/queue-state.js";
import { createInboxStore } from "./inbox-store.js";

export { sortPullRequestsBySize };

export const PARTICIPATING_NOTIFICATION_REASONS = Object.freeze([
  "review_requested",
  "mention",
  "assign",
  "author",
  "comment",
  "state_change",
  "team_mention",
]);

export {
  activityCandidates,
  addReviewRequests,
  addSignal,
  addSource,
  apiMutationRejection,
  applyAuthoredReadState,
  applyInboxActivity,
  applyInboxMembership,
  applyQueueState,
  excludeAuthoredPullRequestNotifications,
  inboxFromQueue,
  inboxIdsFromNotifications,
  inboxRepositories,
  lifecycleScores,
  otherNotificationFromThread,
  prFromNotification,
  prKey,
  queueVersion,
  rankItems,
  refreshNotificationItems,
  rememberQueueItems,
  requestHostRejection,
  reviewRequestSignals,
  seedAuthoredPullRequests,
  seedNotificationPullRequests,
  setQueueItemDone,
  setQueueItemRead,
  setQueueItemsDone,
  stampAuthoredNotificationTimes,
  summarizeActivity,
  trackedQueueItems,
  validNotificationThreadId,
  weights,
};

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
    ...normalizeReviewUiSettings(value),
    ...normalizeSettingsAnalysisChoice(value),
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

async function readQueueState(options) {
  return normalizeQueueState((await getInboxStore()).readQueueState(options));
}

async function mutateQueueState(callback, options) {
  return (await getInboxStore()).mutateQueueState(callback, options);
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

function writeInboxSnapshot(
  state,
  {
    entries,
    inboxIds,
    authoredOpenIds,
    authoredNotificationIds = null,
    startedAt,
    username,
    notifications,
    initialIds,
    warnings,
  },
) {
  rememberQueueItems(state, entries, startedAt);
  if (inboxIds || authoredOpenIds) {
    applyInboxMembership(state, inboxIds, authoredOpenIds ?? []);
  }
  if (authoredOpenIds) {
    applyAuthoredReadState(state, authoredOpenIds, authoredNotificationIds);
  }
  state.sync.repositories = inboxRepositories(activeInboxEntries(state));
  if (notifications) {
    state.sync.notificationsSyncedAt = startedAt;
    state.sync.notificationPollIntervalSeconds = notifications.pollIntervalSeconds;
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
}

export async function cacheReviewConversations(items, options = {}) {
  return cacheQueuedReviewConversations(items, {
    ...options,
    store: options.store ?? (await getInboxStore()),
  });
}

export async function syncQueue(now = new Date(), { dashboardService } = {}) {
  const startedAt = now.toISOString();
  const [initialState, saved] = await Promise.all([readQueueState(), readSettings()]);
  const username = saved.username || initialState.sync.username || (await getDetectedUser());
  const warnings = [];
  let notifications = null;
  try {
    notifications = await getNotifications();
  } catch {
    warnings.push("GitHub notifications could not be synchronized.");
  }

  let authoredPullRequests = null;
  try {
    authoredPullRequests = await getGitHubAuthoredPullRequests();
  } catch {
    warnings.push("Your pull requests could not be synchronized.");
  }

  const items = new Map(trackedQueueItems(initialState).map((item) => [item.id, item]));
  const initialIds = new Set(Object.keys(initialState.items));
  const touched = new Set();
  const pullRequestNotifications = notifications?.pullRequests ?? [];
  const notificationItems = notifications?.other ?? [];
  const authoredOpenIds = authoredPullRequests
    ? new Set(authoredPullRequests.map((pr) => prKey(pr)))
    : authoredOpenIdsFromItems(items);
  const lifecyclePrNotifications = excludeAuthoredPullRequestNotifications(
    pullRequestNotifications,
    authoredOpenIds,
  );
  const inboxIds = notifications
    ? inboxIdsFromNotifications(lifecyclePrNotifications, notificationItems)
    : null;

  if (authoredPullRequests) seedAuthoredPullRequests(items, authoredPullRequests);
  const authoredNotificationIds = notifications
    ? stampAuthoredNotificationTimes(items, pullRequestNotifications, authoredOpenIds)
    : null;

  const shouldWriteMembership = Boolean(inboxIds || authoredPullRequests);
  if (shouldWriteMembership) {
    seedNotificationPullRequests(items, lifecyclePrNotifications);
    await mutateQueueState((state) =>
      writeInboxSnapshot(state, {
        entries: [
          ...[...items.values()].filter(
            (item) => (inboxIds?.has(item.id) ?? false) || authoredOpenIds.has(item.id),
          ),
          ...notificationItems,
        ],
        authoredOpenIds,
        authoredNotificationIds,
        inboxIds,
        startedAt,
        username,
        notifications,
        initialIds,
        warnings,
      }),
    );
  }

  if (notifications) {
    warnings.push(
      ...(await refreshNotificationItems(items, lifecyclePrNotifications, touched, {
        authoredOpenIds: authoredPullRequests ? authoredOpenIds : null,
        username,
        teammates: saved.people,
        teams: saved.teams,
      })),
    );
  }

  const entries = [
    ...[...touched].map((id) => items.get(id)).filter(Boolean),
    ...(authoredPullRequests ?? []).map((pr) => items.get(prKey(pr))).filter(Boolean),
    ...notificationItems,
  ];
  const summary = await mutateQueueState((state) =>
    writeInboxSnapshot(state, {
      entries,
      authoredOpenIds,
      authoredNotificationIds,
      inboxIds,
      startedAt,
      username,
      notifications,
      initialIds,
      warnings,
    }),
  );

  const queueState = await readQueueState();
  const inbox = inboxFromQueue(queueState);
  const [conversationCache, automaticAnalysis] = await Promise.all([
    cacheReviewConversations(entries),
    dashboardService && saved.autoQueue
      ? automaticallyQueueNewAnalyses(
          inbox.items,
          dashboardService,
          settingsAnalysisRunOptions(saved),
        )
      : { runs: [], warnings: [] },
  ]);
  return {
    ...summary,
    active: inbox.items.filter((item) => !item.done).length,
    autoQueued: automaticAnalysis.runs.length,
    pollIntervalSeconds:
      notifications?.pollIntervalSeconds ?? initialState.sync.notificationPollIntervalSeconds,
    warnings: [
      ...new Set([
        ...summary.warnings,
        ...conversationCache.warnings,
        ...automaticAnalysis.warnings,
      ]),
    ],
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
