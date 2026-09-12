import { readJson } from "../hooks/use-query.js";

export async function saveDraftComment({
  reviewSlug,
  existing,
  pendingTarget,
  composerBody,
  threadReplyParentId,
  signal,
}) {
  const response = await fetch(
    existing
      ? `/api/reviews/${encodeURIComponent(reviewSlug)}/draft/comments/${encodeURIComponent(existing.id)}`
      : `/api/reviews/${encodeURIComponent(reviewSlug)}/draft/comments`,
    {
      body: JSON.stringify(
        existing
          ? { body: composerBody }
          : {
              body: composerBody,
              line: pendingTarget.line,
              path: pendingTarget.path,
              side: pendingTarget.side,
              ...(threadReplyParentId ? { replyToCommentId: threadReplyParentId } : {}),
            },
      ),
      headers: { "Content-Type": "application/json" },
      method: existing ? "PUT" : "POST",
      signal,
    },
  );
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "Comment could not be saved.");
  return payload;
}

export async function deleteDraftComment({ reviewSlug, commentId, signal }) {
  const response = await fetch(
    `/api/reviews/${encodeURIComponent(reviewSlug)}/draft/comments/${encodeURIComponent(commentId)}`,
    { method: "DELETE", signal },
  );
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "Comment could not be deleted.");
  return payload;
}

export async function saveDraftBody({ reviewSlug, body, signal }) {
  const response = await fetch(`/api/reviews/${encodeURIComponent(reviewSlug)}/draft`, {
    body: JSON.stringify({ body }),
    headers: { "Content-Type": "application/json" },
    method: "PUT",
    signal,
  });
  return readJson(response);
}

export async function submitDraftReview({ reviewSlug, body, event, signal }) {
  const response = await fetch(`/api/reviews/${encodeURIComponent(reviewSlug)}/draft/submit`, {
    body: JSON.stringify({ body, event }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
    signal,
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "Review could not be submitted.");
  return payload;
}
