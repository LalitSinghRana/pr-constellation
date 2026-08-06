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
import { Card } from "@/components/ui/card.jsx";
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
  myPullRequestStatus,
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

const myPrStatuses = {
  draft: { label: "Draft", className: LIFECYCLE_STYLES.draft },
  opened: { label: "Opened", className: LIFECYCLE_STYLES.new },
  approved: { label: "Approved", className: LIFECYCLE_STYLES.approved },
  merged: { label: "Merged", className: LIFECYCLE_STYLES.merged },
};

export function LoadingQueue() {
  return (
    <Card className="grid min-h-72 gap-5 rounded-lg bg-card/75 p-6 shadow-lg backdrop-blur-sm" aria-label="Building your current review queue">
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
    </Card>
  );
}

export function EmptyQueue({ canConfigure, onSettings, error, onRetry }) {
  const Icon = error ? AlertTriangle : Check;
  return (
    <Empty className="min-h-80 overflow-hidden rounded-lg border border-solid bg-card/75 shadow-lg backdrop-blur-sm">
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

function ActivityHoverCard({ children, updates, since = "last open" }) {
  return (
    <HoverCard openDelay={250} closeDelay={100}>
      <HoverCardTrigger asChild>{children}</HoverCardTrigger>
      <HoverCardContent
        align="center"
        className="w-80 border-border bg-popover text-xs leading-relaxed text-popover-foreground shadow-xl"
        side="top"
        sideOffset={8}
      >
        <strong className="block text-[0.68rem] uppercase tracking-[0.06em]">Changes since {since}</strong>
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
  const myPrStatus = item.authored ? myPrStatuses[myPullRequestStatus(item)] : null;
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
    <ActivityHoverCard updates={updatesSinceRead} since={item.changesSince}>
      <Item
        asChild
        className={cn(
          "rounded-none border-0 border-b border-border p-5 last:border-b-0 hover:bg-accent/50",
          item.read && !item.hasUnreadUpdates && "opacity-60 hover:opacity-80",
          completed && "opacity-60",
        )}
      >
        <article>
          <ItemMedia className={myPrStatus ? "w-20" : "w-16"}>
            {myPrStatus ? (
              <Badge
                aria-label={`Pull request status ${myPrStatus.label}`}
                className={cn("h-8 min-w-16 justify-center rounded-full px-2 text-xs font-semibold", myPrStatus.className)}
                variant="outline"
              >
                {myPrStatus.label}
              </Badge>
            ) : (
              <Badge
                aria-label={`Priority score ${item.score}`}
                className={cn("h-8 min-w-12 justify-center rounded-full px-3 font-serif text-lg font-semibold tabular-nums", LIFECYCLE_STYLES[item.lifecycle])}
                variant="outline"
              >
                {item.score}
              </Badge>
            )}
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
                <a className="inline-flex h-8 items-center justify-center gap-1 rounded-[0.5rem] px-[0.55rem] text-[0.75rem] font-bold text-primary no-underline hover:bg-primary/9" href={analysis.href} target="_blank" rel="noreferrer" onClick={() => onMarkRead(item)}>
                  <Sparkles className="size-3.5" />
                  Open review
                </a>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={analysisBusy || Boolean(analysis.active)}
                  onClick={() => onAnalyze(item)}
                  title={
                    analysisBusy || analysis.active?.status === "queued"
                      ? "Queued for AI analysis"
                      : analysis.active?.status === "running"
                        ? "Analyzing"
                        : "Re-run AI analysis"
                  }
                >
                  {analysisBusy || analysis.active
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
            <Button
              size={completed ? "sm" : "icon-sm"}
              variant="outline"
              disabled={doneBusy}
              onClick={() => onToggleDone(item)}
              aria-label={completed ? undefined : "Mark done"}
              title={completed ? undefined : "Mark done"}
            >
              {doneBusy ? (
                <LoaderCircle className="size-3.5 animate-spin" />
              ) : completed ? (
                <><RotateCcw className="size-3.5" />Restore</>
              ) : (
                <Check className="size-3.5 text-emerald-700" />
              )}
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
      <ItemMedia className="flex w-28 items-center justify-start gap-[0.45rem] text-[0.68rem] font-[750] uppercase tracking-[0.06em] text-muted-foreground">
        <Bell className="size-4 text-primary" />
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
        <a className="inline-flex h-8 items-center justify-center gap-1 rounded-[0.5rem] px-[0.55rem] text-[0.75rem] font-bold text-primary no-underline hover:bg-primary/9" href={safeGitHubUrl(item.url)} target="_blank" rel="noreferrer">
          Open
          <ArrowUpRight className="size-3.5" />
        </a>
        <Button
          size={completed ? "sm" : "icon-sm"}
          variant="outline"
          disabled={doneBusy}
          onClick={() => onToggleDone(item)}
          aria-label={completed ? undefined : "Mark done"}
          title={completed ? undefined : "Mark done"}
        >
          {doneBusy ? (
            <LoaderCircle className="size-3.5 animate-spin" />
          ) : completed ? (
            <><RotateCcw className="size-3.5" />Restore</>
          ) : (
            <Check className="size-3.5 text-emerald-700" />
          )}
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
  const groupDoneBusy = items.some((item) => doneMutation.includes(item.id));
  const openItems = items.filter((item) => !isDone(item));
  return (
    <section className="overflow-hidden rounded-lg border bg-card/75 shadow-lg backdrop-blur-sm" aria-label={`${label} items`}>
      <header className="flex min-h-[2.8rem] items-center justify-between gap-4 border-b bg-accent/78 px-[1.2rem] py-[0.65rem] max-[700px]:px-[0.9rem]">
        <Heading className="m-0 flex min-w-0 items-center gap-[0.55rem] text-[0.75rem] font-[750] tracking-[0.01em] text-foreground [overflow-wrap:anywhere]">
          <FileClock className="size-4 flex-none text-primary" aria-hidden="true" />{label}
        </Heading>
        <span className="flex items-center gap-2">
          <Badge variant="outline">{items.length} {items.length === 1 ? "item" : "items"}</Badge>
          {openItems.length > 0 && (
            <Button
              size="icon-sm"
              variant="outline"
              disabled={groupDoneBusy}
              onClick={() => onToggleDone(openItems)}
              aria-label={`Mark all ${label} items done`}
              title="Mark all done"
            >
              {groupDoneBusy
                ? <LoaderCircle className="size-3.5 animate-spin" />
                : <Check className="size-3.5 text-emerald-700" />}
            </Button>
          )}
        </span>
      </header>
      {items.map((item) => (
        <Row
          key={item.id}
          item={item}
          completed={isDone(item)}
          onToggleDone={onToggleDone}
          doneBusy={doneMutation.includes(item.id)}
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
    <section className="grid gap-3" aria-label={`${section.label} queue`}>
      {showHeader && (
        <header className="flex min-h-[3.25rem] items-center justify-between gap-4 p-1 max-[700px]:px-[0.9rem]">
          <h2 className="m-0 flex items-center gap-[0.55rem] font-display text-[1.15rem] font-[650] tracking-[-0.02em]">
            <Icon className="size-4 text-primary" aria-hidden="true" />{section.label}
          </h2>
          <span className="flex items-center gap-[0.55rem]">
            <Badge variant="outline">{section.count}</Badge>
          </span>
        </header>
      )}
      <div className="grid gap-4">
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
