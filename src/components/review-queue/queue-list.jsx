import {
  AlertTriangle,
  ArrowUpRight,
  AtSign,
  Bell,
  Check,
  FileClock,
  LoaderCircle,
  MessageSquare,
  RotateCcw,
  Sparkles,
  Users,
} from "lucide-react";
import { Badge } from "@/components/ui/badge.jsx";
import { Button } from "@/components/ui/button.jsx";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty.jsx";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card.jsx";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemMedia,
} from "@/components/ui/item.jsx";
import { Skeleton } from "@/components/ui/skeleton.jsx";
import {
  ACTIVITY_SIGNAL_KINDS,
  NOTIFICATION_LABELS,
  analysisFor,
  relativeTime,
  safeGitHubUrl,
} from "@/lib/queue.js";
import { cn } from "@/lib/utils.js";
import { LIFECYCLE_META, LIFECYCLE_STYLES } from "./config.jsx";

const signalStyles = {
  "direct-review": "border-coral/20 bg-coral/10 text-coral-strong",
  "teammate-pr": "border-ochre/25 bg-ochre/10 text-ochre-strong",
  "team-review": "border-lilac/25 bg-lilac/10 text-lilac-strong",
};

export function LoadingQueue() {
  return (
    <div className="queue-card grid min-h-72 gap-5 p-6" aria-label="Building your current review queue">
      {["w-3/5", "w-4/5", "w-2/3"].map((width) => (
        <div className="flex items-center gap-4" key={width}>
          <Skeleton className="size-12 shrink-0 rounded-xl" />
          <div className="grid flex-1 gap-2">
            <Skeleton className={cn("h-4", width)} />
            <Skeleton className="h-3 w-2/5" />
          </div>
        </div>
      ))}
      <span className="sr-only">Building your current review queue…</span>
    </div>
  );
}

export function EmptyQueue({ canConfigure, onSettings, error, onRetry }) {
  const Icon = error ? AlertTriangle : Check;
  return (
    <Empty className="queue-card min-h-80 border-solid">
      <EmptyHeader>
        <EmptyMedia
          className={cn(
            "rounded-full border bg-background",
            error ? "border-coral/30 text-coral-strong" : "border-primary/25 text-primary",
          )}
          variant="icon"
        >
          <Icon />
        </EmptyMedia>
        <EmptyTitle className="font-display text-2xl font-semibold">
          {error ? "GitHub could not be loaded" : "This view is clear"}
        </EmptyTitle>
        <EmptyDescription>
          {error || "No current items match this lifecycle."}
        </EmptyDescription>
      </EmptyHeader>
      {(error || canConfigure) && (
        <EmptyContent>
          {error
            ? <Button onClick={onRetry}>Retry</Button>
            : <Button variant="outline" onClick={onSettings}>Add your team</Button>}
        </EmptyContent>
      )}
    </Empty>
  );
}

function ActivityHoverCard({ children, updates }) {
  return (
    <HoverCard openDelay={250} closeDelay={100}>
      <HoverCardTrigger asChild>{children}</HoverCardTrigger>
      <HoverCardContent
        align="center"
        className="w-80 border-border bg-popover text-xs leading-relaxed text-popover-foreground shadow-xl"
        side="top"
        sideOffset={8}
      >
        <strong className="block text-[0.68rem] uppercase tracking-[0.06em]">Changes since last open</strong>
        {updates.length ? (
          <ul className="mt-1 list-disc pl-4">
            {updates.map((update) => <li key={update}>{update}</li>)}
          </ul>
        ) : (
          <p className="mt-1 text-muted-foreground">No new activity.</p>
        )}
      </HoverCardContent>
    </HoverCard>
  );
}

