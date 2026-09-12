import {
  normalizeSettingsAnalysisChoice,
  settingsAnalysisRunOptions,
} from "../../shared/analysis-models.js";
import { normalizeReviewUiSettings } from "../../shared/review-ui-settings.js";
import { databasePath, queuePath, settingsPath } from "../runtime-config.js";
import {
  getGitHubAuthoredPullRequests,
  getGitHubViewerLogin,
  subscribeToGitHubIssue,
} from "./github-notifications.js";
import {
  activityCandidates,
  activityRefreshTargets,
  applyInboxActivity,
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
import { addPinnedInboxPullRequest } from "./inbox-service/pin-pull-request.js";
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
  pullRequestRefreshIds,
  shouldRefreshInboxActivity,
} from "./inbox-service/pull-request-change.js";
import {
  activeInboxEntries,
  applyAuthoredReadState,
  applyInboxMembership,
  applyQueueState,
  authoredOpenIdsFromItems,
  inboxIdsFromNotifications,
  normalizeQueueState,
  notificationUpdatedAtByIdFromNotifications,
  pinQueueItem,
  queueVersion,
  remapNotificationQueueIds,
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
  activityRefreshTargets,
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
  notificationUpdatedAtByIdFromNotifications,
  otherNotificationFromThread,
  pinQueueItem,
  prFromNotification,
  prKey,
  queueVersion,
  rankItems,
  refreshNotificationItems,
  remapNotificationQueueIds,
  rememberQueueItems,
  requestHostRejection,
  reviewRequestSignals,
  seedAuthoredPullRequests,
  seedNotificationPullRequests,
  setQueueItemDone,
  setQueueItemRead,
  setQueueItemsDone,
  shouldRefreshInboxActivity,
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

export function applySettingsPatch(current, value = {}, { usernameFromGitHub } = {}) {
  const next = { ...current, ...value, username: current.username };
  if (typeof usernameFromGitHub === "string") {
    next.username = usernameFromGitHub;
  }
  return normalizeSettings(next);
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

async function saveSettings(value, options) {
  const settings = applySettingsPatch(await readSettings(), value, options);
  return (await getInboxStore()).saveSettings(settings);
}

let detectedUser;
async function getDetectedUser() {
  detectedUser ??= getGitHubViewerLogin().catch((error) => {
    detectedUser = undefined;
    throw error;
  });
  return detectedUser;
}

export async function resolveGitHubUsername({
  detectUser = getDetectedUser,
  read = readSettings,
  refresh = false,
  save = saveSettings,
} = {}) {
  const saved = await read();
  if (!refresh && saved.username) return saved.username;
  if (refresh) detectedUser = undefined;
  const login = await detectUser();
  if (typeof login !== "string" || !usernamePattern.test(login.trim())) {
    throw new Error("GitHub user login was unavailable.");
  }
  const username = login.trim();
  if (username !== saved.username) {
    await save({}, { usernameFromGitHub: username });
  }
  return username;
}

async function readQueueState(options) {
  return normalizeQueueState((await getInboxStore()).readQueueState(options));
}

async function mutateQueueState(callback, options) {
  return (await getInboxStore()).mutateQueueState(callback, options);
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
  if (notifications?.other) {
    remapNotificationQueueIds(state, notifications.other);
  }
  rememberQueueItems(state, entries, startedAt);
  if (inboxIds || authoredOpenIds) {
    applyInboxMembership(state, inboxIds, authoredOpenIds ?? [], {
      notificationUpdatedAtById: notifications
        ? notificationUpdatedAtByIdFromNotifications(
            notifications.pullRequests ?? [],
            notifications.other ?? [],
          )
        : null,
    });
  }
  if (authoredOpenIds) {
    applyAuthoredReadState(state, authoredOpenIds, authoredNotificationIds);
  }
  state.sync.repositories = inboxRepositories(activeInboxEntries(state));
  if (notifications) {
    state.sync.notificationsSyncedAt = startedAt;
    state.sync.notificationPollIntervalSeconds = notifications.pollIntervalSeconds;
    state.sync.lastSyncedAt = startedAt;
    if (typeof notifications.lastModified === "string" && notifications.lastModified) {
      state.sync.notificationLastModified = notifications.lastModified;
    }
  }
  state.sync.username = username;
  return {
    fetched: entries.length,
    added: entries.filter((item) => !initialIds.has(item.id)).length,
    tracked: Object.keys(state.items).length,
    done: Object.values(state.items).filter((record) => record.doneVersion).length,
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
  const username = await resolveGitHubUsername();
  const warnings = [];
  let notifications = null;
  try {
    notifications = await getNotifications();
  } catch (error) {
    const detail = error instanceof Error ? error.message : "";
    warnings.push(
      detail
        ? `GitHub notifications could not be synchronized. ${detail}`
        : "GitHub notifications could not be synchronized.",
    );
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
            (item) =>
              (inboxIds?.has(item.id) ?? false) ||
              authoredOpenIds.has(item.id) ||
              initialState.items[item.id]?.pinned,
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

  warnings.push(
    ...(await refreshNotificationItems(items, lifecyclePrNotifications, touched, {
      authoredOpenIds,
      authoredPullRequests: authoredPullRequests ?? [],
      inboxIds,
      queueRecords: initialState.items,
      username,
      teammates: saved.people,
      teams: saved.teams,
    })),
  );

  const refreshIds = pullRequestRefreshIds({
    authoredOpenIds,
    authoredPullRequests: authoredPullRequests ?? [],
    inboxIds,
    items,
    pullRequestNotifications: lifecyclePrNotifications,
    queueRecords: initialState.items,
  });

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
  const store = await getInboxStore();
  const [conversationCache, automaticAnalysis, retention] = await Promise.all([
    cacheReviewConversations(entries, { refreshIds }),
    dashboardService && saved.autoQueue
      ? automaticallyQueueNewAnalyses(
          inbox.items,
          dashboardService,
          settingsAnalysisRunOptions(saved),
        )
      : { runs: [], warnings: [] },
    dashboardService
      ? dashboardService.deleteExpiredAnalysis({
          deleteDraft: (slug) => store.deleteReviewDraft(slug),
          now,
          queueItems: applyQueueState(trackedQueueItems(queueState), queueState),
        })
      : { deletedSlugs: [] },
  ]);
  return {
    ...summary,
    active: inbox.items.filter((item) => !item.done).length,
    autoQueued: automaticAnalysis.runs.length,
    deletedAnalysisSlugs: retention.deletedSlugs.length,
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
  addInboxPullRequest: (url, options = {}) =>
    addPinnedInboxPullRequest(url, {
      mutateQueueState,
      subscribeToIssue: subscribeToGitHubIssue,
      ...options,
    }),
  getInboxStore,
  inboxFromQueue,
  mutateQueueState,
  readQueueState,
  readSettings,
  resolveGitHubUsername,
  saveSettings,
  setQueueItemDone,
  setQueueItemRead,
  setQueueItemsDone,
});
