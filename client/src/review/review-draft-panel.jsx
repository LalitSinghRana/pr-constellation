import { MessageSquarePlus, Send, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge } from "../components/ui/badge.jsx";
import { Button } from "../components/ui/button.jsx";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "../components/ui/sheet.jsx";
import { cn } from "../lib/utils.js";
import { lineKey } from "./review-comment-model.js";

const reviewEvents = [
  { event: "COMMENT", label: "Comment" },
  { event: "APPROVE", label: "Approve" },
  { event: "REQUEST_CHANGES", label: "Request changes" },
];

export function ReviewDraftProvider({ children, reviewSlug, showReviewSheet = true }) {
  const [snapshot, setSnapshot] = useState(null);
  const [loading, setLoading] = useState(Boolean(reviewSlug));
  const [error, setError] = useState("");
  const [pendingTarget, setPendingTarget] = useState(null);
  const [composerBody, setComposerBody] = useState("");
  const [summaryBody, setSummaryBody] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const refresh = useCallback(async () => {
    if (!reviewSlug) return;
    setLoading(true);
    setError("");
    try {
      const response = await fetch(`/api/reviews/${encodeURIComponent(reviewSlug)}/draft`);
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || "Review draft could not be loaded.");
      }
      setSnapshot(payload);
      setSummaryBody(payload.draft?.body || "");
    } catch (loadError) {
      setError(loadError.message);
    } finally {
      setLoading(false);
    }
  }, [reviewSlug]);

  useEffect(() => {
    refresh();
  }, [refresh]);

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
      setError("");
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
        setError(submitError.message);
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
    setError,
    snapshot,
    threads,
  };

  return (
    <>
      {children(value)}
      {showReviewSheet ? (
        <ReviewDraftSheet
          canWrite={canWrite}
          draftComments={draftComments}
          error={error}
          headStale={headStale}
          loading={loading}
          onDeleteComment={deleteComment}
          onSubmitReview={submitReview}
          onSummaryChange={setSummaryBody}
          submitting={submitting}
          summaryBody={summaryBody}
          threads={threads}
        />
      ) : null}
    </>
  );
}

