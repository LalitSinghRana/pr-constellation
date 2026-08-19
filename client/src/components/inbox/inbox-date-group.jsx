import { Check, FileClock, LoaderCircle } from "lucide-react";
import { MyPullRequestItem } from "@/components/inbox/my-pull-request-item.jsx";
import { NotificationItem } from "@/components/inbox/notification-item.jsx";
import { ReviewPullRequestItem } from "@/components/inbox/review-pull-request-item.jsx";
import { Badge } from "@/components/ui/badge.jsx";
import { Button } from "@/components/ui/button.jsx";
import { ItemGroup, itemGroupCardClassName } from "@/components/ui/item.jsx";
import { analysisFor } from "@/lib/queue.js";

function DateGroupHeader({ GroupHeading, items, label, onToggleDone, doneBusy, openItems }) {
  return (
    <ItemGroup.Header>
      <GroupHeading className="m-0 flex min-w-0 items-center gap-[0.55rem] text-[0.75rem] font-[750] tracking-[0.01em] text-foreground [overflow-wrap:anywhere]">
        <FileClock className="size-4 flex-none text-primary" aria-hidden="true" />
        {label}
      </GroupHeading>
      <span className="flex items-center gap-2">
        <Badge variant="outline">
          {items.length} {items.length === 1 ? "item" : "items"}
        </Badge>
        {openItems.length > 0 && (
          <Button
            size="icon-sm"
            variant="outline"
            disabled={doneBusy}
            onClick={() => onToggleDone(openItems)}
            aria-label={`Mark all ${label} items done`}
            title="Mark all done"
          >
            {doneBusy ? (
              <LoaderCircle className="size-3.5 animate-spin" />
            ) : (
              <Check className="size-3.5 text-emerald-700" />
            )}
          </Button>
        )}
      </span>
    </ItemGroup.Header>
  );
}

export function PullRequestDateGroup({
  GroupHeading,
  RowHeading,
  items,
  isDone,
  onToggleDone,
  doneMutation,
  analyses,
  analysisMutation,
  onAnalyze,
  onPrioritize,
  prioritizeMutation,
  onMarkRead,
  label,
}) {
  const groupDoneBusy = items.some((item) => doneMutation.includes(item.id));
  const openItems = items.filter((item) => !item.authored && !isDone(item));
  return (
    <ItemGroup className={itemGroupCardClassName} aria-label={`${label} items`}>
      <DateGroupHeader
        GroupHeading={GroupHeading}
        items={items}
        label={label}
        onToggleDone={onToggleDone}
        doneBusy={groupDoneBusy}
        openItems={openItems}
      />
      {items.map((item) => {
        const shared = {
          analysis: analysisFor(item, analyses.get(item.url)),
          analysisBusy: analysisMutation === item.id,
          completed: isDone(item),
          Heading: RowHeading,
          item,
          onAnalyze,
          onMarkRead,
          onPrioritize,
          prioritizeBusy: prioritizeMutation === item.url,
        };
        return item.authored ? (
          <MyPullRequestItem key={item.id} {...shared} />
        ) : (
          <ReviewPullRequestItem
            key={item.id}
            {...shared}
            doneBusy={doneMutation.includes(item.id)}
            onToggleDone={onToggleDone}
          />
        );
      })}
    </ItemGroup>
  );
}

export function NotificationDateGroup({
  GroupHeading,
  RowHeading,
  items,
  isDone,
  onToggleDone,
  doneMutation,
  label,
}) {
  const groupDoneBusy = items.some((item) => doneMutation.includes(item.id));
  const openItems = items.filter((item) => !isDone(item));
  return (
    <ItemGroup className={itemGroupCardClassName} aria-label={`${label} items`}>
      <DateGroupHeader
        GroupHeading={GroupHeading}
        items={items}
        label={label}
        onToggleDone={onToggleDone}
        doneBusy={groupDoneBusy}
        openItems={openItems}
      />
      {items.map((item) => (
        <NotificationItem
          key={item.id}
          item={item}
          completed={isDone(item)}
          onToggleDone={onToggleDone}
          doneBusy={doneMutation.includes(item.id)}
          Heading={RowHeading}
        />
      ))}
    </ItemGroup>
  );
}
