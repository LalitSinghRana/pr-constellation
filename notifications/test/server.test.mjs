import assert from "node:assert/strict";
import test from "node:test";
import {
  addSignal,
  addSource,
  findReviewReply,
  normalizeSettings,
  otherNotificationFromThread,
  prFromNotification,
  rankItems,
  summarizeActivity,
  trackedPrs,
} from "../server.mjs";

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

test("my pull requests get their own lifecycle and unread activity score", () => {
  const items = new Map();
  addSource(items, pr, "authored");
  addSignal(items, pr, "my-pr-activity");

  const [mine] = rankItems(items);
  assert.equal(mine.lifecycle, "mine");
  assert.equal(mine.score, 5);
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

test("a later reply to my REST review comment needs attention", () => {
  const comments = [
    {
      id: 10,
      in_reply_to_id: null,
      created_at: "2026-07-01T10:00:00Z",
      user: { login: "me" },
    },
    {
      id: 11,
      in_reply_to_id: 10,
      created_at: "2026-07-01T11:00:00Z",
      user: { login: "alice" },
    },
  ];

  assert.equal(findReviewReply(comments, "me")?.id, 11);
  comments.push({
    id: 12,
    in_reply_to_id: 10,
    created_at: "2026-07-01T12:00:00Z",
    user: { login: "me" },
  });
  assert.equal(findReviewReply(comments, "me"), null);
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
  assert.equal(otherNotificationFromThread(issue).url, "https://github.com/example/repo/issues/7");
});

test("search results cannot resurrect dismissed notifications", () => {
  const items = new Map();
  addSource(items, pr, "notification");
  const dismissed = {
    ...pr,
    number: 43,
    id: "PR_2",
    url: "https://github.com/example/repo/pull/43",
  };

  assert.deepEqual(
    trackedPrs(items, [pr, dismissed]).map((item) => item.number),
    [42],
  );
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
