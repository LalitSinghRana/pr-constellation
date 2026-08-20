import { MessageSquarePlus, Send, Trash2 } from "lucide-react";
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
import { useReviewDraft } from "./review-draft-panel.jsx";

const reviewEvents = [
  { event: "COMMENT", label: "Comment" },
  { event: "APPROVE", label: "Approve" },
  { event: "REQUEST_CHANGES", label: "Request changes" },
];

export function ReviewDraftSheet() {
  const {
    canWrite,
    deleteComment,
    draftComments,
    error,
    headStale,
    loading,
    setSummaryBody,
    submitReview,
    submitting,
    summaryBody,
  } = useReviewDraft();

  return (
    <Sheet>
      <SheetTrigger asChild>
        <Button className="review-draft-trigger gap-2" type="button" variant="outline">
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
                        onClick={() => deleteComment(comment.id)}
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
            <label className="text-sm font-semibold text-foreground" htmlFor="review-summary">
              Review summary
            </label>
            <textarea
              className="min-h-24 w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
              id="review-summary"
              onChange={(event) => setSummaryBody(event.target.value)}
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
              onClick={() => submitReview(event)}
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
