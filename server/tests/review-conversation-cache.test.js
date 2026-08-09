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

test("conversation cache leaves the queue available when GitHub fails", async () => {
  const result = await cacheReviewConversations(
    [{ id: "example/app#42", number: 42, repository: "example/app" }],
    {
      fetchConversation: async () => {
        throw new Error("GitHub is unavailable");
      },
      store: { saveReviewConversation() {} },
    },
  );

  assert.deepEqual(result, {
    cached: 0,
    warnings: ["Some pull request conversations could not be cached."],
  });
});
