import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createInboxStore } from "../inbox/inbox-store.js";

test("review draft comments persist per review slug", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "prc-review-draft-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const store = await createInboxStore({ databasePath: path.join(root, "cockpit.sqlite3") });
  context.after(() => store.close());

  const contextRecord = {
    headSha: "abc123",
    number: "42",
    owner: "acme",
    prUrl: "https://github.com/acme/app/pull/42",
    repo: "app",
    slug: "gh-4-acme-3-app-42",
  };

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
