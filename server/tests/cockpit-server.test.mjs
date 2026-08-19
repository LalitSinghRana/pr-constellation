import assert from "node:assert/strict";
import test from "node:test";
import { automaticallyQueueNewAnalyses } from "../inbox/inbox-service/analysis-queue.js";
import {
  activityCandidates,
  addReviewRequests,
  addSignal,
  addSource,
  apiMutationRejection,
  applyAuthoredReadState,
  applyInboxMembership,
  applyQueueState,
  defaultPort,
  excludeAuthoredPullRequestNotifications,
  inboxFromQueue,
  inboxIdsFromNotifications,
  normalizeSettings,
  otherNotificationFromThread,
  PARTICIPATING_NOTIFICATION_REASONS,
  prFromNotification,
  queueVersion,
  rankItems,
  rememberQueueItems,
  requestHostRejection,
  reviewArtifactPath,
  seedAuthoredPullRequests,
  seedNotificationPullRequests,
  setQueueItemDone,
  setQueueItemRead,
  setQueueItemsDone,
  sortPullRequestsBySize,
  stampAuthoredNotificationTimes,
  summarizeActivity,
  trackedQueueItems,
} from "../server.mjs";

test("automatic queue includes only active new pull requests", async () => {
  const queued = [];
  const result = await automaticallyQueueNewAnalyses(
    [
      {
        done: false,
        lifecycle: "new",
        title: "New",
        url: "https://github.com/example/repo/pull/1",
      },
      {
        done: true,
        lifecycle: "new",
        title: "Done",
        url: "https://github.com/example/repo/pull/2",
      },
      {
        done: false,
        lifecycle: "reviewed",
        title: "Reviewed",
        url: "https://github.com/example/repo/pull/3",
      },
    ],
    {
      enqueue: async ({ prUrl }) => {
        queued.push(prUrl);
        return { prUrl };
      },
      snapshot: async () => ({ prs: [] }),
    },
  );

  assert.deepEqual(queued, ["https://github.com/example/repo/pull/1"]);
  assert.equal(result.runs.length, 1);
});

test("the cockpit uses its dedicated local port", () => {
  assert.equal(defaultPort, 4397);
});

test("state-changing APIs reject cross-site and form requests", () => {
  assert.deepEqual(
    apiMutationRejection(
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://attacker.example",
        },
      },
      "/api/inbox/sync",
    ),
    { status: 403, error: "Cross-origin API mutations are not allowed." },
  );
  assert.equal(
    apiMutationRejection(
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "http://127.0.0.1:4397",
        },
      },
      "/api/inbox/sync",
    ),
    null,
  );
  assert.equal(apiMutationRejection({ method: "GET", headers: {} }, "/api/inbox"), null);
  assert.equal(
    apiMutationRejection({ method: "POST", headers: {} }, "/api/inbox/sync")?.status,
    415,
  );
});

test("the HTTP boundary rejects DNS-rebinding hostnames", () => {
  assert.equal(requestHostRejection({ headers: { host: "127.0.0.1:4397" } }), null);
  assert.equal(requestHostRejection({ headers: { host: "localhost:4397" } }), null);
  assert.equal(requestHostRejection({ headers: { host: "attacker.example:4397" } })?.status, 421);
});

const pr = {
  id: "PR_1",
  number: 42,
  title: "Make review queues calmer",
  url: "https://github.com/example/repo/pull/42",
  repository: { nameWithOwner: "example/repo" },
  author: { login: "alice" },
  commentsCount: 3,
  createdAt: "2026-07-01T00:00:00Z",
  updatedAt: "2026-07-03T00:00:00Z",
  isDraft: false,
  labels: [],
};

test("one app serves generated reviews without allowing path traversal", () => {
  assert.equal(reviewArtifactPath("/reviews"), null);
  assert.equal(reviewArtifactPath("/reviews/"), null);
  // Document URLs are SPA-owned and must not resolve as static artifacts.
  assert.equal(reviewArtifactPath("/reviews/example-pr/"), null);
  assert.equal(reviewArtifactPath("/reviews/example-pr/run-1/"), null);
  assert.match(
    reviewArtifactPath("/reviews/example-pr/run-1/analysis.json"),
    /\.reviews\/example-pr\/run-1\/analysis\.json$/,
  );
  assert.equal(reviewArtifactPath("/reviews/%2e%2e/server.mjs"), null);
  assert.equal(reviewArtifactPath("/reviews/.run-store.sqlite"), null);
  assert.equal(reviewArtifactPath("/reviews/example-pr/.private"), null);
  assert.equal(reviewArtifactPath("/api/dashboard"), null);
});

