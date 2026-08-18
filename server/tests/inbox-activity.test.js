import assert from "node:assert/strict";
import test from "node:test";
import { lifecycleForQueueItem } from "../../shared/queue-policy.js";
import {
  applyInboxActivity,
  refreshNotificationItems,
  reviewRequestSignals,
} from "../inbox/inbox-service.js";

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
    { getActivity: async () => activity, username: "me" },
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
      username: "me",
    },
  );

  assert.equal(lifecycleForQueueItem(items.get(authoredId)), "mine");
});

test("a full refresh inspects existing pull requests without new notifications", async () => {
  const id = "owner/repo#9";
  const items = new Map([
    [
      id,
      {
        id,
        draft: false,
        number: 9,
        repository: "owner/repo",
        signals: [],
        state: "OPEN",
        updatedAt: "2026-08-10T08:40:00Z",
      },
    ],
  ]);
  const touched = new Set();
  await refreshNotificationItems(items, [], touched, {
    getActivity: async () => ({
      author: { login: "alice" },
      isDraft: false,
      labels: { nodes: [] },
      reviews: { nodes: [] },
      state: "MERGED",
      title: "Done",
      updatedAt: "2026-08-10T09:00:00Z",
      url: "https://github.com/owner/repo/pull/9",
    }),
    inspectAll: true,
    username: "me",
  });
  assert.equal(items.get(id).state, "MERGED");
  assert.equal(touched.has(id), true);
});
