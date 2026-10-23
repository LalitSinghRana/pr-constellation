import { lifecycleForQueueItem } from "../../shared/queue-policy.js";
import { applyInboxActivity, getPrActivity } from "../inbox/inbox-service/activity.js";
import { prKey } from "../inbox/inbox-service/identity.js";
import { rememberQueueItems, setQueueItemDone } from "../inbox/inbox-service/queue-state.js";
import { getInboxStore, normalizeSettings, resolveGitHubUsername } from "../inbox/inbox-service.js";
import { fetchPullRequestConversation } from "./github-review-client.js";
import { loadReviewContext } from "./review-context.js";

export const SETTLE_INBOX_DELAY_MS = 8_000;

const pendingTimers = new Set();

export function clearSettleInboxTimers() {
  for (const timer of pendingTimers) {
    clearTimeout(timer);
  }
  pendingTimers.clear();
}

export function scheduleSettleInboxAfterReview(
  slug,
  {
    attempt = 1,
    delayMs = SETTLE_INBOX_DELAY_MS,
    eventHub,
    setTimer = setTimeout,
    ...options
  } = {},
) {
  if (typeof slug !== "string" || !slug) return;
  const timer = setTimer(() => {
    pendingTimers.delete(timer);
    void runSettleInboxAfterReview(slug, {
      attempt,
      delayMs,
      eventHub,
      setTimer,
      settle: options.settle,
      ...options,
    }).catch((error) => {
      console.error("Inbox settle after review failed:", error);
    });
  }, delayMs);
  pendingTimers.add(timer);
  timer.unref?.();
}

async function runSettleInboxAfterReview(
  slug,
  {
    attempt = 1,
    delayMs = SETTLE_INBOX_DELAY_MS,
    eventHub,
    setTimer = setTimeout,
    settle = settleInboxAfterReview,
    ...options
  } = {},
) {
  const result = await settle(slug, options);
  if (result.shouldRetry && attempt < 2) {
    const timer = setTimer(() => {
      pendingTimers.delete(timer);
      void runSettleInboxAfterReview(slug, {
        attempt: 2,
        delayMs,
        eventHub,
        setTimer,
        settle,
        ...options,
      }).catch((error) => {
        console.error("Inbox settle after review failed:", error);
      });
    }, delayMs);
    pendingTimers.add(timer);
    timer.unref?.();
    return;
  }
  if (eventHub) {
    if (result.id) {
      eventHub.publish("inbox", { ids: [result.id] });
    }
    eventHub.publish("review", { slug });
  }
}

function isSettleLifecycle(lifecycle) {
  return lifecycle === "reviewed" || lifecycle === "approved";
}

async function defaultReadSettings() {
  return normalizeSettings((await getInboxStore()).readSettings());
}

async function defaultMutateQueueState(callback, options) {
  return (await getInboxStore()).mutateQueueState(callback, options);
}

async function defaultSaveReviewConversation(coordinates) {
  (await getInboxStore()).saveReviewConversation(coordinates);
}

export async function settleInboxAfterReview(
  slug,
  {
    getActivity = getPrActivity,
    fetchConversation = fetchPullRequestConversation,
    loadContext = loadReviewContext,
    mutateQueueState = defaultMutateQueueState,
    readSettings = defaultReadSettings,
    resolveUsername = resolveGitHubUsername,
    readQueueState = async () => (await getInboxStore()).readQueueState(),
    saveReviewConversation = defaultSaveReviewConversation,
    now = new Date(),
  } = {},
) {
  const context = await loadContext(slug);
  const repository = `${context.owner}/${context.repo}`;
  const seed = {
    id: prKey({ repository, number: context.number }),
    number: context.number,
    repository,
    title: context.metadata?.title ?? `Pull request #${context.number}`,
    updatedAt: context.metadata?.updatedAt ?? now.toISOString(),
    url: context.prUrl,
  };

  const [saved, username] = await Promise.all([readSettings(), resolveUsername()]);
  let activity;
  try {
    activity = await getActivity(seed);
  } catch (cause) {
    const error = new Error("Pull request activity could not be loaded for inbox settle.");
    error.cause = cause;
    throw error;
  }

  const items = new Map();
  const enriched = applyInboxActivity(items, seed, activity, {
    teammates: saved.people,
    teams: saved.teams,
    username,
  });
  enriched.id = enriched.id || seed.id;

  const priorNotificationAt =
    (await readQueueState()).items[enriched.id]?.notificationUpdatedAt ?? "";
  const notificationUpdatedAt = [enriched.updatedAt, priorNotificationAt]
    .filter(Boolean)
    .sort()
    .at(-1);
  if (notificationUpdatedAt) {
    enriched.notificationUpdatedAt = notificationUpdatedAt;
  }

  const lifecycle = lifecycleForQueueItem(enriched);
  const shouldSettle = isSettleLifecycle(lifecycle) && !enriched.authored;
  const shouldRetry = !enriched.authored && !isSettleLifecycle(lifecycle);

  if (shouldSettle) {
    const doneAtMs = Math.max(
      now.getTime(),
      Date.parse(enriched.updatedAt) || 0,
      Date.parse(enriched.notificationUpdatedAt) || 0,
      Date.parse(priorNotificationAt) || 0,
    );
    await mutateQueueState(
      (state) => {
        rememberQueueItems(state, [enriched], now.toISOString());
        const record = state.items[enriched.id];
        if (!record) return null;
        return setQueueItemDone(state, enriched.id, true, new Date(doneAtMs));
      },
      { ids: [enriched.id] },
    );
  }

  try {
    const conversation = await fetchConversation({
      number: context.number,
      owner: context.owner,
      repo: context.repo,
    });
    await saveReviewConversation({
      conversation,
      number: context.number,
      owner: context.owner,
      repo: context.repo,
    });
  } catch {
    // Conversation refresh is best-effort; inbox settle still succeeds.
  }

  return {
    id: enriched.id,
    lifecycle,
    markedDone: shouldSettle,
    shouldRetry,
  };
}
