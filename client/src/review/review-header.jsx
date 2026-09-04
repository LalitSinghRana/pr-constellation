import { GitPullRequest } from "lucide-react";
import { MiddleEllipsis } from "../components/ui/middle-ellipsis/index.js";
import { Tabs, TabsList, TabsTrigger } from "../components/ui/tabs.jsx";
import { cn } from "../lib/utils.js";
import { ReviewDraftSheet } from "./review-draft-sheet.jsx";

export function ReviewHeader({ activeTab, onTabChange, review }) {
  return (
    <header className="sticky top-0 z-20 border-b border-border bg-[color-mix(in_oklab,var(--card)_92%,var(--background))] px-5 py-3 shadow-xs backdrop-blur-[20px] max-[980px]:px-3 max-[980px]:py-2.5">
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center justify-between gap-8">
        <div className="flex min-w-0 items-center gap-2.5">
          <div
            className={cn(
              "flex flex-none items-center gap-[7px] text-xs font-bold tracking-[0.08em] text-primary uppercase",
            )}
          >
            <span
              className={cn(
                "inline-flex size-7 items-center justify-center rounded-md border shadow-xs",
                pullRequestStateClass(review),
              )}
              title={pullRequestStateLabel(review)}
            >
              <GitPullRequest aria-hidden="true" size={16} />
              <span className="sr-only">{pullRequestStateLabel(review)}</span>
            </span>
            <span>{`PR #${review.number || "unknown"}`}</span>
          </div>
          <h1 className="relative m-0 min-w-0 flex-1 overflow-hidden font-display text-xl leading-[1.2] font-bold tracking-normal whitespace-nowrap text-foreground">
            <a
              className="block min-w-0 no-underline hover:text-primary"
              href={review.url}
              title={review.title || "Untitled pull request"}
            >
              <MiddleEllipsis.Span className="block min-w-0">
                {review.title || "Untitled pull request"}
              </MiddleEllipsis.Span>
            </a>
          </h1>
        </div>
        <div className="flex shrink-0 flex-nowrap items-center justify-end gap-2">
          <Tabs onValueChange={onTabChange} value={activeTab}>
            <TabsList aria-label="Review content">
              <TabsTrigger value="conversation">Conversation</TabsTrigger>
              <TabsTrigger value="trees">Review trees</TabsTrigger>
            </TabsList>
          </Tabs>
          <ReviewDraftSheet />
        </div>
      </div>
    </header>
  );
}

function pullRequestStateClass(review) {
  const state = String(review?.state || "").toUpperCase();
  if (state === "MERGED") {
    return "border-pr-merged/40 bg-pr-merged/15 text-pr-merged";
  }
  if (state === "CLOSED") {
    return "border-pr-closed/40 bg-pr-closed/15 text-pr-closed";
  }
  if (state === "DRAFT" || review?.isDraft) {
    return "border-pr-draft/40 bg-pr-draft/15 text-pr-draft";
  }
  return "border-pr-open/40 bg-pr-open/15 text-pr-open";
}

function pullRequestStateLabel(review) {
  const state = String(review?.state || "").toUpperCase();
  if (state === "MERGED") return "Merged pull request";
  if (state === "CLOSED") return "Closed pull request";
  if (state === "DRAFT" || review?.isDraft) return "Draft pull request";
  return "Open pull request";
}