test("lifecycle base and fresh signals add once", () => {
  const items = new Map();
  addSource(items, pr, "reviewed");
  items.get("example/repo#42").latestReviewState = "COMMENTED";
  addSignal(items, pr, "direct-review");
  addSignal(items, pr, "teammate-pr", "alice");
  addSignal(items, pr, "direct-review");

  const [item] = rankItems(items);
  assert.equal(item.lifecycle, "reviewed");
  assert.equal(item.lifecycleScore, 10);
  assert.equal(item.score, 27);
  assert.deepEqual(
    item.signals.map((signal) => signal.kind),
    ["direct-review", "teammate-pr"],
  );
});

test("approved scores stay and drafts keep their lifecycle", () => {
  const approvedItems = new Map();
  addSource(approvedItems, pr, "reviewed");
  approvedItems.get("example/repo#42").latestReviewState = "APPROVED";
  addSignal(approvedItems, pr, "review-reply");
  assert.equal(rankItems(approvedItems)[0].score, 1);

  addSignal(approvedItems, pr, "direct-review");
  assert.equal(rankItems(approvedItems)[0].score, 11);

  const draftItems = new Map();
  const draftPr = { ...pr, isDraft: true };
  addSource(draftItems, draftPr, "reviewed");
  draftItems.get("example/repo#42").latestReviewState = "COMMENTED";
  addSignal(draftItems, draftPr, "direct-review");
  const [draft] = rankItems(draftItems);
  assert.equal(draft.lifecycle, "draft");
  assert.equal(draft.score, 0);

  const closedItems = new Map();
  addSource(closedItems, { ...pr, state: "CLOSED" }, "reviewed");
  const [closed] = rankItems(closedItems);
  assert.equal(closed.lifecycle, "closed");
  assert.equal(closed.score, -5);
});

test("my pull requests get their own lifecycle", () => {
  const items = new Map();
  addSource(items, pr, "authored");

  const [mine] = rankItems(items);
  assert.equal(mine.lifecycle, "mine");
  assert.equal(mine.score, 0);
});

test("notification seeding ignores author-reason pull requests", () => {
  const items = new Map();
  seedAuthoredPullRequests(items, [pr]);
  seedNotificationPullRequests(items, [
    {
      thread: { reason: "author", updated_at: "2026-07-06T00:00:00Z" },
      pr,
    },
    {
      thread: { reason: "review_requested", updated_at: "2026-07-06T00:00:00Z" },
      pr: {
        ...pr,
        number: 99,
        url: "https://github.com/example/repo/pull/99",
      },
    },
  ]);
  assert.equal(items.get("example/repo#42").authored, true);
  assert.equal(items.get("example/repo#99").authored, false);
  const remaining = excludeAuthoredPullRequestNotifications(
    [
      { thread: { reason: "comment" }, pr },
      {
        thread: { reason: "review_requested" },
        pr: { ...pr, number: 99, url: "https://github.com/example/repo/pull/99" },
      },
    ],
    ["example/repo#42"],
  );
  assert.deepEqual(
    remaining.map(({ pr: item }) => item.number),
    [99],
  );
});

test("a comment after merge lifts a merged PR back into attention", () => {
  const items = new Map();
  const mergedPr = { ...pr, state: "MERGED" };
  addSource(items, mergedPr, "reviewed");

  const [quietMerge] = rankItems(items);
  assert.equal(quietMerge.lifecycle, "merged");
  assert.equal(quietMerge.score, -5);

  addSignal(items, mergedPr, "post-merge-comment", "bob");
  const [activeMerge] = rankItems(items);
  assert.equal(activeMerge.lifecycle, "merged");
  assert.equal(activeMerge.lifecycleScore, -5);
  assert.equal(activeMerge.score, 5);
});

