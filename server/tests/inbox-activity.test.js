import assert from "node:assert/strict";
import test from "node:test";
import { isOpenAuthoredPullRequest, lifecycleForQueueItem } from "../../shared/queue-policy.js";
import {
  applyInboxActivity,
  refreshNotificationItems,
  reviewRequestSignals,
} from "../inbox/inbox-service.js";

function openActivity(item, extra = {}) {
  return {
    author: { login: "alice" },
    isDraft: false,
    labels: { nodes: [] },
    reviews: { nodes: [] },
    state: "OPEN",
    title: extra.title ?? "Keep",
    updatedAt: "2026-08-10T09:00:00Z",
    url: item.url ?? `https://github.com/owner/repo/pull/${item.number}`,
    ...extra,
  };
}

test("draft and closed pull requests have their own lifecycles", () => {
  assert.equal(
    lifecycleForQueueItem({ state: "OPEN", draft: true, authored: true, signals: [] }),
    "draft",
  );
  assert.equal(
    lifecycleForQueueItem({ state: "CLOSED", draft: false, authored: true, signals: [] }),
    "closed",
  );
  assert.equal(
    lifecycleForQueueItem({ state: "MERGED", draft: true, authored: true, signals: [] }),
    "merged",
  );
  assert.equal(
    lifecycleForQueueItem({ state: "OPEN", draft: false, authored: true, signals: [] }),
    "mine",
  );
  assert.equal(
    lifecycleForQueueItem({ state: "UNKNOWN", draft: false, authored: true, signals: [] }),
    "mine",
  );
  assert.equal(
    lifecycleForQueueItem({ state: "UNKNOWN", draft: false, authored: false, signals: [] }),
    "new",
  );
});

test("open authored pull requests exclude merged and closed states", () => {
  assert.equal(isOpenAuthoredPullRequest({ authored: true, state: "OPEN" }), true);
  assert.equal(isOpenAuthoredPullRequest({ authored: true, state: "UNKNOWN" }), true);
  assert.equal(isOpenAuthoredPullRequest({ authored: true, state: "MERGED" }), false);
  assert.equal(isOpenAuthoredPullRequest({ authored: true, state: "CLOSED" }), false);
});

test("GraphQL review requests become direct and team signals", () => {
  const activity = {
    author: { login: "alice" },
    isDraft: false,
    labels: { nodes: [] },
    reviewRequests: {
      nodes: [
        { requestedReviewer: { login: "me" } },
        { requestedReviewer: { combinedSlug: "example/platform" } },
        { requestedReviewer: { login: "other" } },
      ],
    },
    reviews: { nodes: [] },
    state: "OPEN",
    title: "Feature",
    updatedAt: "2026-08-10T00:00:00Z",
    url: "https://github.com/owner/repo/pull/1",
  };

  assert.deepEqual(reviewRequestSignals(activity, "me", ["example/platform"]), [
    { kind: "direct-review", detail: "" },
    { kind: "team-review", detail: "example/platform" },
  ]);

  const item = {
    id: "owner/repo#1",
    number: 1,
    repository: "owner/repo",
    signals: [{ kind: "direct-mention", label: "Mentioned you", detail: "", weight: 6, href: "" }],
    updatedAt: "2026-08-10T00:00:00Z",
    url: "https://github.com/owner/repo/pull/1",
  };
  const items = new Map([[item.id, item]]);
  applyInboxActivity(items, item, activity, {
    teammates: ["alice"],
    teams: ["example/platform"],
    username: "me",
  });
  const enriched = items.get(item.id);
  assert.equal(enriched.authored, false);
  assert.deepEqual(enriched.signals.map((signal) => signal.kind).sort(), [
    "direct-mention",
    "direct-review",
    "team-review",
    "teammate-pr",
  ]);
});

