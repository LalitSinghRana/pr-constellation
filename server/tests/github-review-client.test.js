import assert from "node:assert/strict";
import test from "node:test";
import {
  buildReviewComments,
  fetchPullRequestConversation,
  fetchReviewThreads,
  submitPullRequestReview,
} from "../review/github-review-client.js";

test("fetchPullRequestConversation normalizes timeline items and review threads", async () => {
  const conversation = await fetchPullRequestConversation({
    number: 16,
    owner: "acme",
    repo: "app",
    runGh: async () => ({
      data: {
        repository: {
          pullRequest: {
            reviewThreads: { nodes: [{ line: 4, path: "src/app.js", comments: { nodes: [] } }] },
            timelineItems: {
              nodes: [
                {
                  __typename: "IssueComment",
                  author: { login: "octo" },
                  body: "hello",
                  createdAt: "now",
                  databaseId: 1,
                },
              ],
            },
          },
        },
      },
    }),
  });

  assert.deepEqual(conversation.timeline, [
    {
      actor: "octo",
      avatarUrl: "",
      body: "hello",
      createdAt: "now",
      id: 1,
      kind: "comment",
      type: "IssueComment",
      url: "",
    },
  ]);
  assert.equal(conversation.threads[0].path, "src/app.js");
});

test("fetchReviewThreads keeps comment avatars", async () => {
  const result = await fetchReviewThreads({
    number: 16,
    owner: "acme",
    repo: "app",
    runGh: async (args) => {
      assert.match(args.join("\n"), /avatarUrl/);
      return {
        data: {
          repository: {
            pullRequest: {
              headRefOid: "abc",
              reviewThreads: {
                nodes: [
                  {
                    diffSide: "RIGHT",
                    line: 4,
                    path: "src/app.js",
                    comments: {
                      nodes: [
                        {
                          author: {
                            avatarUrl: "https://avatars.githubusercontent.com/u/1",
                            login: "octo",
                          },
                          body: "note",
                          createdAt: "now",
                          databaseId: 9,
                          url: "https://example.com/r",
                        },
                      ],
                    },
                  },
                ],
              },
            },
          },
        },
      };
    },
  });

  assert.equal(result.threads[0].comments[0].authorLogin, "octo");
  assert.equal(
    result.threads[0].comments[0].avatarUrl,
    "https://avatars.githubusercontent.com/u/1",
  );
});

test("buildReviewComments maps draft comments to GitHub line/side payloads", () => {
  assert.deepEqual(
    buildReviewComments([
      { body: " left note ", line: 10, path: " src/app.js ", side: "left" },
      { body: "right note", line: 12, path: "src/app.js", side: "RIGHT" },
    ]),
    [
      { body: "left note", line: 10, path: "src/app.js", side: "LEFT" },
      { body: "right note", line: 12, path: "src/app.js", side: "RIGHT" },
    ],
  );
});

test("buildReviewComments rejects incomplete draft comments", () => {
  assert.throws(
    () => buildReviewComments([{ body: "missing line", path: "src/app.js", side: "RIGHT" }]),
    /invalid line number/,
  );
  assert.throws(
    () => buildReviewComments([{ body: "bad side", line: 3, path: "src/app.js", side: "BOTH" }]),
    /LEFT" or "RIGHT"/,
  );
});

test("submitPullRequestReview posts a one-shot line/side review payload", async () => {
  const calls = [];
  const runGh = async (args, options = {}) => {
    calls.push({ args, input: options.input || null });
    if (args[0] === "api" && args[1]?.includes("/reviews?") && !args.includes("--method")) {
      return [{ id: 99, state: "PENDING" }];
    }
    if (args.includes("DELETE")) {
      return { id: 99, state: "PENDING" };
    }
    return {
      html_url: "https://github.com/acme/app/pull/16#pullrequestreview-1",
      state: "COMMENTED",
      submitted_at: "2026-08-07T00:00:00Z",
    };
  };

  const review = await submitPullRequestReview({
    body: "  ",
    comments: [
      { body: "please rename", line: 690, path: "server/inbox/inbox-service.js", side: "LEFT" },
    ],
    event: "COMMENT",
    headSha: "abc123",
    number: 16,
    owner: "acme",
    repo: "app",
    runGh,
  });

  assert.equal(review.state, "COMMENTED");
  assert.equal(calls.length, 3);
  assert.match(calls[0].args[1], /\/reviews\?per_page=100$/);
  assert.deepEqual(calls[1].args.slice(0, 3), ["api", "--method", "DELETE"]);

  const submitCall = calls[2];
  assert.deepEqual(submitCall.args, [
    "api",
    "--method",
    "POST",
    "repos/acme/app/pulls/16/reviews",
    "--input",
    "-",
  ]);
  assert.deepEqual(JSON.parse(submitCall.input), {
    comments: [
      {
        body: "please rename",
        line: 690,
        path: "server/inbox/inbox-service.js",
        side: "LEFT",
      },
    ],
    commit_id: "abc123",
    event: "COMMENT",
  });
});

test("submitPullRequestReview requires a summary when there are no comments", async () => {
  await assert.rejects(
    () =>
      submitPullRequestReview({
        body: "",
        comments: [],
        event: "COMMENT",
        headSha: "abc123",
        number: 16,
        owner: "acme",
        repo: "app",
        runGh: async () => {
          throw new Error("should not call GitHub");
        },
      }),
    /review summary is required/i,
  );
});