test("activity newer than my review is summarized once", () => {
  const activity = {
    commits: { nodes: [{ commit: { committedDate: "2026-07-03T12:00:00Z" } }] },
    comments: {
      nodes: [
        {
          author: { login: "bob" },
          createdAt: "2026-07-03T13:00:00Z",
          url: "https://github.com/example/repo/pull/42#issuecomment-1",
        },
      ],
    },
    reviews: {
      nodes: [
        {
          author: { login: "me" },
          state: "APPROVED",
          submittedAt: "2026-07-03T10:00:00Z",
        },
        {
          author: { login: "alice" },
          state: "COMMENTED",
          submittedAt: "2026-07-03T11:00:00Z",
        },
      ],
    },
    reviewThreads: {
      nodes: [
        {
          comments: {
            nodes: [
              { author: { login: "me" }, createdAt: "2026-07-03T10:00:00Z" },
              {
                author: { login: "bob" },
                createdAt: "2026-07-03T11:00:00Z",
                url: "https://github.com/example/repo/pull/42#discussion-1",
              },
            ],
          },
        },
      ],
    },
    mergedAt: "2026-07-03T12:30:00Z",
  };

  const summary = summarizeActivity(activity, "me", ["alice"]);
  assert.equal(summary.latestReviewState, "APPROVED");
  assert.equal(summary.hasNewCommits, true);
  assert.equal(summary.newestReply.author.login, "bob");
  assert.equal(summary.newComment.author.login, "bob");
  assert.equal(summary.postMergeComment.author.login, "bob");
  assert.equal(summary.coveringTeammate, "alice");
});

test("PR and non-PR notification threads stay visible", () => {
  const base = {
    id: "123",
    reason: "mention",
    updated_at: "2026-07-04T00:00:00Z",
    repository: {
      full_name: "example/repo",
      html_url: "https://github.com/example/repo",
    },
  };
  const pullRequest = {
    ...base,
    subject: {
      type: "PullRequest",
      title: "Make review queues calmer",
      url: "https://api.github.com/repos/example/repo/pulls/42",
    },
  };
  const issue = {
    ...base,
    subject: {
      type: "Issue",
      title: "Keep all notifications",
      url: "https://api.github.com/repos/example/repo/issues/7",
    },
  };

  assert.equal(prFromNotification(pullRequest).number, 42);
  assert.equal(prFromNotification(pullRequest).notificationThreadId, "123");
  assert.equal(otherNotificationFromThread(issue).url, "https://github.com/example/repo/issues/7");
  assert.equal(otherNotificationFromThread(issue).notificationThreadId, "123");
});

test("non-PR notifications survive the local queue round trip", () => {
  const notification = otherNotificationFromThread({
    id: "123",
    reason: "mention",
    unread: true,
    updated_at: "2026-07-04T00:00:00Z",
    repository: {
      full_name: "example/repo",
      html_url: "https://github.com/example/repo",
    },
    subject: {
      type: "Issue",
      title: "Keep all notifications",
      url: "https://api.github.com/repos/example/repo/issues/7",
    },
  });
  const state = { version: 2, sync: {}, items: {} };
  rememberQueueItems(state, [notification], "2026-07-04T00:00:00Z");

  const [restored] = inboxFromQueue(state).notifications;
  assert.equal(restored.id, "notification:123");
  assert.equal(restored.title, "Keep all notifications");
  assert.equal(restored.unread, true);
  assert.equal(restored.done, false);

  setQueueItemDone(state, restored.id, true);
  assert.equal(inboxFromQueue(state).notifications[0].done, true);
});

test("notifications prioritize changed tracked PRs without adding unknown PRs", () => {
  const items = new Map();
  addSource(items, pr, "reviewed");
  const newerPr = {
    ...pr,
    id: "PR_2",
    number: 43,
    url: "https://github.com/example/repo/pull/43",
    updatedAt: "2026-07-05T00:00:00Z",
  };
  addSource(items, newerPr, "reviewed");

  const changedThread = {
    unread: true,
    updated_at: "2026-07-06T00:00:00Z",
  };
  const changedPr = {
    number: 42,
    repository: { nameWithOwner: "example/repo" },
  };
  const unknown = {
    thread: { unread: true, updated_at: "2026-07-07T00:00:00Z" },
    pr: {
      number: 99,
      repository: { nameWithOwner: "example/repo" },
    },
  };

  const unread = activityCandidates(items, [{ thread: changedThread, pr: changedPr }, unknown], 1);
  const read = activityCandidates(
    items,
    [{ thread: { ...changedThread, unread: false }, pr: changedPr }, unknown],
    1,
  );

  assert.deepEqual(
    unread.map((item) => item.id),
    ["example/repo#42"],
  );
  assert.deepEqual(
    read.map((item) => item.id),
    ["example/repo#42"],
  );
  items.get("example/repo#42").notificationUpdatedAt = changedThread.updated_at;
  assert.deepEqual(activityCandidates(items, [{ thread: changedThread, pr: changedPr }], 0), []);
  assert.equal(items.has("example/repo#99"), false);
});

