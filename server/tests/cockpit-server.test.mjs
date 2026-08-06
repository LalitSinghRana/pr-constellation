import assert from "node:assert/strict";
import test from "node:test";
import {
  activityCandidates,
  addReviewRequests,
  addSignal,
  addSource,
  applyAutomaticDone,
  applyQueueState,
  defaultPort,
  inboxFromQueue,
  normalizeSettings,
  otherNotificationFromThread,
  prFromNotification,
  queueVersion,
  rankItems,
  rememberQueueItems,
  reviewArtifactPath,
  seedNotificationPullRequests,
  setQueueItemDone,
  setQueueItemRead,
  setQueueItemsDone,
  sortPullRequestsBySize,
  summarizeActivity,
  trackedQueueItems,
  trackedRepositories,
} from "../server.mjs";

test("the cockpit uses its dedicated local port", () => {
  assert.equal(defaultPort, 4397);
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
  assert.match(reviewArtifactPath("/reviews/example-pr/"), /\.reviews\/example-pr$/);
  assert.equal(reviewArtifactPath("/reviews/%2e%2e/server.mjs"), null);
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

test("approved and draft lifecycle scores never reset", () => {
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
});

test("my pull requests get their own lifecycle", () => {
  const items = new Map();
  addSource(items, pr, "authored");

  const [mine] = rankItems(items);
  assert.equal(mine.lifecycle, "mine");
  assert.equal(mine.score, 0);
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

test("a read review-request notification can seed a scoped missing PR", () => {
  const items = new Map();
  const notification = {
    thread: {
      reason: "review_requested",
      unread: false,
      updated_at: "2026-07-06T00:00:00Z",
    },
    pr: {
      number: 3541,
      title: "Do not miss short-lived pull requests",
      url: "https://github.com/example/app/pull/3541",
      repository: { nameWithOwner: "example/app" },
      updatedAt: "2026-07-06T00:00:00Z",
      state: "UNKNOWN",
      notificationThreadId: "456",
    },
  };

  seedNotificationPullRequests(items, [notification], ["example/app"]);
  assert.equal(items.get("example/app#3541").state, "UNKNOWN");
  assert.equal(items.get("example/app#3541").notificationThreadId, "456");
  items.get("example/app#3541").state = "OPEN";
  seedNotificationPullRequests(
    items,
    [{ ...notification, thread: { ...notification.thread, reason: "comment" } }],
    ["example/app"],
  );
  assert.equal(items.get("example/app#3541").state, "OPEN");

  seedNotificationPullRequests(
    items,
    [
      {
        ...notification,
        thread: { ...notification.thread, reason: "comment" },
        pr: {
          ...notification.pr,
          number: 3542,
          url: "https://github.com/example/app/pull/3542",
        },
      },
    ],
    ["example/app"],
  );
  assert.equal(items.has("example/app#3542"), false);
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
  assert.deepEqual(localInbox.repositories, trackedRepositories);
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

test("old open and merged PRs auto-complete unless explicitly restored", () => {
  const now = Date.parse("2026-07-31T12:00:00Z");
  const items = new Map();
  addSource(items, { ...pr, updatedAt: "2026-07-20T00:00:00Z" }, "repository");
  addSource(
    items,
    {
      ...pr,
      number: 43,
      url: "https://github.com/example/repo/pull/43",
      state: "MERGED",
      updatedAt: "2026-07-29T00:00:00Z",
    },
    "repository",
  );
  addSource(
    items,
    {
      ...pr,
      number: 44,
      url: "https://github.com/example/repo/pull/44",
      state: "MERGED",
      updatedAt: "2026-07-31T00:00:00Z",
    },
    "repository",
  );
  const entries = rankItems(items);
  assert.equal(entries.find((item) => item.number === 42).lifecycle, "new");
  const state = { version: 2, sync: {}, items: {} };
  rememberQueueItems(state, entries, "2026-07-31T12:00:00Z");
  applyAutomaticDone(state, entries, now);

  assert.equal(applyQueueState(entries, state).find((item) => item.number === 42).done, true);
  assert.equal(applyQueueState(entries, state).find((item) => item.number === 43).done, true);
  assert.equal(applyQueueState(entries, state).find((item) => item.number === 44).done, false);

  setQueueItemDone(state, "example/repo#43", false);
  applyAutomaticDone(state, entries, now);
  assert.equal(applyQueueState(entries, state).find((item) => item.number === 43).done, false);
});

test("settings lists are validated before writing", () => {
  assert.deepEqual(
    normalizeSettings({
      username: "me",
      people: ["alice", "alice", "not valid"],
      teams: ["example/platform", "bad"],
    }),
    {
      username: "me",
      people: ["alice"],
      teams: ["example/platform"],
    },
  );
});

test("morning analyses queue from smallest pull request to largest", () => {
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
