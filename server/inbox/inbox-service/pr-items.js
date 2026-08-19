import {
  LIFECYCLE_SCORES,
  lifecycleForQueueItem,
  SIGNAL_LABELS,
  SIGNAL_WEIGHTS,
} from "../../../shared/queue-policy.js";
import {
  prKey,
  repositoryName,
  repositoryNamePattern,
  validNotificationThreadId,
} from "./identity.js";
import { applyQueueState, trackedQueueItems, trackedQueueNotifications } from "./queue-state.js";

export const weights = SIGNAL_WEIGHTS;
export const lifecycleScores = LIFECYCLE_SCORES;

const lifecycleLabels = Object.freeze({
  reviewed: "Reviewed",
  new: "Unreviewed",
  approved: "Approved",
  merged: "Merged",
  closed: "Closed",
  draft: "Draft",
  mine: "My PR",
  other: "Other PR notification",
});

const signalLabels = SIGNAL_LABELS;

export function normalizePr(pr) {
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

export function mergePr(item, pr) {
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

export function inboxRepositories(items) {
  return [
    ...new Set((Array.isArray(items) ? items : []).map((item) => item.repository).filter(Boolean)),
  ]
    .filter((repository) => repositoryNamePattern.test(repository))
    .sort((left, right) => left.localeCompare(right))
    .slice(0, 200);
}

export function inboxFromQueue(state, username = state.sync?.username ?? "") {
  const items = rankItems(new Map(trackedQueueItems(state).map((item) => [item.id, item])));
  const notifications = trackedQueueNotifications(state);
  const rankedItems = applyQueueState(items, state);
  const rankedNotifications = applyQueueState(notifications, state);
  const activeItems = rankedItems.filter((item) => !item.done);
  const activeNotifications = rankedNotifications.filter((item) => !item.done);
  const repositorySource =
    activeItems.length > 0 || activeNotifications.length > 0
      ? [...activeItems, ...activeNotifications]
      : [...rankedItems, ...rankedNotifications];
  return {
    username,
    fetchedAt: state.sync?.lastSyncedAt || null,
    repositories: inboxRepositories(repositorySource),
    items: rankedItems,
    notifications: rankedNotifications,
    notificationSummary: {
      total: notifications.length,
      pullRequests: 0,
      nonPullRequests: notifications.length,
    },
    warnings: [],
  };
}
