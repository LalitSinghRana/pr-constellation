import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { mock, test } from "node:test";
import { createInboxStore } from "../inbox/inbox-store.js";

const slug = "gh-4-acme-3-app-42";
const analysisHead = "abc123analysis";
const liveHead = "def456live";
const contextRecord = {
  headSha: analysisHead,
  metadata: {},
  number: 42,
  owner: "acme",
  prUrl: "https://github.com/acme/app/pull/42",
  repo: "app",
  runId: "run-1",
  slug,
};

test("draft snapshot, comments, and submit stay allowed when GitHub HEAD moved ahead", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "prc-review-draft-service-"));
  const store = await createInboxStore({ databasePath: path.join(root, "cockpit.sqlite3") });
  let submittedReview = null;

  t.after(async () => {
    mock.reset();
    store.close();
    await rm(root, { recursive: true, force: true });
  });

  mock.module("../inbox/inbox-service.js", {
    namedExports: {
      getInboxStore: async () => store,
    },
  });
  mock.module("../review/review-context.js", {
    namedExports: {
      loadReviewContext: async () => ({ ...contextRecord }),
    },
  });
  mock.module("../review/github-review-client.js", {
    namedExports: {
      checkGitHubWriteAccess: async () => ({ canWrite: true, ok: true, scopes: ["repo"] }),
      fetchPullRequestConversation: async () => ({ timeline: [], threads: [] }),
      fetchReviewThreads: async () => ({ headSha: liveHead, threads: [] }),
      submitPullRequestReview: async (payload) => {
        submittedReview = payload;
        return {
          html_url: "https://github.com/acme/app/pull/42#pullrequestreview-1",
          state: "APPROVED",
          submitted_at: "2026-01-01T00:00:00Z",
        };
      },
    },
  });

  const { addReviewDraftComment, getReviewDraftSnapshot, submitReviewDraft } = await import(
    "../review/review-draft-service.js"
  );

  const snapshot = await getReviewDraftSnapshot(slug);
  assert.equal(snapshot.headStale, true);
  assert.equal(snapshot.context.headSha, analysisHead);
  assert.equal(snapshot.currentHeadSha, liveHead);
  assert.ok(snapshot.draft);
  assert.equal(snapshot.draft.headSha, analysisHead);

  const withComment = await addReviewDraftComment(slug, {
    body: "Looks good",
    line: 10,
    path: "src/app.js",
    side: "RIGHT",
  });
  assert.equal(withComment.comments.length, 1);

  const result = await submitReviewDraft(slug, { body: "", event: "APPROVE" });
  assert.equal(result.state, "APPROVED");
  assert.equal(submittedReview.headSha, analysisHead);
  assert.equal(submittedReview.event, "APPROVE");
});