function PullRequestRow({
  item,
  completed,
  onToggleDone,
  doneBusy,
  nested,
  analysis,
  analysisBusy,
  onAnalyze,
  onMarkRead,
}) {
  const Title = nested ? "h4" : "h3";
  const labelColor = (color) => (/^[\da-f]{6}$/i.test(color) ? `#${color}` : "#9b948d");
  const teammate = item.signals.find((signal) => signal.kind === "teammate-pr");
  const reviewRequest = item.signals.find((signal) => signal.kind === "direct-review")
    ?? item.signals.find((signal) => signal.kind === "team-review");
  const reportedUpdates = item.updatesSinceRead ?? [];
  const signalUpdates = item.read ? [] : [...item.signals]
    .filter((signal) => ACTIVITY_SIGNAL_KINDS.has(signal.kind))
    .filter((signal) => !["direct-review", "team-review"].includes(signal.kind) || signal === reviewRequest)
    .sort((left, right) => right.weight - left.weight)
    .filter((signal) => !(
      (signal.kind === "new-commits" && reportedUpdates.includes("New commits")) ||
      (signal.kind === "new-comments" && reportedUpdates.some((update) => /new comments?$/.test(update)))
    ))
    .map((signal) => `${signal.label}${signal.detail ? ` · ${signal.detail}` : ""}`);
  const initialUpdates = item.read ? [] : [
        `Pull request opened${item.author ? ` by ${item.author}` : ""}`,
        Number.isInteger(item.additions) && Number.isInteger(item.deletions)
          ? `+${item.additions} −${item.deletions}${Number.isInteger(item.changedFiles) ? ` across ${item.changedFiles} changed ${item.changedFiles === 1 ? "file" : "files"}` : ""}`
          : Number.isInteger(item.changedFiles)
            ? `${item.changedFiles} changed ${item.changedFiles === 1 ? "file" : "files"}`
            : null,
        item.comments > 0 ? `${item.comments} ${item.comments === 1 ? "comment" : "comments"}` : null,
        item.draft ? "Opened as draft" : null,
        item.state === "MERGED" ? "Merged" : null,
      ].filter(Boolean);
  const fallbackUpdates = reportedUpdates.length
    ? reportedUpdates[0] === "PR activity changed" && signalUpdates.length ? [] : reportedUpdates
    : initialUpdates;
  const updatesSinceRead = [...new Set([...signalUpdates, ...fallbackUpdates])];

  return (
    <ActivityHoverCard updates={updatesSinceRead}>
      <Item
        asChild
        className={cn(
          "rounded-none border-0 border-b border-border p-5 last:border-b-0 hover:bg-accent/50",
          item.read && !item.hasUnreadUpdates && "opacity-60 hover:opacity-80",
          completed && "opacity-60",
        )}
      >
        <article>
          <ItemMedia className="w-16">
            <Badge
              aria-label={`Priority score ${item.score}`}
              className={cn("h-8 min-w-12 justify-center rounded-full px-3 font-serif text-lg font-semibold tabular-nums", LIFECYCLE_STYLES[item.lifecycle])}
              variant="outline"
            >
              {item.score}
            </Badge>
          </ItemMedia>

          <ItemContent className="min-w-0 gap-0">
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span className="font-semibold text-foreground/65">#{item.number}</span>
            </div>

            <Title className="mt-1.5 text-[17px] font-semibold leading-snug tracking-[-0.015em]">
              <a
                className="decoration-primary/35 underline-offset-4 hover:underline"
                href={safeGitHubUrl(item.actionUrl)}
                target="_blank"
                rel="noreferrer"
                onClick={() => onMarkRead(item)}
              >
                {item.title}
              </a>
            </Title>

            <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
              {item.author && (
                <span className="inline-flex items-center gap-1">
                  by
                  {teammate ? (
                    <Badge className={cn("h-5 gap-1 px-1.5 text-[11px] font-semibold", signalStyles[teammate.kind])} variant="outline">
                      {item.author}
                    </Badge>
                  ) : (
                    <b className="font-semibold text-foreground/65">{item.author}</b>
                  )}
                </span>
              )}
              {reviewRequest && (
                <Badge
                  className={cn("h-5 gap-1 px-1.5 text-[11px] font-semibold", signalStyles[reviewRequest.kind])}
                  title={reviewRequest.detail || undefined}
                  variant="outline"
                >
                  {reviewRequest.kind === "direct-review" ? <AtSign className="size-3" /> : <Users className="size-3" />}
                  {reviewRequest.kind === "direct-review" ? "Direct review requested" : "Team review requested"}
                </Badge>
              )}
              <span>updated {relativeTime(item.updatedAt)}</span>
              {Number.isInteger(item.additions) && Number.isInteger(item.deletions) && (
                <span>{item.additions + item.deletions} changed LoC</span>
              )}
              {Number.isInteger(item.changedFiles) && <span>{item.changedFiles} {item.changedFiles === 1 ? "file" : "files"}</span>}
              {item.comments > 0 && <span className="inline-flex items-center gap-1"><MessageSquare className="size-3" />{item.comments}</span>}
              {item.labels.map((label) => (
                <span className="inline-flex items-center gap-1.5" key={label.name}>
                  <i className="size-1.5 rounded-full" style={{ backgroundColor: labelColor(label.color) }} />
                  {label.name}
                </span>
              ))}
            </div>
          </ItemContent>

          <ItemActions className="ml-20 basis-full md:ml-auto md:basis-auto">
            {analysis.href ? (
              <>
                <a className="review-action" href={analysis.href} target="_blank" rel="noreferrer" onClick={() => onMarkRead(item)}>
                  <Sparkles className="size-3.5" />
                  Open tree
                </a>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={analysisBusy || Boolean(analysis.active)}
                  onClick={() => onAnalyze(item)}
                  title="Re-run AI analysis"
                >
                  {analysisBusy || analysis.active?.status === "running"
                    ? <LoaderCircle className="size-3.5 animate-spin" />
                    : <RotateCcw className="size-3.5" />}
                </Button>
              </>
            ) : (
              <Button size="sm" variant="outline" disabled={analysisBusy || Boolean(analysis.active)} onClick={() => onAnalyze(item)}>
                {analysisBusy || analysis.active?.status === "running" ? <LoaderCircle className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />}
                {analysisBusy ? "Queueing" : analysis.active?.status === "running" ? "Analyzing" : analysis.active ? "Queued" : "Analyze"}
              </Button>
            )}
            <Button size="sm" variant="outline" disabled={doneBusy} onClick={() => onToggleDone(item)}>
              {doneBusy ? <LoaderCircle className="size-3.5 animate-spin" /> : completed ? <RotateCcw className="size-3.5" /> : <Check className="size-3.5" />}
              {completed ? "Restore" : "Done"}
            </Button>
          </ItemActions>
        </article>
      </Item>
    </ActivityHoverCard>
  );
}