test("inbox notifications seed any repository including watch-subscribed pull requests", () => {
  for (const [index, reason] of PARTICIPATING_NOTIFICATION_REASONS.entries()) {
    const items = new Map();
    const number = 3541 + index;
    const notification = {
      thread: {
        reason,
        unread: false,
        updated_at: "2026-07-06T00:00:00Z",
      },
      pr: {
        number,
        title: "Do not miss short-lived pull requests",
        url: `https://github.com/other-org/other-repo/pull/${number}`,
        repository: { nameWithOwner: "other-org/other-repo" },
        updatedAt: "2026-07-06T00:00:00Z",
        state: "UNKNOWN",
        notificationThreadId: "456",
      },
    };
    seedNotificationPullRequests(items, [notification]);
    const item = items.get(`other-org/other-repo#${number}`);
    if (reason === "author") {
      assert.equal(item, undefined, reason);
      continue;
    }
    assert.equal(item != null, true, reason);
    assert.equal(item.authored, false, reason);
  }

  const reviewRequested = new Map();
  seedNotificationPullRequests(reviewRequested, [
    {
      thread: {
        reason: "review_requested",
        unread: false,
        updated_at: "2026-07-06T00:00:00Z",
      },
      pr: {
        number: 3541,
        title: "Do not miss short-lived pull requests",
        url: "https://github.com/other-org/other-repo/pull/3541",
        repository: { nameWithOwner: "other-org/other-repo" },
        updatedAt: "2026-07-06T00:00:00Z",
        state: "UNKNOWN",
        notificationThreadId: "456",
      },
    },
  ]);
  assert.equal(reviewRequested.get("other-org/other-repo#3541").notificationThreadId, "456");

  for (const reason of ["subscribed", "ci_activity", "manual"]) {
    const items = new Map();
    seedNotificationPullRequests(items, [
      {
        thread: { reason, unread: true, updated_at: "2026-07-06T00:00:00Z" },
        pr: {
          number: 99,
          title: "Watch noise",
          url: "https://github.com/other-org/other-repo/pull/99",
          repository: { nameWithOwner: "other-org/other-repo" },
          updatedAt: "2026-07-06T00:00:00Z",
          state: "UNKNOWN",
        },
      },
    ]);
    assert.equal(items.has("other-org/other-repo#99"), true, reason);
  }
});

test("direct and team review requests seed the queue separately", () => {
  const items = new Map();
  const requested = {
    ...pr,
    number: 43,
    id: "PR_2",
    url: "https://github.com/example/repo/pull/43",
  };

  addReviewRequests(items, [requested], "direct-review");
  const [item] = rankItems(items);
  assert.equal(item.number, 43);
  assert.equal(item.lifecycle, "new");
  assert.deepEqual(
    item.signals.map((signal) => signal.kind),
    ["direct-review"],
  );

  const teamItems = new Map();
  addReviewRequests(teamItems, [requested], "team-review", "example/reviewers");
  const [teamItem] = rankItems(teamItems);
  assert.equal(teamItem.number, 43);
  assert.deepEqual(teamItem.signals, [
    {
      kind: "team-review",
      label: "Team review request",
      detail: "example/reviewers",
      weight: 3,
      href: requested.url,
    },
  ]);

  addReviewRequests(teamItems, [requested], "direct-review");
  assert.equal(rankItems(teamItems)[0].score, 10);
});