test("a notification refresh keeps commented pull requests reviewed", async () => {
  const id = "owner/repo#5011";
  const items = new Map([
    [
      id,
      {
        id,
        latestReviewState: null,
        notificationUpdatedAt: "2026-08-10T08:40:00Z",
        number: 5011,
        repository: "owner/repo",
        reviewed: false,
        state: "OPEN",
        updatedAt: "2026-08-10T08:40:00Z",
      },
    ],
  ]);
  const touched = new Set();
  const activity = {
    author: { login: "alice" },
    createdAt: "2026-08-07T11:28:43Z",
    headRefOid: "head-sha",
    isDraft: false,
    labels: { nodes: [] },
    mergedAt: null,
    reviewDecision: "REVIEW_REQUIRED",
    reviews: {
      nodes: [
        {
          author: { login: "me" },
          state: "COMMENTED",
          submittedAt: "2026-08-10T08:45:04Z",
        },
      ],
    },
    state: "OPEN",
    title: "Basket layout",
    updatedAt: "2026-08-10T08:46:30Z",
    url: "https://github.com/owner/repo/pull/5011",
  };

  await refreshNotificationItems(
    items,
    [
      {
        pr: {
          number: 5011,
          repository: { nameWithOwner: "owner/repo" },
        },
        thread: { updated_at: "2026-08-10T08:46:31Z" },
      },
    ],
    touched,
    {
      getActivity: async () => activity,
      inboxIds: new Set([id]),
      queueRecords: {
        [id]: {
          version: "2026-08-10T08:40:00Z",
          notificationUpdatedAt: "2026-08-10T08:40:00Z",
          updatedAt: "2026-08-10T08:40:00Z",
          item: { updatedAt: "2026-08-10T08:40:00Z", headSha: "head-sha" },
        },
      },
      username: "me",
    },
  );

  const item = items.get(id);
  assert.equal(item.latestReviewState, "COMMENTED");
  assert.equal(item.reviewed, true);
  assert.equal(lifecycleForQueueItem(item), "reviewed");
  assert.equal(touched.has(id), true);

  const authoredId = "owner/repo#16";
  items.set(authoredId, {
    ...items.get(id),
    authored: false,
    id: authoredId,
    notificationUpdatedAt: "2026-08-10T08:40:00Z",
    number: 16,
    repository: "owner/repo",
  });
  await refreshNotificationItems(
    items,
    [
      {
        pr: { number: 16, repository: { nameWithOwner: "owner/repo" } },
        thread: { updated_at: "2026-08-10T08:46:31Z" },
      },
    ],
    touched,
    {
      getActivity: async () => ({ ...activity, author: { login: "me" } }),
      inboxIds: new Set([authoredId]),
      queueRecords: {
        [authoredId]: {
          version: "2026-08-10T08:40:00Z",
          notificationUpdatedAt: "2026-08-10T08:40:00Z",
          updatedAt: "2026-08-10T08:40:00Z",
          item: { updatedAt: "2026-08-10T08:40:00Z", headSha: "head-sha" },
        },
      },
      username: "me",
    },
  );

  assert.equal(lifecycleForQueueItem(items.get(authoredId)), "mine");
});

test("activity without an author keeps a notification-authored pull request", () => {
  const id = "owner/repo#16";
  const item = {
    authored: true,
    id,
    number: 16,
    repository: "owner/repo",
    signals: [],
    state: "UNKNOWN",
    updatedAt: "2026-08-10T08:40:00Z",
    url: "https://github.com/owner/repo/pull/16",
  };
  const items = new Map([[id, item]]);
  applyInboxActivity(
    items,
    item,
    {
      author: null,
      isDraft: false,
      labels: { nodes: [] },
      reviews: { nodes: [] },
      state: "OPEN",
      title: "Mine",
      updatedAt: "2026-08-10T09:00:00Z",
      url: item.url,
    },
    { username: "me" },
  );
  assert.equal(items.get(id).authored, true);
  assert.equal(lifecycleForQueueItem(items.get(id)), "mine");
});

test("a merged authored pull request still in the inbox leaves My PRs", async () => {
  const id = "owner/repo#9";
  const items = new Map([
    [
      id,
      {
        id,
        authored: true,
        draft: false,
        notificationUpdatedAt: "2026-08-10T08:46:31Z",
        number: 9,
        repository: "owner/repo",
        signals: [],
        state: "OPEN",
        updatedAt: "2026-08-10T08:40:00Z",
      },
    ],
  ]);
  const touched = new Set();
  await refreshNotificationItems(
    items,
    [
      {
        pr: {
          number: 9,
          repository: { nameWithOwner: "owner/repo" },
          title: "Done",
          updatedAt: "2026-08-10T08:46:31Z",
          url: "https://github.com/owner/repo/pull/9",
        },
        thread: { reason: "author", updated_at: "2026-08-10T09:00:00Z" },
      },
    ],
    touched,
    {
      authoredOpenIds: new Set([id]),
      getActivity: async () => ({
        author: { login: "me" },
        isDraft: false,
        labels: { nodes: [] },
        reviews: { nodes: [] },
        state: "MERGED",
        title: "Done",
        updatedAt: "2026-08-10T09:00:00Z",
        url: "https://github.com/owner/repo/pull/9",
      }),
      inboxIds: new Set([id]),
      queueRecords: {
        [id]: {
          version: "2026-08-10T08:46:31Z",
          notificationUpdatedAt: "2026-08-10T08:46:31Z",
          updatedAt: "2026-08-10T08:40:00Z",
          item: { updatedAt: "2026-08-10T08:40:00Z", headSha: "abc123" },
        },
      },
      username: "me",
    },
  );
  assert.equal(items.get(id).state, "MERGED");
  assert.equal(isOpenAuthoredPullRequest(items.get(id)), false);
  assert.equal(touched.has(id), true);
});

