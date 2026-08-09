import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createInboxStore } from "../inbox/inbox-store.js";

test("review conversations persist independently of review runs", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "prc-review-conversation-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const databasePath = path.join(root, "cockpit.sqlite3");
  const conversation = {
    threads: [],
    timeline: [{ actor: "octo", body: "Hello", createdAt: "2026-08-09T12:00:00Z" }],
  };
  const coordinates = { number: 42, owner: "example", repo: "app" };

  const store = await createInboxStore({ databasePath });
  store.saveReviewConversation({ ...coordinates, conversation });
  store.close();

  const reopened = await createInboxStore({ databasePath });
  context.after(() => reopened.close());
  assert.deepEqual(reopened.readReviewConversation(coordinates), conversation);
  assert.equal(reopened.readReviewConversation({ ...coordinates, number: 43 }), null);
});