test("local read and Done state reopen for PR updates", () => {
  const items = new Map();
  addReviewRequests(items, [pr], "direct-review");
  const [item] = rankItems(items);
  const state = { version: 1, items: {} };

  rememberQueueItems(state, [item], "2026-07-04T00:00:00Z");
  state.items[item.id].item.headSha = "old-head";
  assert.equal(applyQueueState([item], state)[0].read, false);
  assert.deepEqual(setQueueItemRead(state, item.id, true), {
    id: item.id,
    read: true,
    hasUnreadUpdates: false,
    updatesSinceRead: [],
  });
  assert.equal(applyQueueState([item], state)[0].read, true);

  const reviewReply = {
    ...item,
    updatedAt: "2026-07-03T01:00:00Z",
    signals: [
      {
        kind: "review-reply",
        label: "Reply to your review",
        detail: "alice",
        weight: 6,
        href: `${item.url}#discussion-1`,
      },
    ],
  };
  assert.deepEqual(applyQueueState([reviewReply], state)[0].updatesSinceRead, [
    "Reply to your review",
  ]);

  assert.deepEqual(setQueueItemDone(state, item.id, true), {
    id: item.id,
    done: true,
    hasUpdates: false,
  });
  assert.deepEqual(state.items[item.id].doneSnapshot, {
    title: item.title,
    state: item.state,
    comments: item.comments,
    headSha: "old-head",
    draft: item.draft,
  });
  assert.equal(applyQueueState([item], state)[0].done, true);

  const notificationChanged = {
    ...item,
    notificationUpdatedAt: "2099-01-01T00:00:00Z",
  };
  assert.notEqual(queueVersion(notificationChanged), queueVersion(item));
  const renotified = applyQueueState([notificationChanged], state)[0];
  assert.equal(renotified.done, false);
  assert.equal(renotified.hasUpdates, true);
  assert.equal(renotified.changesSince, "marked done");
  assert.deepEqual(renotified.updatesSinceRead, ["Direct review request"]);

  const updated = {
    ...item,
    title: "Make review queues quieter",
    state: "MERGED",
    comments: item.comments + 2,
    draft: true,
    headSha: "new-head",
    updatedAt: "2026-07-05T00:00:00Z",
  };
  const reopened = applyQueueState([updated], state)[0];
  assert.equal(reopened.done, false);
  assert.equal(reopened.hasUpdates, true);
  assert.equal(reopened.read, false);
  assert.equal(reopened.hasUnreadUpdates, true);
  assert.equal(reopened.changesSince, "marked done");
  assert.deepEqual(reopened.updatesSinceRead, [
    "Merged",
    "New commits",
    "2 new comments",
    "Converted to draft",
    "Title changed",
  ]);

  assert.deepEqual(setQueueItemDone(state, item.id, false), {
    id: item.id,
    done: false,
    hasUpdates: false,
  });
  assert.equal(state.items[item.id].doneSnapshot, undefined);
  assert.equal(applyQueueState([item], state)[0].done, false);
  setQueueItemRead(state, item.id, false);
  assert.equal(applyQueueState([item], state)[0].read, false);
  setQueueItemDone(state, item.id, true);
  assert.equal(applyQueueState([item], state)[0].read, false);
});

test("a date group can be marked done together", () => {
  const state = {
    items: {
      one: { version: "v1", item: { title: "One" } },
      two: {
        version: "2026-08-01T00:00:00Z",
        notificationUpdatedAt: "2026-08-02T00:00:00Z",
        item: { title: "Two", updatedAt: "2026-08-01T00:00:00Z" },
      },
    },
  };
  assert.deepEqual(setQueueItemsDone(state, ["one", "two"]), {
    ids: ["one", "two"],
    done: true,
    hasUpdates: false,
  });
  assert.equal(state.items.one.doneVersion, "v1");
  assert.equal(state.items.two.doneVersion, "2026-08-02T00:00:00Z");
  assert.equal(setQueueItemsDone(state, ["missing"]), null);
});

