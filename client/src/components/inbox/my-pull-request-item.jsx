import {
  ActivityHoverCard,
  activityUpdates,
  titleClassName,
} from "@/components/inbox/inbox-activity.jsx";
import { InboxAnalysisActions } from "@/components/inbox/inbox-analysis-actions.jsx";
import { Badge } from "@/components/ui/badge.jsx";
import { Item, itemListRowClassName } from "@/components/ui/item.jsx";
import { myPullRequestStatus, relativeTime, safeGitHubUrl } from "@/lib/queue.js";
import { cn } from "@/lib/utils.js";
import { LIFECYCLE_STYLES } from "./config.jsx";

const myPrStatuses = {
  draft: { label: "Draft", className: LIFECYCLE_STYLES.draft },
  opened: { label: "Opened", className: LIFECYCLE_STYLES.new },
  approved: { label: "Approved", className: LIFECYCLE_STYLES.approved },
  merged: { label: "Merged", className: LIFECYCLE_STYLES.merged },
  closed: { label: "Closed", className: LIFECYCLE_STYLES.closed },
};

export function MyPullRequestItem({
  analysis,
  analysisBusy,
  completed,
  Heading,
  item,
  onAnalyze,
  onMarkRead,
  onPrioritize,
  prioritizeBusy,
}) {
  const myPrStatus = myPrStatuses[myPullRequestStatus(item)];
  return (
    <ActivityHoverCard updates={activityUpdates(item)} since={item.changesSince}>
      <Item
        asChild
        className={cn(
          itemListRowClassName,
          item.read && !item.hasUnreadUpdates && "opacity-60 hover:opacity-80",
          completed && "opacity-60",
        )}
      >
        <article>
          <Item.Media className="w-20">
            <Badge
              aria-label={`Pull request status ${myPrStatus.label}`}
              className={cn(
                "h-8 min-w-16 justify-center rounded-full px-2 text-xs font-semibold",
                myPrStatus.className,
              )}
              variant="outline"
            >
              {myPrStatus.label}
            </Badge>
          </Item.Media>
          <Item.Content className="min-w-0 gap-0">
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span className="font-semibold text-foreground/65">#{item.number}</span>
            </div>
            <Heading className={cn("mt-1.5", titleClassName)}>
              <a
                className="decoration-primary/35 underline-offset-4 hover:underline"
                href={safeGitHubUrl(item.actionUrl)}
                target="_blank"
                rel="noreferrer"
                onClick={() => onMarkRead(item)}
              >
                {item.title}
              </a>
            </Heading>
            <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
              <span>updated {relativeTime(item.updatedAt)}</span>
            </div>
          </Item.Content>
          <Item.Actions className="ml-20 basis-full md:ml-auto md:basis-auto">
            <InboxAnalysisActions
              analysis={analysis}
              analysisBusy={analysisBusy}
              item={item}
              onAnalyze={onAnalyze}
              onMarkRead={onMarkRead}
              onPrioritize={onPrioritize}
              prioritizeBusy={prioritizeBusy}
            />
          </Item.Actions>
        </article>
      </Item>
    </ActivityHoverCard>
  );
}
