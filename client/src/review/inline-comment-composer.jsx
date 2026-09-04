import { X } from "lucide-react";
import { useEffect, useRef } from "react";
import { Badge } from "../components/ui/badge.jsx";
import { Button } from "../components/ui/button.jsx";
import { GitHubMarkdown } from "./github-markdown.jsx";
import { lineKey } from "./review-comment-model.js";
import { useReviewDraft } from "./review-draft-panel.jsx";
import { bindWheelScrollPassthrough } from "./wheel-event.js";

export function InlineCommentComposer({ target }) {
  const {
    canWrite,
    cancelComposer,
    closeThread,
    commentIndex,
    composerBody,
    headStale,
    openComposer,
    pendingTarget,
    saveComment,
    setComposerBody,
    setError,
    setReplyFocused,
  } = useReviewDraft();
  const textareaRef = useRef(null);
  const threadListRef = useRef(null);
  const panelRef = useRef(null);
  function focusTextarea(element) {
    textareaRef.current = element;
    if (element) {
      element.focus();
      setReplyFocused(true);
    }
  }
  useEffect(
    () =>
      bindWheelScrollPassthrough(
        () => [threadListRef.current, textareaRef.current],
        () => panelRef.current,
      ),
    [],
  );
  useEffect(() => {
    return () => setReplyFocused(false);
  }, [setReplyFocused]);
  const entry = commentIndex.get(lineKey(target));
  const githubThread = entry?.githubThread;
  const draftBody = typeof entry?.body === "string" ? entry.body.trim() : "";
  const hasDraft = Boolean(draftBody);
  const isActiveReply = Boolean(pendingTarget && lineKey(pendingTarget) === lineKey(target));
  const isReply = Boolean(githubThread);
  const canSaveDraft = Boolean(composerBody.trim()) && !headStale && isActiveReply;

  function handleDraftShortcut(event) {
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter" && canSaveDraft) {
      event.preventDefault();
      event.stopPropagation();
      saveComment().catch((saveError) => setError(saveError.message));
    }
  }

  if (!target) {
    return null;
  }

  return (
    <div
      className="relative flex max-h-[inherit] min-h-0 flex-col overflow-hidden border border-primary/25 bg-[color-mix(in_oklab,var(--card)_94%,var(--primary))] px-3 py-3 shadow-[0_18px_40px_color-mix(in_oklab,black_34%,transparent),0_0_0_1px_color-mix(in_oklab,var(--primary)_28%,transparent)]"
      ref={panelRef}
    >
      <Button
        aria-label="Close comment composer"
        className="absolute top-2 right-2 z-10"
        onClick={(event) => {
          event.stopPropagation();
          if (githubThread || hasDraft) {
            closeThread(target);
          } else {
            cancelComposer();
          }
        }}
        onMouseDown={(event) => event.stopPropagation()}
        size="icon-sm"
        type="button"
        variant="ghost"
      >
        <X size={14} />
      </Button>
      {githubThread || (hasDraft && !isActiveReply) ? (
        <div
          className="mb-3 grid max-h-48 gap-3 overflow-y-auto overscroll-contain pr-8"
          ref={threadListRef}
        >
          {githubThread ? (
            <>
              <div className="flex flex-wrap gap-1">
                {githubThread.isResolved ? <Badge variant="secondary">Resolved</Badge> : null}
                {githubThread.isOutdated ? <Badge variant="outline">Outdated</Badge> : null}
              </div>
              {githubThread.comments.map((comment) => (
                <div className="grid gap-1" key={comment.url || comment.createdAt}>
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-0 text-xs">
                    {comment.avatarUrl ? (
                      <img alt="" className="size-5 rounded-full" src={comment.avatarUrl} />
                    ) : null}
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
                  <GitHubMarkdown
                    body={comment.body}
                    className="text-sm font-normal leading-normal"
                  />
                </div>
              ))}
            </>
          ) : null}
          {hasDraft && !isActiveReply ? (
            <div className="grid gap-1">
              <Badge variant="secondary">Draft</Badge>
              <GitHubMarkdown body={draftBody} className="text-sm font-normal leading-normal" />
            </div>
          ) : null}
        </div>
      ) : null}
      {!isActiveReply && (githubThread || hasDraft) ? (
        <div className="flex shrink-0 justify-end">
          <Button
            disabled={headStale || !canWrite}
            onClick={(event) => {
              event.stopPropagation();
              openComposer(target);
            }}
            onMouseDown={(event) => event.stopPropagation()}
            type="button"
          >
            {hasDraft ? "Edit" : "Reply"}
          </Button>
        </div>
      ) : null}
      {isActiveReply ? (
        <>
          <textarea
            className="min-h-16 max-h-32 w-full shrink-0 resize-y rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
            rows={2}
            onBlur={() => setReplyFocused(false)}
            onChange={(event) => setComposerBody(event.target.value)}
            onClick={(event) => event.stopPropagation()}
            onFocus={() => setReplyFocused(true)}
            onKeyDown={handleDraftShortcut}
            onMouseDown={(event) => event.stopPropagation()}
            placeholder={isReply ? "Reply…" : "Leave a review comment for GitHub…"}
            ref={focusTextarea}
            value={composerBody}
          />
          <div className="mt-2 flex shrink-0 justify-end gap-2">
            <Button
              onClick={(event) => {
                event.stopPropagation();
                cancelComposer();
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
                saveComment().catch((saveError) => setError(saveError.message));
              }}
              onMouseDown={(event) => event.stopPropagation()}
              type="button"
            >
              Draft
            </Button>
          </div>
        </>
      ) : null}
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