test("tracked PR snapshots restore local membership and migrate old records", () => {
  const items = new Map();
  const mergedPr = {
    ...pr,
    state: "MERGED",
    reviewDecision: "APPROVED",
    notificationThreadId: "123",
  };
  addSource(items, mergedPr, "reviewed");
  addSignal(items, mergedPr, "team-review", "example/reviewers");
  const [merged] = rankItems(items);
  const state = { version: 1, items: {} };
  rememberQueueItems(state, [merged], "2026-07-04T00:00:00Z");

  const [restored] = trackedQueueItems(state);
  assert.equal(restored.id, "example/repo#42");
  assert.equal(restored.title, pr.title);
  assert.equal(restored.state, "MERGED");
  assert.equal(restored.reviewDecision, "APPROVED");
  assert.equal(restored.notificationThreadId, "123");
  assert.deepEqual(
    restored.signals.map((signal) => signal.kind),
    ["team-review"],
  );
  assert.equal(restored.notification, null);

  const localInbox = inboxFromQueue(state, "me");
  assert.equal(localInbox.username, "me");
  assert.deepEqual(localInbox.repositories, ["example/repo"]);
  assert.deepEqual(
    localInbox.items[0].signals.map((signal) => signal.kind),
    ["team-review"],
  );

  const legacy = {
    version: 1,
    items: {
      "example/repo#7": {
        url: "https://github.com/example/repo/pull/7",
        updatedAt: "2026-06-01T00:00:00Z",
        version: "2026-06-01T00:00:00Z",
        doneVersion: "2026-06-01T00:00:00Z",
      },
    },
  };
  const [migrated] = trackedQueueItems(legacy);
  assert.equal(migrated.title, "Pull request #7");
  assert.equal(migrated.state, "UNKNOWN");
  assert.equal(applyQueueState([migrated], legacy)[0].done, true);
});

test("inbox repositories are unique sorted active PR repos", () => {
  const items = new Map();
  addSource(
    items,
    {
      ...pr,
      number: 1,
      url: "https://github.com/zebra/app/pull/1",
      repository: { nameWithOwner: "zebra/app" },
    },
    "reviewed",
  );
  addSource(
    items,
    {
      ...pr,
      number: 2,
      url: "https://github.com/alpha/app/pull/2",
      repository: { nameWithOwner: "alpha/app" },
    },
    "reviewed",
  );
  const state = {
    version: 2,
    sync: { repositories: ["kept/old", "alpha/app"] },
    items: {},
  };
  rememberQueueItems(state, rankItems(items), "2026-07-04T00:00:00Z");
  assert.deepEqual(inboxFromQueue(state).repositories, ["alpha/app", "zebra/app"]);

  setQueueItemDone(state, "zebra/app#1", true);
  assert.deepEqual(inboxFromQueue(state).repositories, ["alpha/app"]);
});

test("GitHub inbox membership reopens local done and archives missing threads", () => {
  const items = new Map();
  addSource(items, pr, "repository");
  addSource(
    items,
    {
      ...pr,
      number: 43,
      url: "https://github.com/example/repo/pull/43",
    },
    "repository",
  );
  const entries = rankItems(items);
  const state = { version: 2, sync: {}, items: {} };
  rememberQueueItems(state, entries, "2026-07-31T12:00:00Z");
  setQueueItemDone(state, "example/repo#42", true);

  applyInboxMembership(state, inboxIdsFromNotifications([{ pr }]));

  const next = applyQueueState(entries, state);
  assert.equal(next.find((item) => item.number === 42).done, false);
  assert.equal(next.find((item) => item.number === 43).done, true);
  assert.deepEqual(inboxFromQueue(state).repositories, ["example/repo"]);
});

test("inbox membership keeps authored pull requests that are not in GitHub inbox", () => {
  const items = new Map();
  addSource(items, pr, "authored");
  addSource(
    items,
    {
      ...pr,
      number: 43,
      url: "https://github.com/example/repo/pull/43",
    },
    "repository",
  );
  const entries = rankItems(items);
  const state = { version: 2, sync: {}, items: {} };
  rememberQueueItems(state, entries, "2026-07-31T12:00:00Z");

  applyInboxMembership(state, [], ["example/repo#42"]);
  const next = applyQueueState(entries, state);
  assert.equal(next.find((item) => item.number === 42).done, false);
  assert.equal(next.find((item) => item.number === 43).done, true);

  setQueueItemDone(state, "example/repo#42", true);
  applyInboxMembership(state, [], ["example/repo#42"]);
  assert.equal(applyQueueState(entries, state).find((item) => item.number === 42).done, true);
});

