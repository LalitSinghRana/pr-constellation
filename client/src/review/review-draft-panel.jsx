import { createContext, useContext, useEffect, useRef, useState } from "react";
import { useMutation } from "../hooks/use-mutation.js";
import { useQuery } from "../hooks/use-query.js";
import {
  deleteDraftComment,
  saveDraftBody,
  saveDraftComment,
  submitDraftReview,
} from "../lib/review-draft-api.js";
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
  const [dismissedThreadKeys, setDismissedThreadKeys] = useState(() => new Set());
  const [focusedThreadKey, setFocusedThreadKey] = useState(null);
  const replyFocusedRef = useRef(false);

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

  const saveCommentMutation = useMutation({
    mutationFn: async ({
      composerBody: body,
      existing,
      pendingTarget: target,
      threadReplyParentId,
    }) =>
      saveDraftComment({
        reviewSlug,
        existing,
        pendingTarget: target,
        composerBody: body,
        threadReplyParentId,
      }),
    onSuccess: (payload) => {
      setSnapshot((current) => ({ ...current, draft: payload }));
      setPendingTarget(null);
      setComposerBody("");
    },
    onError: (caught) => {
      setSaveError(caught.message);
    },
  });

  const deleteCommentMutation = useMutation({
    mutationFn: (commentId) => deleteDraftComment({ reviewSlug, commentId }),
    onSuccess: (payload) => {
      setSnapshot((current) => ({ ...current, draft: payload }));
    },
    onError: (caught) => {
      setSaveError(caught.message);
    },
  });

  const submitReviewMutation = useMutation({
    mutationFn: async ({ currentDraftBody, event, summaryBody: body }) => {
      if (body !== currentDraftBody) {
        const bodyPayload = await saveDraftBody({ reviewSlug, body });
        setSnapshot((current) => ({ ...current, draft: bodyPayload }));
      }
      return submitDraftReview({ reviewSlug, body, event });
    },
    onSuccess: async (payload) => {
      await refresh();
      if (payload.htmlUrl) {
        window.open(payload.htmlUrl, "_blank", "noopener,noreferrer");
      }
    },
    onError: (caught) => {
      setSaveError(caught.message);
    },
  });

  const commentIndex = (() => {
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
  })();

  function setReplyFocused(focused) {
    replyFocusedRef.current = focused;
  }

  function setFocusedThread(key) {
    if (replyFocusedRef.current) {
      return;
    }
    setFocusedThreadKey((current) => (current === key ? current : key));
  }

  const openThreadKeys = (() => {
    const keys = new Set();
    const activeKey = pendingTarget ? lineKey(pendingTarget) : focusedThreadKey;
    if (activeKey && !dismissedThreadKeys.has(activeKey)) {
      keys.add(activeKey);
    }
    return keys;
  })();

  function openComposer(target) {
    const key = lineKey(target);
    if (pendingTarget && lineKey(pendingTarget) === key && openThreadKeys.has(key)) {
      setDismissedThreadKeys((current) => new Set(current).add(key));
      setFocusedThreadKey((current) => (current === key ? null : current));
      setPendingTarget(null);
      setComposerBody("");
      return;
    }
    const entry = commentIndex.get(key);
    setDismissedThreadKeys((current) => {
      if (!current.has(key)) {
        return current;
      }
      const next = new Set(current);
      next.delete(key);
      return next;
    });
    setFocusedThreadKey(key);
    setPendingTarget(target);
    setComposerBody(entry?.body || "");
  }

  function closeThread(target) {
    const key = lineKey(target);
    setDismissedThreadKeys((current) => new Set(current).add(key));
    setFocusedThreadKey((current) => (current === key ? null : current));
    setPendingTarget((current) => {
      if (!current || lineKey(current) !== key) {
        return current;
      }
      setComposerBody("");
      return null;
    });
  }

  async function saveComment() {
    if (!pendingTarget || !reviewSlug || saveCommentMutation.isPending) {
      return;
    }
    setSaveError("");
    const existing = draftComments.find((comment) => lineKey(comment) === lineKey(pendingTarget));
    const entry = commentIndex.get(lineKey(pendingTarget));
    const threadReplyParentId = entry?.githubThread?.comments?.at(-1)?.databaseId;
    await saveCommentMutation.mutateAsync({
      composerBody,
      existing,
      pendingTarget,
      threadReplyParentId,
    });
  }

  async function deleteComment(commentId) {
    setSaveError("");
    await deleteCommentMutation.mutateAsync(commentId);
  }

  async function submitReview(event) {
    setSaveError("");
    await submitReviewMutation.mutateAsync({
      currentDraftBody: snapshot?.draft?.body,
      event,
      summaryBody,
    });
  }

  function cancelComposer() {
    if (!pendingTarget) {
      setComposerBody("");
      return;
    }
    const entry = commentIndex.get(lineKey(pendingTarget));
    if (entry?.githubThread) {
      setPendingTarget(null);
      setComposerBody("");
      return;
    }
    closeThread(pendingTarget);
  }

  const activeCommentEntry = pendingTarget ? commentIndex.get(lineKey(pendingTarget)) : null;
  const submitting = submitReviewMutation.isPending;

  const value = {
    activeCommentEntry,
    canWrite,
    cancelComposer,
    closeThread,
    commentIndex,
    composerBody,
    dismissedThreadKeys,
    deleteComment,
    draftComments,
    error,
    headStale,
    loading,
    openComposer,
    openThreadKeys,
    pendingTarget,
    refresh,
    reviewSlug,
    saveComment,
    setComposerBody,
    setError: setSaveError,
    setFocusedThread,
    setReplyFocused,
    setSummaryBody,
    snapshot,
    submitting,
    summaryBody,
    threads,
    submitReview,
  };

  return <ReviewDraftContext.Provider value={value}>{children}</ReviewDraftContext.Provider>;
}