function ReviewDraftSheet({
  canWrite,
  draftComments,
  error,
  headStale,
  loading,
  onDeleteComment,
  onSubmitReview,
  onSummaryChange,
  submitting,
  summaryBody,
  threads,
}) {
  return (
    <Sheet>
      <SheetTrigger asChild>
        <Button
          className="review-draft-trigger fixed top-[4.75rem] right-4 z-30 gap-2 shadow-md"
          type="button"
          variant="outline"
        >
          <MessageSquarePlus aria-hidden="true" size={16} />
          Review
          {draftComments.length > 0 ? (
            <Badge className="ml-1" variant="secondary">
              {draftComments.length}
            </Badge>
          ) : null}
        </Button>
      </SheetTrigger>
      <SheetContent className="w-full gap-0 overflow-hidden p-0 sm:max-w-md">
        <SheetHeader className="border-b border-border p-4">
          <SheetTitle>GitHub review draft</SheetTitle>
          <SheetDescription>
            Comments stay local until you submit the full review to GitHub.
          </SheetDescription>
        </SheetHeader>
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
          {loading ? <p className="text-sm text-muted-foreground">Loading review draft…</p> : null}
          {headStale ? (
            <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              This pull request has new commits since this review was generated. Re-fetch the PR
              before submitting comments.
            </p>
          ) : null}
          {!canWrite ? (
            <p className="rounded-md border border-border bg-muted px-3 py-2 text-sm text-muted-foreground">
              GitHub write access is required. Run <code>gh auth refresh -s repo</code> if needed.
            </p>
          ) : null}
          {error ? (
            <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </p>
          ) : null}

          <section className="grid gap-2">
            <h2 className="text-sm font-semibold text-foreground">Draft comments</h2>
            {draftComments.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Click a diff line in the review tree to add a comment.
              </p>
            ) : (
              <ul className="grid gap-2">
                {draftComments.map((comment) => (
                  <li
                    className="rounded-md border border-border bg-card p-3 text-sm"
                    key={comment.id}
                  >
                    <div className="mb-2 flex items-start justify-between gap-2">
                      <code className="text-xs text-muted-foreground">
                        {comment.path}:{comment.line}
                      </code>
                      <Button
                        aria-label="Delete draft comment"
                        onClick={() => onDeleteComment(comment.id)}
                        size="icon-sm"
                        type="button"
                        variant="ghost"
                      >
                        <Trash2 size={14} />
                      </Button>
                    </div>
                    <p className="whitespace-pre-wrap text-foreground">{comment.body}</p>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="grid gap-2">
            <h2 className="text-sm font-semibold text-foreground">Existing GitHub threads</h2>
            {threads.length === 0 ? (
              <p className="text-sm text-muted-foreground">No review threads on GitHub yet.</p>
            ) : (
              <ul className="grid gap-2">
                {threads.map((thread) => (
                  <li
                    className={cn(
                      "rounded-md border bg-card p-3 text-sm",
                      thread.isResolved ? "border-border/70 opacity-80" : "border-primary/30",
                    )}
                    key={`${thread.path}:${thread.line}:${thread.comments[0]?.createdAt}`}
                  >
                    <code className="text-xs text-muted-foreground">
                      {thread.path}:{thread.line}
                      {thread.isOutdated ? " · outdated" : ""}
                      {thread.isResolved ? " · resolved" : ""}
                    </code>
                    {thread.comments.map((comment) => (
                      <div className="mt-2 grid gap-1" key={comment.url || comment.createdAt}>
                        <p className="text-xs font-medium text-muted-foreground">
                          {comment.authorLogin || "unknown"}
                        </p>
                        <p className="whitespace-pre-wrap text-foreground">{comment.body}</p>
                      </div>
                    ))}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="grid gap-2">
            <label className="text-sm font-semibold text-foreground" htmlFor="review-summary">
              Review summary
            </label>
            <textarea
              className="min-h-24 w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
              id="review-summary"
              onChange={(event) => onSummaryChange(event.target.value)}
              placeholder="Optional overall review comment…"
              value={summaryBody}
            />
          </section>
        </div>
        <div className="grid gap-2 border-t border-border p-4">
          {reviewEvents.map(({ event, label }) => (
            <Button
              className="justify-between"
              disabled={headStale || !canWrite || submitting}
              key={event}
              onClick={() => onSubmitReview(event)}
              type="button"
              variant={event === "APPROVE" ? "default" : "outline"}
            >
              <span>{label}</span>
              <Send size={14} />
            </Button>
          ))}
        </div>
      </SheetContent>
    </Sheet>
  );
}

export function InlineCommentComposer({
  activeEntry,
  body,
  headStale,
  onBodyChange,
  onCancel,
  onSave,
  target,
}) {
  const focusTextarea = useCallback((element) => {
    if (element) {
      element.focus();
    }
  }, []);
  const githubThread = activeEntry?.githubThread;
  const isReply = Boolean(githubThread);
  const canSaveDraft = Boolean(body.trim()) && !headStale;

  const handleDraftShortcut = useCallback(
    (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key === "Enter" && canSaveDraft) {
        event.preventDefault();
        event.stopPropagation();
        onSave();
      }
    },
    [canSaveDraft, onSave],
  );

  if (!target) {
    return null;
  }

  return (
    <div className="relative border border-primary/25 bg-[color-mix(in_oklab,var(--card)_94%,var(--primary))] px-3 py-3 shadow-[0_18px_40px_color-mix(in_oklab,black_34%,transparent),0_0_0_1px_color-mix(in_oklab,var(--primary)_28%,transparent)]">
      <Button
        aria-label="Close comment composer"
        className="absolute top-2 right-2"
        onClick={(event) => {
          event.stopPropagation();
          onCancel();
        }}
        onMouseDown={(event) => event.stopPropagation()}
        size="icon-sm"
        type="button"
        variant="ghost"
      >
        <X size={14} />
      </Button>
      {githubThread ? (
        <div className="mb-3 grid gap-3 pr-8">
          {githubThread.comments.map((comment) => (
            <div className="grid gap-1" key={comment.url || comment.createdAt}>
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0 text-xs">
                <span className="font-medium text-foreground">
                  {comment.authorLogin || "unknown"}
                </span>
                {comment.url ? (
                  <a
                    className="text-muted-foreground hover:text-primary hover:underline"
                    href={comment.url}
                    onClick={(event) => event.stopPropagation()}
                    onMouseDown={(event) => event.stopPropagation()}
                    rel="noreferrer"
                    target="_blank"
                  >
                    {formatReviewCommentTimestamp(comment.createdAt)}
                  </a>
                ) : (
                  <span className="text-muted-foreground">
                    {formatReviewCommentTimestamp(comment.createdAt)}
                  </span>
                )}
              </div>
              <p className="whitespace-pre-wrap text-sm text-foreground">{comment.body}</p>
            </div>
          ))}
        </div>
      ) : null}
      <textarea
        className="min-h-24 w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onChange={(event) => onBodyChange(event.target.value)}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={handleDraftShortcut}
        onMouseDown={(event) => event.stopPropagation()}
        placeholder={isReply ? "Reply…" : "Leave a review comment for GitHub…"}
        ref={focusTextarea}
        value={body}
      />
      <div className="mt-2 flex justify-end gap-2">
        <Button
          onClick={(event) => {
            event.stopPropagation();
            onCancel();
          }}
          onMouseDown={(event) => event.stopPropagation()}
          type="button"
          variant="ghost"
        >
          Cancel
        </Button>
        <Button
          disabled={!canSaveDraft}
          onClick={(event) => {
            event.stopPropagation();
            onSave();
          }}
          onMouseDown={(event) => event.stopPropagation()}
          type="button"
        >
          Draft
        </Button>
      </div>
    </div>
  );
}

function formatReviewCommentTimestamp(createdAt) {
  if (!createdAt) {
    return "View on GitHub";
  }
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) {
    return "View on GitHub";
  }
  return date.toLocaleString(undefined, {
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    month: "short",
  });
}