function NotificationRow({ item, completed, onToggleDone, doneBusy, nested }) {
  const Title = nested ? "h4" : "h3";
  return (
    <Item asChild className={cn("rounded-none border-0 border-b border-border p-5 last:border-b-0 hover:bg-accent/50", completed && "opacity-60")}>
      <article>
      <ItemMedia className="notification-type w-28 justify-start">
        <Bell className="size-4" />
        <span>{item.subjectType}</span>
      </ItemMedia>
      <ItemContent className="min-w-0 gap-0">
        <Title className="text-[17px] font-semibold leading-snug tracking-[-0.015em]">
          <a className="decoration-primary/35 underline-offset-4 hover:underline" href={safeGitHubUrl(item.url)} target="_blank" rel="noreferrer">
            {item.title}
          </a>
        </Title>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <Badge variant="outline">{NOTIFICATION_LABELS[item.reason] || item.reason}</Badge>
          <span>updated {relativeTime(item.updatedAt)}</span>
        </div>
      </ItemContent>
      <ItemActions className="ml-32 basis-full md:ml-auto md:basis-auto">
        <a className="review-action" href={safeGitHubUrl(item.url)} target="_blank" rel="noreferrer">
          Open
          <ArrowUpRight className="size-3.5" />
        </a>
        <Button size="sm" variant="outline" disabled={doneBusy} onClick={() => onToggleDone(item)}>
          {doneBusy ? <LoaderCircle className="size-3.5 animate-spin" /> : completed ? <RotateCcw className="size-3.5" /> : <Check className="size-3.5" />}
          {completed ? "Restore" : "Done"}
        </Button>
      </ItemActions>
      </article>
    </Item>
  );
}

function UpdatedDateGroup({
  label,
  items,
  isDone,
  onToggleDone,
  doneMutation,
  analyses,
  analysisMutation,
  onAnalyze,
  onMarkRead,
  notifications = false,
  nested = false,
}) {
  const Heading = nested ? "h3" : "h2";
  const Row = notifications ? NotificationRow : PullRequestRow;
  return (
    <section className="project-group project-card" aria-label={`${label} items`}>
      <header className="project-header">
        <Heading><FileClock className="size-4" aria-hidden="true" />{label}</Heading>
        <Badge variant="outline">{items.length} {items.length === 1 ? "item" : "items"}</Badge>
      </header>
      {items.map((item) => (
        <Row
          key={item.id}
          item={item}
          completed={isDone(item)}
          onToggleDone={onToggleDone}
          doneBusy={doneMutation === item.id}
          nested={nested}
          {...(!notifications && {
            analysis: analysisFor(item, analyses.get(item.url)),
            analysisBusy: analysisMutation === item.id,
            onAnalyze,
            onMarkRead,
          })}
        />
      ))}
    </section>
  );
}

export function QueueSection({
  section,
  isDone,
  onToggleDone,
  doneMutation,
  analyses,
  analysisMutation,
  onAnalyze,
  onMarkRead,
  showHeader,
}) {
  const Icon = LIFECYCLE_META[section.id]?.icon ?? Bell;
  return (
    <section className="lifecycle-section" aria-label={`${section.label} queue`}>
      {showHeader && (
        <header className="lifecycle-header">
          <h2><Icon className="size-4" aria-hidden="true" />{section.label}</h2>
          <span>
            <Badge variant="outline">{section.count}</Badge>
          </span>
        </header>
      )}
      <div className="project-card-stack">
        {section.groups.map((group) => (
          <UpdatedDateGroup
            key={group.label}
            label={group.label}
            items={group.items}
            isDone={isDone}
            onToggleDone={onToggleDone}
            doneMutation={doneMutation}
            analyses={analyses}
            analysisMutation={analysisMutation}
            onAnalyze={onAnalyze}
            onMarkRead={onMarkRead}
            notifications={section.id === "nonpr"}
            nested={showHeader}
          />
        ))}
      </div>
    </section>
  );
}
