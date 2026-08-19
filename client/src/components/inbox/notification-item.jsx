import { ArrowUpRight, Bell } from "lucide-react";
import { titleClassName } from "@/components/inbox/inbox-activity.jsx";
import { MarkDoneOrRestore } from "@/components/inbox/inbox-analysis-actions.jsx";
import { Badge } from "@/components/ui/badge.jsx";
import { Item, itemListRowClassName } from "@/components/ui/item.jsx";
import { NOTIFICATION_LABELS, relativeTime, safeGitHubUrl } from "@/lib/queue.js";
import { cn } from "@/lib/utils.js";

export function NotificationItem({ completed, doneBusy, Heading, item, onToggleDone }) {
  return (
    <Item asChild className={cn(itemListRowClassName, completed && "opacity-60")}>
      <article>
        <Item.Media className="flex w-28 items-center justify-start gap-[0.45rem] text-[0.68rem] font-[750] uppercase tracking-[0.06em] text-muted-foreground">
          <Bell className="size-4 text-primary" />
          <span>{item.subjectType}</span>
        </Item.Media>
        <Item.Content className="min-w-0 gap-0">
          <Heading className={titleClassName}>
            <a
              className="decoration-primary/35 underline-offset-4 hover:underline"
              href={safeGitHubUrl(item.url)}
              target="_blank"
              rel="noreferrer"
            >
              {item.title}
            </a>
          </Heading>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <Badge variant="outline">{NOTIFICATION_LABELS[item.reason] || item.reason}</Badge>
            <span>updated {relativeTime(item.updatedAt)}</span>
          </div>
        </Item.Content>
        <Item.Actions className="ml-32 basis-full md:ml-auto md:basis-auto">
          <a
            className="inline-flex h-8 items-center justify-center gap-1 rounded-[0.5rem] px-[0.55rem] text-[0.75rem] font-bold text-primary no-underline hover:bg-primary/9"
            href={safeGitHubUrl(item.url)}
            target="_blank"
            rel="noreferrer"
          >
            Open
            <ArrowUpRight className="size-3.5" />
          </a>
          <MarkDoneOrRestore
            completed={completed}
            doneBusy={doneBusy}
            item={item}
            onToggleDone={onToggleDone}
          />
        </Item.Actions>
      </article>
    </Item>
  );
}
