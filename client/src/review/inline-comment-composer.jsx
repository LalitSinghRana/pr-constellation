import { X } from "lucide-react";
import { useCallback } from "react";
import { Button } from "../components/ui/button.jsx";

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
