import assert from "node:assert/strict";
import test from "node:test";
import { cacheReviewConversations } from "../inbox/inbox-service.js";

test("conversation cache refreshes each queue PR once", async () => {
  const fetched = [];
  const saved = [];
  const result = await cacheReviewConversations(
    [
      { id: "example/app#42", number: 42, repository: "example/app" },
      { id: "example/app#42", number: 42, repository: "example/app" },
      { id: "notification:1", kind: "notification", repository: "example/app" },
    ],
    {
      fetchConversation: async (coordinates) => {
        fetched.push(coordinates);
        return { threads: [], timeline: [] };
      },
      store: {
        readReviewConversation() {
          return null;
        },
        saveReviewConversation(value) {
          saved.push(value);
        },
      },
    },
  );

  assert.deepEqual(result, { cached: 1, warnings: [] });
  assert.deepEqual(fetched, [{ number: 42, owner: "example", repo: "app" }]);
  assert.equal(saved.length, 1);
});

test("conversation cache skips unchanged pull requests with a stored document", async () => {
  const fetched = [];
  const result = await cacheReviewConversations(
    [{ id: "example/app#42", number: 42, repository: "example/app" }],
    {
      fetchConversation: async (coordinates) => {
        fetched.push(coordinates);
        return { threads: [], timeline: [] };
      },
      refreshIds: new Set(),
      store: {
        readReviewConversation() {
          return { threads: [], timeline: [] };
        },
        saveReviewConversation() {
          throw new Error("unchanged conversations should not be rewritten");
        },
      },
    },
  );

  assert.deepEqual(result, { cached: 0, warnings: [] });
  assert.deepEqual(fetched, []);
});

test("conversation cache refetches when the pull request change token moved", async () => {
  const fetched = [];
  const result = await cacheReviewConversations(
    [{ id: "example/app#42", number: 42, repository: "example/app" }],
    {
      fetchConversation: async (coordinates) => {
        fetched.push(coordinates);
        return { threads: [{ path: "src/app.js", comments: [] }], timeline: [] };
      },
      refreshIds: new Set(["example/app#42"]),
      store: {
        readReviewConversation() {
          return { threads: [], timeline: [] };
        },
        saveReviewConversation() {},
      },
    },
  );

  assert.deepEqual(result, { cached: 1, warnings: [] });
  assert.deepEqual(fetched, [{ number: 42, owner: "example", repo: "app" }]);
});

test("conversation cache leaves the queue available when GitHub fails", async () => {
  const result = await cacheReviewConversations(
    [{ id: "example/app#42", number: 42, repository: "example/app" }],
    {
      fetchConversation: async () => {
        throw new Error("GitHub is unavailable");
      },
      store: {
        readReviewConversation() {
          return null;
        },
        saveReviewConversation() {},
      },
    },
  );

  assert.deepEqual(result, {
    cached: 0,
    warnings: ["Some pull request conversations could not be cached."],
  });
});
