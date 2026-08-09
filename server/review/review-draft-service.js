import { randomUUID } from "node:crypto";
import { getInboxStore } from "../inbox/inbox-service.js";
import {
  checkGitHubWriteAccess,
  fetchPullRequestConversation,
  fetchReviewThreads,
  submitPullRequestReview,
} from "./github-review-client.js";
import { loadReviewContext } from "./review-context.js";

export async function getReviewConversation(slug) {
  const context = await loadReviewContext(slug);
  return fetchPullRequestConversation({
    number: context.number,
    owner: context.owner,
    repo: context.repo,
  });
}

export async function getReviewDraftSnapshot(slug) {
  const context = await loadReviewContext(slug);
  const store = await getInboxStore();
  const [auth, github] = await Promise.all([
    checkGitHubWriteAccess(),
    fetchReviewThreads({
      number: context.number,
      owner: context.owner,
      repo: context.repo,
    }),
  ]);
  const headStale = github.headSha !== context.headSha;
  let draft = store.readReviewDraft(slug);
  if (!draft && !headStale) {
    draft = store.ensureReviewDraft(context);
  }
  return {
    auth,
    context: {
      headSha: context.headSha,
      number: context.number,
      owner: context.owner,
      prUrl: context.prUrl,
      repo: context.repo,
      slug: context.slug,
    },
    currentHeadSha: github.headSha,
    draft,
    headStale,
    threads: github.threads,
  };
}

export async function updateReviewDraftBody(slug, body) {
  await assertDraftWritable(slug);
  const store = await getInboxStore();
  return store.updateReviewDraftBody(slug, body);
}

export async function addReviewDraftComment(slug, { body, line, path, replyToCommentId, side }) {
  await assertDraftWritable(slug);
  validateCommentTarget({ body, line, path, side });
  const store = await getInboxStore();
  return store.addReviewDraftComment(slug, {
    body: String(body).trim(),
    id: randomUUID(),
    line,
    path,
    replyToCommentId:
      Number.isInteger(replyToCommentId) && replyToCommentId > 0 ? replyToCommentId : null,
    side,
  });
}

export async function updateReviewDraftComment(slug, commentId, body) {
  await assertDraftWritable(slug);
  if (!String(body || "").trim()) {
    throw new Error("Comment body is required.");
  }
  const store = await getInboxStore();
  return store.updateReviewDraftComment(slug, commentId, String(body).trim());
}

export async function deleteReviewDraftComment(slug, commentId) {
  await assertDraftWritable(slug);
  const store = await getInboxStore();
  return store.deleteReviewDraftComment(slug, commentId);
}

export async function submitReviewDraft(slug, { body, event }) {
  const snapshot = await getReviewDraftSnapshot(slug);
  if (snapshot.headStale) {
    const error = new Error(
      "This pull request has new commits since this review was generated. Re-fetch the PR before submitting.",
    );
    error.code = "HEAD_STALE";
    throw error;
  }
  if (!snapshot.auth.canWrite) {
    const error = new Error(
      snapshot.auth.error ||
        "GitHub token is missing write access. Run `gh auth refresh -s repo` and try again.",
    );
    error.code = "AUTH";
    throw error;
  }
  const store = await getInboxStore();
  const context = await loadReviewContext(slug);
  const draft = snapshot.draft || store.ensureReviewDraft(context);
  const review = await submitPullRequestReview({
    body: typeof body === "string" ? body : draft.body,
    comments: draft.comments,
    event,
    headSha: draft.headSha || context.headSha,
    number: draft.number,
    owner: draft.owner,
    repo: draft.repo,
  });
  store.deleteReviewDraft(slug);
  return {
    htmlUrl: review.html_url,
    state: review.state,
    submittedAt: review.submitted_at,
  };
}

async function assertDraftWritable(slug) {
  const snapshot = await getReviewDraftSnapshot(slug);
  if (snapshot.headStale) {
    const error = new Error(
      "This pull request has new commits since this review was generated. Re-fetch the PR before commenting.",
    );
    error.code = "HEAD_STALE";
    throw error;
  }
  if (!snapshot.draft) {
    const store = await getInboxStore();
    store.ensureReviewDraft(await loadReviewContext(slug));
  }
  return snapshot;
}

function validateCommentTarget({ body, line, path, side }) {
  if (!String(body || "").trim()) {
    throw new Error("Comment body is required.");
  }
  if (typeof path !== "string" || !path.trim()) {
    throw new Error("File path is required.");
  }
  if (!Number.isInteger(line) || line < 1) {
    throw new Error("A valid line number is required.");
  }
  if (side !== "LEFT" && side !== "RIGHT") {
    throw new Error('Comment side must be "LEFT" or "RIGHT".');
  }
}
