import assert from "node:assert/strict";
import test from "node:test";
import { createReviewSlug } from "../../analysis-worker/workflow/02-fetch-pr/github.js";
import {
  applyInboxMembership,
  applyQueueState,
  normalizeQueueState,
  notificationUpdatedAtByIdFromNotifications,
} from "../inbox/inbox-service/queue-state.js";
import { normalizeSettings } from "../inbox/inbox-service.js";
import {
  clearSettleInboxTimers,
  scheduleSettleInboxAfterReview,
  settleInboxAfterReview,
} from "../review/settle-inbox-after-review.js";

const repository = "owner/repo";
const number = 42;
const id = `${repository}#${number}`;
const slug = createReviewSlug({ owner: "owner", repo: "repo", number: String(number) });
const prUrl = `https://github.com/owner/repo/pull/${number}`;

function reviewedActivity(updatedAt = "2026-08-10T10:00:00Z", reviewState = "COMMENTED") {
  return {
    author: { login: "alice" },
    isDraft: false,
    labels: { nodes: [] },
    reviews: {
      nodes: [
        {
          author: { login: "me" },
          state: reviewState,
          submittedAt: updatedAt,
        },
      ],
    },
    reviewThreads: { nodes: [] },
    comments: { nodes: [], totalCount: 0 },
    commits: { nodes: [] },
    reviewRequests: { nodes: [] },
    state: "OPEN",
    title: "Test PR",
    updatedAt,
    url: prUrl,
    additions: 1,
    deletions: 0,
    changedFiles: 1,
    headRefOid: "abc",
  };
}

function unreviewedActivity(updatedAt = "2026-08-10T10:00:00Z") {
  return {
    ...reviewedActivity(updatedAt),
    reviews: { nodes: [] },
  };
}

function createMemoryQueue(initialItems = {}) {
  const state = normalizeQueueState({
    version: 2,
    sync: { username: "me", repositories: [repository] },
    items: initialItems,
  });
  return {
    mutateQueueState(callback) {
      return callback(state);
    },
    readQueueState() {
      return state;
    },
  };
}

function initialRecord() {
  return {
    version: "2026-08-10T08:00:00Z",
    updatedAt: "2026-08-10T08:00:00Z",
    notificationUpdatedAt: "2026-08-10T08:30:00Z",
    item: {
      id,
      number,
      repository,
      title: "Test PR",
      updatedAt: "2026-08-10T08:00:00Z",
      url: prUrl,
      state: "OPEN",
      comments: 0,
      signals: [{ kind: "direct-review", label: "Direct review request", weight: 10 }],
      authored: false,
      draft: false,
    },
  };
}

function settleDeps(store, activity) {
  return {
    fetchConversation: async () => ({ timeline: [], threads: [] }),
    getActivity: async () => activity,
    loadContext: async () => ({
      headSha: "abc",
      metadata: { title: "Test PR", updatedAt: activity.updatedAt },
      number,
      owner: "owner",
      prUrl,
      repo: "repo",
      runId: null,
      slug,
    }),
    mutateQueueState: (callback) => store.mutateQueueState(callback),
    readQueueState: async () => store.readQueueState(),
    readSettings: async () => normalizeSettings({ people: [], teams: [], username: "me" }),
    resolveUsername: async () => "me",
    saveReviewConversation: async () => {},
    now: new Date("2026-08-10T10:00:05.000Z"),
  };
}

test("settle marks reviewed pull requests done on the refreshed snapshot", async () => {
  const store = createMemoryQueue({ [id]: initialRecord() });
  const activity = reviewedActivity();
  const result = await settleInboxAfterReview(slug, settleDeps(store, activity));

  assert.equal(result.markedDone, true);
  assert.equal(result.lifecycle, "reviewed");
  const state = store.readQueueState();
  assert.ok(state.items[id].doneVersion);
  assert.ok(state.items[id].doneAt);
  const [item] = applyQueueState(
    [
      {
        id,
        kind: "pull_request",
        number,
        repository,
        title: "Test PR",
        updatedAt: activity.updatedAt,
        notificationUpdatedAt: activity.updatedAt,
        url: prUrl,
        state: "OPEN",
        comments: 0,
        signals: [],
        authored: false,
        draft: false,
      },
    ],
    state,
  );
  assert.equal(item.done, true);
  assert.equal(item.hasUnreadUpdates, false);
});

test("settle leaves unreviewed pull requests open", async () => {
  const store = createMemoryQueue({ [id]: initialRecord() });
  const activity = unreviewedActivity();
  const result = await settleInboxAfterReview(slug, settleDeps(store, activity));

  assert.equal(result.markedDone, false);
  assert.equal(result.shouldRetry, true);
  assert.equal(store.readQueueState().items[id].doneVersion, undefined);
});

test("settle doneAt keeps notification activity from resurfacing the row", async () => {
  const store = createMemoryQueue({ [id]: initialRecord() });
  const activity = reviewedActivity("2026-08-10T10:00:00Z");
  await settleInboxAfterReview(slug, settleDeps(store, activity));

  const state = store.readQueueState();
  const inboxIds = new Set([id]);
  const notificationTimes = notificationUpdatedAtByIdFromNotifications(
    [
      {
        thread: { updated_at: "2026-08-10T10:00:00Z" },
        pr: { number, repository: { nameWithOwner: repository } },
      },
    ],
    [],
  );
  applyInboxMembership(state, inboxIds, [], { notificationUpdatedAtById: notificationTimes });

  const [item] = applyQueueState(
    [
      {
        id,
        kind: "pull_request",
        number,
        repository,
        title: "Test PR",
        updatedAt: activity.updatedAt,
        notificationUpdatedAt: "2026-08-10T10:00:00Z",
        url: prUrl,
        state: "OPEN",
        comments: 1,
        signals: [],
        authored: false,
        draft: false,
      },
    ],
    state,
  );
  assert.equal(item.done, true);
  assert.equal(item.hasUnreadUpdates, false);
});

test("schedule settle publishes inbox and review events after the delay", async () => {
  clearSettleInboxTimers();
  const events = [];
  const timers = [];
  const eventHub = {
    publish(type, value) {
      events.push({ type, value });
    },
  };
  let settleCalls = 0;
  scheduleSettleInboxAfterReview(slug, {
    delayMs: 0,
    eventHub,
    setTimer(callback) {
      timers.push(callback);
      return 1;
    },
    settle: async () => {
      settleCalls += 1;
      return { id, lifecycle: "reviewed", markedDone: true, shouldRetry: false };
    },
  });
  assert.equal(timers.length, 1);
  await timers[0]();
  assert.equal(settleCalls, 1);
  assert.deepEqual(events, [
    { type: "inbox", value: { ids: [id] } },
    { type: "review", value: { slug } },
  ]);
  clearSettleInboxTimers();
});
