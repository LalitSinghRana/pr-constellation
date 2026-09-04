import { AtSign, MessageSquare, Users } from "lucide-react";
import { Badge } from "@/components/ui/badge.jsx";
import { Item, itemListRowClassName } from "@/components/ui/item.jsx";
import { relativeTime, reviewPageHref, safeGitHubUrl } from "@/lib/queue.js";
import { cn } from "@/lib/utils.js";
import { LIFECYCLE_STYLES } from "./config.jsx";
import {
  ActivityHoverCard,
  activityUpdates,
  signalStyles,
  titleClassName,
} from "./inbox-activity.jsx";
import { InboxAnalysisActions, MarkDoneOrRestore } from "./inbox-analysis-actions.jsx";

export function ReviewPullRequestItem({
  analysis,
  analysisBusy,
  completed,
  doneBusy,
  Heading,
  item,
  onAnalyze,
  onMarkRead,
  onPrioritize,
  onToggleDone,
  prioritizeBusy,
}) {
  const labelColor = (color) => (/^[\da-f]{6}$/i.test(color) ? `#${color}` : "#9b948d");
  const teammate = item.signals.find((signal) => signal.kind === "teammate-pr");
  const reviewRequest =
    item.signals.find((signal) => signal.kind === "direct-review") ??
    item.signals.find((signal) => signal.kind === "team-review");

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
          <Item.Media className="w-16">
            <Badge
              aria-label={`Priority score ${item.score}`}
              className={cn(
                "h-8 min-w-12 justify-center rounded-full px-3 font-serif text-lg font-semibold tabular-nums",
                LIFECYCLE_STYLES[item.lifecycle],
              )}
              variant="outline"
            >
              {item.score}
            </Badge>
          </Item.Media>
          <Item.Content className="min-w-0 gap-0">
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span className="font-semibold text-foreground/65">#{item.number}</span>
            </div>
            <Heading className={cn("mt-1.5", titleClassName)}>
              <a
                className="decoration-primary/35 underline-offset-4 hover:underline"
                href={reviewPageHref(item.slug) || safeGitHubUrl(item.actionUrl)}
                onClick={() => onMarkRead(item)}
                rel="noreferrer"
                target="_blank"
              >
                {item.title}
              </a>
            </Heading>
            <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
              {item.author && (
                <span className="inline-flex items-center gap-1">
                  by
                  {teammate ? (
                    <Badge
                      className={cn(
                        "h-5 gap-1 px-1.5 text-[11px] font-semibold",
                        signalStyles[teammate.kind],
                      )}
                      variant="outline"
                    >
                      {item.author}
                    </Badge>
                  ) : (
                    <b className="font-semibold text-foreground/65">{item.author}</b>
                  )}
                </span>
              )}
              {reviewRequest && (
                <Badge
                  className={cn(
                    "h-5 gap-1 px-1.5 text-[11px] font-semibold",
                    signalStyles[reviewRequest.kind],
                  )}
                  title={reviewRequest.detail || undefined}
                  variant="outline"
                >
                  {reviewRequest.kind === "direct-review" ? (
                    <AtSign className="size-3" />
                  ) : (
                    <Users className="size-3" />
                  )}
                  {reviewRequest.kind === "direct-review"
                    ? "Direct review requested"
                    : "Team review requested"}
                </Badge>
              )}
              <span>updated {relativeTime(item.updatedAt)}</span>
              {Number.isInteger(item.additions) && Number.isInteger(item.deletions) && (
                <span>{item.additions + item.deletions} changed LoC</span>
              )}
              {Number.isInteger(item.changedFiles) && (
                <span>
                  {item.changedFiles} {item.changedFiles === 1 ? "file" : "files"}
                </span>
              )}
              {item.comments > 0 && (
                <span className="inline-flex items-center gap-1">
                  <MessageSquare className="size-3" />
                  {item.comments}
                </span>
              )}
              {item.labels.map((label) => (
                <span className="inline-flex items-center gap-1.5" key={label.name}>
                  <i
                    className="size-1.5 rounded-full"
                    style={{ backgroundColor: labelColor(label.color) }}
                  />
                  {label.name}
                </span>
              ))}
            </div>
          </Item.Content>
          <Item.Actions className="ml-20 basis-full md:ml-auto md:basis-auto">
            <InboxAnalysisActions
              analysis={analysis}
              analysisBusy={analysisBusy}
              item={item}
              onAnalyze={onAnalyze}
              onPrioritize={onPrioritize}
              prioritizeBusy={prioritizeBusy}
            />
            <MarkDoneOrRestore
              completed={completed}
              doneBusy={doneBusy}
              item={item}
              onToggleDone={onToggleDone}
            />
          </Item.Actions>
        </article>
      </Item>
    </ActivityHoverCard>
  );
}
