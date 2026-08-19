import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { useQuery } from "../hooks/use-query.js";
import { lineKey } from "./review-comment-model.js";

const ReviewDraftContext = createContext(null);

export function useReviewDraft() {
  const value = useContext(ReviewDraftContext);
  if (!value) {
    throw new Error("useReviewDraft must be used within ReviewDraftProvider");
  }
  return value;
}

export function ReviewDraftProvider({ children, reviewSlug }) {
  const draftQuery = useQuery({
    queryKey: ["review-draft", reviewSlug],
    enabled: Boolean(reviewSlug),
    queryFn: async ({ queryKey, signal }) => {
      const slug = queryKey[1];
      const response = await fetch(`/api/reviews/${encodeURIComponent(slug)}/draft`, { signal });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload.error || "Review draft could not be loaded.");
      }
      return payload;
    },
  });
  const [snapshot, setSnapshot] = useState(null);
  const [saveError, setSaveError] = useState("");
  const [pendingTarget, setPendingTarget] = useState(null);
  const [composerBody, setComposerBody] = useState("");
  const [summaryBody, setSummaryBody] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!draftQuery.data) return;
    setSnapshot(draftQuery.data);
    setSummaryBody(draftQuery.data.draft?.body || "");
  }, [draftQuery.data]);

  const refresh = draftQuery.refetch;
  const loading = draftQuery.isLoading && !snapshot;
  const error = saveError || draftQuery.error?.message || "";

  const draftComments = snapshot?.draft?.comments || [];
  const threads = snapshot?.threads || [];
  const headStale = Boolean(snapshot?.headStale);
  const canWrite = Boolean(snapshot?.auth?.canWrite);

  const commentIndex = useMemo(() => {
    const index = new Map();
    for (const comment of draftComments) {
      index.set(lineKey(comment), comment);
    }
    for (const thread of threads) {
      if (!thread.path || thread.line == null) continue;
      const key = lineKey({
        line: thread.line,
        path: thread.path,
        side: thread.diffSide || "RIGHT",
      });
      const current = index.get(key);
      index.set(key, current ? { ...current, githubThread: thread } : { githubThread: thread });
    }
    return index;
  }, [draftComments, threads]);

  const openComposer = useCallback(
    (target) => {
      const entry = commentIndex.get(lineKey(target));
      setPendingTarget(target);
      setComposerBody(entry?.body || "");
    },
    [commentIndex],
  );

  const saveComment = useCallback(async () => {
    if (!pendingTarget || !reviewSlug) return;
    const existing = draftComments.find((comment) => lineKey(comment) === lineKey(pendingTarget));
    const entry = commentIndex.get(lineKey(pendingTarget));
    const threadReplyParentId = entry?.githubThread?.comments?.at(-1)?.databaseId;
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
      },
    );
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || "Comment could not be saved.");
    }
    setSnapshot((current) => ({ ...current, draft: payload }));
    setPendingTarget(null);
    setComposerBody("");
  }, [commentIndex, composerBody, draftComments, pendingTarget, reviewSlug]);

  const deleteComment = useCallback(
    async (commentId) => {
      const response = await fetch(
        `/api/reviews/${encodeURIComponent(reviewSlug)}/draft/comments/${encodeURIComponent(commentId)}`,
        { method: "DELETE" },
      );
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || "Comment could not be deleted.");
      }
      setSnapshot((current) => ({ ...current, draft: payload }));
    },
    [reviewSlug],
  );

  const submitReview = useCallback(
    async (event) => {
      setSubmitting(true);
      setSaveError("");
      try {
        if (summaryBody !== snapshot?.draft?.body) {
          const bodyResponse = await fetch(`/api/reviews/${encodeURIComponent(reviewSlug)}/draft`, {
            body: JSON.stringify({ body: summaryBody }),
            headers: { "Content-Type": "application/json" },
            method: "PUT",
          });
          const bodyPayload = await bodyResponse.json();
          if (!bodyResponse.ok) {
            throw new Error(bodyPayload.error || "Review summary could not be saved.");
          }
          setSnapshot((current) => ({ ...current, draft: bodyPayload }));
        }

        const response = await fetch(
          `/api/reviews/${encodeURIComponent(reviewSlug)}/draft/submit`,
          {
            body: JSON.stringify({ body: summaryBody, event }),
            headers: { "Content-Type": "application/json" },
            method: "POST",
          },
        );
        const payload = await response.json();
        if (!response.ok) {
          throw new Error(payload.error || "Review could not be submitted.");
        }
        await refresh();
        if (payload.htmlUrl) {
          window.open(payload.htmlUrl, "_blank", "noopener,noreferrer");
        }
      } catch (submitError) {
        setSaveError(submitError.message);
      } finally {
        setSubmitting(false);
      }
    },
    [refresh, reviewSlug, snapshot?.draft?.body, summaryBody],
  );

  const cancelComposer = useCallback(() => {
    setPendingTarget(null);
    setComposerBody("");
  }, []);

  const activeCommentEntry = pendingTarget ? commentIndex.get(lineKey(pendingTarget)) : null;

  const value = {
    activeCommentEntry,
    canWrite,
    cancelComposer,
    commentIndex,
    composerBody,
    deleteComment,
    draftComments,
    error,
    headStale,
    loading,
    openComposer,
    pendingTarget,
    refresh,
    reviewSlug,
    saveComment,
    setComposerBody,
    setError: setSaveError,
    setSummaryBody,
    snapshot,
    submitting,
    summaryBody,
    threads,
    submitReview,
  };

  return <ReviewDraftContext.Provider value={value}>{children}</ReviewDraftContext.Provider>;
}
