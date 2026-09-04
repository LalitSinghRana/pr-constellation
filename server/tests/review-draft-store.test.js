import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createInboxStore } from "../inbox/inbox-store.js";

const contextRecord = {
  headSha: "abc123",
  number: "42",
  owner: "acme",
  prUrl: "https://github.com/acme/app/pull/42",
  repo: "app",
  slug: "gh-4-acme-3-app-42",
};

test("review draft comments persist per review slug", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "prc-review-draft-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const store = await createInboxStore({ databasePath: path.join(root, "cockpit.sqlite3") });
  context.after(() => store.close());

  const draft = store.ensureReviewDraft(contextRecord);
  assert.equal(draft.comments.length, 0);

  const withComment = store.addReviewDraftComment(contextRecord.slug, {
    body: "Please rename this helper.",
    id: "comment-1",
    line: 18,
    path: "src/app.js",
    side: "RIGHT",
  });
  assert.equal(withComment.comments.length, 1);
  assert.equal(withComment.comments[0].path, "src/app.js");

  const updated = store.updateReviewDraftBody(contextRecord.slug, "Looks good overall.");
  assert.equal(updated.body, "Looks good overall.");

  store.deleteReviewDraft(contextRecord.slug);
  assert.equal(store.readReviewDraft(contextRecord.slug), null);
});

test("addReviewDraftComment upserts the same path line and side instead of inserting twice", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "prc-review-draft-upsert-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const databasePath = path.join(root, "cockpit.sqlite3");
  const store = await createInboxStore({ databasePath });
  context.after(() => store.close());

  store.ensureReviewDraft(contextRecord);

  const first = store.addReviewDraftComment(contextRecord.slug, {
    body: "First note",
    id: "comment-a",
    line: 18,
    path: "src/app.js",
    side: "RIGHT",
  });
  assert.equal(first.comments.length, 1);
  assert.equal(first.comments[0].id, "comment-a");
  assert.equal(first.comments[0].body, "First note");

  const second = store.addReviewDraftComment(contextRecord.slug, {
    body: "Updated note",
    id: "comment-b",
    line: 18,
    path: "src/app.js",
    side: "RIGHT",
  });
  assert.equal(second.comments.length, 1);
  assert.equal(second.comments[0].id, "comment-a");
  assert.equal(second.comments[0].body, "Updated note");
});

test("addReviewDraftComment keeps LEFT and RIGHT comments on the same line separate", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "prc-review-draft-sides-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const store = await createInboxStore({ databasePath: path.join(root, "cockpit.sqlite3") });
  context.after(() => store.close());

  store.ensureReviewDraft(contextRecord);

  store.addReviewDraftComment(contextRecord.slug, {
    body: "Left side",
    id: "comment-left",
    line: 18,
    path: "src/app.js",
    side: "LEFT",
  });
  const bothSides = store.addReviewDraftComment(contextRecord.slug, {
    body: "Right side",
    id: "comment-right",
    line: 18,
    path: "src/app.js",
    side: "RIGHT",
  });

  assert.equal(bothSides.comments.length, 2);
  assert.deepEqual(
    bothSides.comments.map((comment) => ({
      body: comment.body,
      id: comment.id,
      side: comment.side,
    })),
    [
      { body: "Left side", id: "comment-left", side: "LEFT" },
      { body: "Right side", id: "comment-right", side: "RIGHT" },
    ],
  );
});