test("authored pull requests stay in My PRs and look read without new notifications", () => {
  const items = new Map();
  addSource(items, pr, "authored");
  const [item] = rankItems(items);
  const state = { version: 2, sync: {}, items: {} };
  rememberQueueItems(state, [item], "2026-07-31T12:00:00Z");
  setQueueItemDone(state, item.id, true);

  applyAuthoredReadState(state, [item.id], []);
  const quiet = applyQueueState([item], state)[0];
  assert.equal(quiet.done, false);
  assert.equal(quiet.read, true);
  assert.equal(quiet.hasUnreadUpdates, false);

  const notified = stampAuthoredNotificationTimes(
    new Map([[item.id, { ...item }]]),
    [{ thread: { reason: "author", updated_at: "2026-08-01T00:00:00Z" }, pr }],
    [item.id],
  );
  assert.deepEqual([...notified], [item.id]);

  const updated = { ...item, notificationUpdatedAt: "2026-08-01T00:00:00Z" };
  rememberQueueItems(state, [updated], "2026-08-01T00:00:00Z");
  applyAuthoredReadState(state, [item.id], [item.id]);
  const active = applyQueueState([updated], state)[0];
  assert.equal(active.done, false);
  assert.equal(active.read, false);
  assert.equal(active.hasUnreadUpdates, true);
});

test("settings lists are validated before writing", () => {
  assert.deepEqual(
    normalizeSettings({
      username: "me",
      people: ["alice", "alice", "not valid"],
      teams: ["example/platform", "bad"],
      autoQueue: true,
      showMinimap: true,
      defaultAnalysisModel: "grok-4.5",
    }),
    {
      username: "me",
      people: ["alice"],
      teams: ["example/platform"],
      autoQueue: true,
      showMinimap: true,
      defaultAnalysisProvider: "cursor",
      defaultAnalysisModel: "cursor-grok-4.5",
      defaultAnalysisReasoningEffort: "xhigh",
    },
  );
  assert.equal(normalizeSettings({}).autoQueue, false);
  assert.equal(normalizeSettings({}).showMinimap, false);
  assert.equal(normalizeSettings({}).defaultAnalysisModel, "cursor-grok-4.6");
  assert.equal(normalizeSettings({}).defaultAnalysisProvider, "cursor");
  assert.equal(normalizeSettings({}).defaultAnalysisReasoningEffort, "xhigh");
  assert.equal(normalizeSettings({ autoQueue: false }).autoQueue, false);
  assert.equal(normalizeSettings({ showMinimap: false }).showMinimap, false);
  assert.equal(normalizeSettings({ autoQueue: true }).autoQueue, true);
  assert.equal(normalizeSettings({ showMinimap: true }).showMinimap, true);
  assert.equal(
    normalizeSettings({ defaultAnalysisModel: "not a real model" }).defaultAnalysisModel,
    "cursor-grok-4.6",
  );
  assert.deepEqual(
    normalizeSettings({
      defaultAnalysisProvider: "codex",
      defaultAnalysisModel: "gpt-5.6-sol",
      defaultAnalysisReasoningEffort: "xhigh",
    }),
    {
      username: "",
      people: [],
      teams: [],
      autoQueue: false,
      showMinimap: false,
      defaultAnalysisProvider: "codex",
      defaultAnalysisModel: "gpt-5.6-sol",
      defaultAnalysisReasoningEffort: "xhigh",
    },
  );
});

test("manual batch analyses queue from smallest pull request to largest", () => {
  const ordered = sortPullRequestsBySize([
    {
      url: "https://github.com/example/repo/pull/3",
      additions: 50,
      deletions: 10,
      changedFiles: 2,
    },
    { url: "https://github.com/example/repo/pull/1", additions: 5, deletions: 5, changedFiles: 3 },
    { url: "https://github.com/example/repo/pull/2", additions: 8, deletions: 2, changedFiles: 1 },
    {
      url: "https://github.com/example/repo/pull/4",
      additions: null,
      deletions: null,
      changedFiles: null,
    },
  ]);

  assert.deepEqual(
    ordered.map((item) => item.url),
    [
      "https://github.com/example/repo/pull/2",
      "https://github.com/example/repo/pull/1",
      "https://github.com/example/repo/pull/3",
      "https://github.com/example/repo/pull/4",
    ],
  );
});
