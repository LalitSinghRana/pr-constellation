import { GitPullRequest } from "lucide-react";
import { Tabs, TabsList, TabsTrigger } from "../components/ui/tabs.jsx";
import { cn } from "../lib/utils.js";
import { ReviewDraftSheet } from "./review-draft-sheet.jsx";

export function ReviewHeader({ activeTab, onTabChange, review }) {
  return (
    <header className="review-header sticky top-0 z-20 border-b border-border bg-[color-mix(in_oklab,var(--card)_92%,var(--background))] px-5 py-3 shadow-xs backdrop-blur-[20px] max-[980px]:px-3 max-[980px]:py-2.5">
      <div className="review-header-main grid grid-cols-[minmax(0,1fr)_auto] items-center justify-between gap-3.5 max-[980px]:grid-cols-1 max-[980px]:gap-2">
        <div className="review-title-row flex min-w-0 flex-auto items-center gap-2.5 max-[980px]:flex-wrap max-[980px]:gap-2">
          <div
            className={cn(
              "review-eyebrow flex flex-none items-center gap-[7px] text-xs font-bold tracking-[0.08em] text-primary uppercase",
            )}
          >
            <span
              className={cn(
                "review-mark inline-flex size-7 items-center justify-center rounded-md border shadow-xs",
                pullRequestStateClass(review),
              )}
              title={pullRequestStateLabel(review)}
            >
              <GitPullRequest aria-hidden="true" size={16} />
              <span className="sr-only">{pullRequestStateLabel(review)}</span>
            </span>
            <span>{`PR #${review.number || "unknown"}`}</span>
          </div>
          <h1 className="review-title m-0 min-w-[120px] flex-auto truncate font-display text-xl leading-[1.2] font-bold tracking-normal text-foreground max-[980px]:order-2 max-[980px]:basis-full max-[980px]:text-lg [&_a]:no-underline [&_a:hover]:text-primary">
            <a href={review.url}>{review.title || "Untitled pull request"}</a>
          </h1>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
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