test("a notification refresh inspects changed inbox pull requests and skips Done", async () => {
  const inspected = [];
  const items = new Map([
    [
      "owner/repo#1",
      {
        id: "owner/repo#1",
        draft: false,
        number: 1,
        repository: "owner/repo",
        signals: [],
        state: "OPEN",
        updatedAt: "2026-08-10T08:40:00Z",
      },
    ],
    [
      "owner/repo#2",
      {
        id: "owner/repo#2",
        draft: false,
        number: 2,
        repository: "owner/repo",
        signals: [],
        state: "OPEN",
        updatedAt: "2026-08-10T08:40:00Z",
      },
    ],
    [
      "owner/repo#3",
      {
        id: "owner/repo#3",
        draft: false,
        notificationUpdatedAt: "2026-08-10T08:46:31Z",
        number: 3,
        repository: "owner/repo",
        signals: [],
        state: "OPEN",
        updatedAt: "2026-08-10T08:40:00Z",
      },
    ],
  ]);
  const touched = new Set();
  await refreshNotificationItems(
    items,
    [
      {
        pr: {
          number: 1,
          repository: { nameWithOwner: "owner/repo" },
          title: "Keep",
          updatedAt: "2026-08-10T08:46:31Z",
          url: "https://github.com/owner/repo/pull/1",
        },
        thread: { reason: "review_requested", updated_at: "2026-08-10T08:46:31Z" },
      },
      {
        pr: {
          number: 3,
          repository: { nameWithOwner: "owner/repo" },
          title: "Pinned",
          updatedAt: "2026-08-10T08:46:31Z",
          url: "https://github.com/owner/repo/pull/3",
        },
        thread: { reason: "review_requested", updated_at: "2026-08-10T08:46:31Z" },
      },
    ],
    touched,
    {
      getActivity: async (item) => {
        inspected.push(item.id);
        return openActivity(item, { title: item.id === "owner/repo#1" ? "Keep" : "Pinned" });
      },
      inboxIds: new Set(["owner/repo#1", "owner/repo#3"]),
      queueRecords: {
        "owner/repo#2": { doneVersion: "v", version: "v" },
        "owner/repo#3": {
          pinned: true,
          version: "2026-08-10T08:46:31Z",
          notificationUpdatedAt: "2026-08-10T08:46:31Z",
          updatedAt: "2026-08-10T08:40:00Z",
          item: {
            updatedAt: "2026-08-10T08:40:00Z",
            headSha: "abc123",
          },
        },
      },
      username: "me",
    },
  );
  assert.deepEqual(inspected, ["owner/repo#1"]);
  assert.equal(touched.has("owner/repo#2"), false);
});

test("an active pull request keeps its stored state when the notification token is unchanged", async () => {
  const id = "owner/repo#3571";
  const inspected = [];
  const items = new Map([
    [
      id,
      {
        id,
        draft: false,
        notificationUpdatedAt: "2026-08-10T08:46:31Z",
        number: 3571,
        repository: "owner/repo",
        signals: [],
        state: "OPEN",
        updatedAt: "2026-08-10T08:40:00Z",
        url: "https://github.com/owner/repo/pull/3571",
      },
    ],
  ]);
  const touched = new Set();
  await refreshNotificationItems(
    items,
    [
      {
        pr: { number: 3571, repository: { nameWithOwner: "owner/repo" } },
        thread: { updated_at: "2026-08-10T08:46:31Z" },
      },
    ],
    touched,
    {
      getActivity: async () => {
        inspected.push(id);
        return openActivity(
          { number: 3571, url: "https://github.com/owner/repo/pull/3571" },
          { mergedAt: "2026-08-10T09:20:00Z", state: "MERGED", updatedAt: "2026-08-10T09:20:00Z" },
        );
      },
      inboxIds: new Set([id]),
      queueRecords: {
        [id]: {
          version: "2026-08-10T08:46:31Z",
          notificationUpdatedAt: "2026-08-10T08:46:31Z",
          updatedAt: "2026-08-10T08:40:00Z",
          item: { updatedAt: "2026-08-10T08:40:00Z", headSha: "abc123" },
        },
      },
      username: "me",
    },
  );
  assert.deepEqual(inspected, []);
  assert.equal(items.get(id).state, "OPEN");
  assert.equal(items.get(id).updatedAt, "2026-08-10T08:40:00Z");
});

test("a pinned pull request hydrates on first sight", async () => {
  const id = "owner/repo#8";
  const inspected = [];
  const items = new Map([
    [
      id,
      {
        id,
        draft: false,
        number: 8,
        repository: "owner/repo",
        signals: [],
        state: "OPEN",
        updatedAt: "2026-08-10T08:40:00Z",
        url: "https://github.com/owner/repo/pull/8",
      },
    ],
  ]);
  await refreshNotificationItems(items, [], new Set(), {
    getActivity: async (item) => {
      inspected.push(item.id);
      return openActivity(item, { state: "MERGED", updatedAt: "2026-08-10T09:20:00Z" });
    },
    inboxIds: new Set(),
    queueRecords: { [id]: { pinned: true } },
    username: "me",
  });
  assert.deepEqual(inspected, [id]);
  assert.equal(items.get(id).state, "MERGED");
});

test("a failed GitHub inbox list skips unchanged remaining-active pull requests", async () => {
  const inspected = [];
  const items = new Map([
    [
      "owner/repo#1",
      {
        id: "owner/repo#1",
        draft: false,
        number: 1,
        repository: "owner/repo",
        signals: [],
        state: "OPEN",
        updatedAt: "2026-08-10T08:40:00Z",
      },
    ],
    [
      "owner/repo#2",
      {
        id: "owner/repo#2",
        draft: false,
        number: 2,
        repository: "owner/repo",
        signals: [],
        state: "OPEN",
        updatedAt: "2026-08-10T08:40:00Z",
      },
    ],
  ]);
  await refreshNotificationItems(items, [], new Set(), {
    getActivity: async (item) => {
      inspected.push(item.id);
      return openActivity(item);
    },
    inboxIds: null,
    queueRecords: {
      "owner/repo#1": {
        version: "2026-08-10T08:40:00Z",
        updatedAt: "2026-08-10T08:40:00Z",
        item: { updatedAt: "2026-08-10T08:40:00Z", headSha: "abc123" },
      },
      "owner/repo#2": { doneVersion: "v", version: "v" },
    },
    username: "me",
  });
  assert.deepEqual(inspected, []);
});

test("an authored pull request refreshes when GitHub headSha changes", async () => {
  const id = "owner/repo#5";
  const inspected = [];
  const items = new Map([
    [
      id,
      {
        id,
        authored: true,
        draft: false,
        headSha: "abc123",
        number: 5,
        repository: "owner/repo",
        signals: [],
        state: "OPEN",
        updatedAt: "2026-08-10T08:40:00Z",
        url: "https://github.com/owner/repo/pull/5",
      },
    ],
  ]);
  await refreshNotificationItems(items, [], new Set(), {
    authoredOpenIds: new Set([id]),
    authoredPullRequests: [
      {
        headSha: "def456",
        number: 5,
        repository: { nameWithOwner: "owner/repo" },
        updatedAt: "2026-08-10T08:40:00Z",
        url: "https://github.com/owner/repo/pull/5",
      },
    ],
    getActivity: async (item) => {
      inspected.push(item.id);
      return openActivity(item, { headRefOid: "def456" });
    },
    inboxIds: new Set(),
    queueRecords: {
      [id]: {
        version: "2026-08-10T08:40:00Z",
        updatedAt: "2026-08-10T08:40:00Z",
        item: { updatedAt: "2026-08-10T08:40:00Z", headSha: "abc123" },
      },
    },
    username: "me",
  });
  assert.deepEqual(inspected, [id]);
});
