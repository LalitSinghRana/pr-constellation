import { ArrowUpRight, ChevronDown, FileClock, LoaderCircle, Sparkles, X } from "lucide-react";
import { Badge } from "@/components/ui/badge.jsx";
import { Button } from "@/components/ui/button.jsx";
import { Card, CardContent } from "@/components/ui/card.jsx";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible.jsx";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty.jsx";
import { groupByUpdatedDate, relativeTime, safeGitHubUrl } from "@/lib/queue.js";
import { analysisTimeline, cn, formatDuration } from "@/lib/utils.js";

const statusStyles = {
  running: "border-sky/25 bg-sky/10 text-sky-strong",
  queued: "border-lilac/25 bg-lilac/10 text-lilac-strong",
  "not-started": "border-border bg-muted text-muted-foreground",
  succeeded: "border-emerald-700/20 bg-emerald-700/10 text-emerald-800",
  failed: "border-coral/25 bg-coral/10 text-coral-strong",
  canceled: "border-border bg-muted text-muted-foreground",
  interrupted: "border-ochre/25 bg-ochre/10 text-ochre-strong",
};

const timestampFormatter = new Intl.DateTimeFormat("en", {
  dateStyle: "medium",
  timeStyle: "short",
});

function formatTimestamp(value) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : timestampFormatter.format(date);
}

function runForEntry(entry, mode) {
  return mode === "running" ? entry.runningRun : mode === "queued" ? entry.queuedRuns[0] : entry.latestRun;
}

function RunDetails({ run, timeline }) {
  const metrics = run.metrics ?? {};
  const totalTokens = metrics.usage?.totalTokens ?? metrics.tokens?.totalTokens;
  const startedAt = new Date(run.startedAt).getTime();
  const endedAt = run.completedAt ? new Date(run.completedAt).getTime() : Date.now();
  const elapsedMs = Number.isFinite(startedAt) && Number.isFinite(endedAt)
    ? Math.max(0, endedAt - startedAt)
    : run.timings?.totalDurationMs;
  const facts = [
    ["Run ID", run.runId],
    ["Model", [metrics.model, metrics.reasoningEffort].filter(Boolean).join(" · ")],
    ["Source", run.sourceMode === "frozen" ? "Saved PR input" : "Fresh PR input"],
    ["Queued", formatTimestamp(run.queuedAt)],
    ["Started", formatTimestamp(run.startedAt)],
    ["Finished", formatTimestamp(run.completedAt)],
    ["Run time", Number.isFinite(elapsedMs) ? formatDuration(elapsedMs) : ""],
    ["Tokens", Number.isFinite(totalTokens) ? totalTokens.toLocaleString() : ""],
  ].filter(([, value]) => value);

  return (
    <CollapsibleContent>
      <div className="border-t border-border bg-muted/20 px-4 py-4">
        {run.error?.message && (
          <p className="mb-4 rounded-md border border-coral/25 bg-coral/10 px-3 py-2 text-xs text-coral-strong">
            {run.error.message}
          </p>
        )}
        <div className="grid gap-6 lg:grid-cols-[minmax(14rem,0.55fr)_minmax(30rem,1.45fr)]">
          <section aria-label="Run details">
            <h5 className="text-xs font-bold uppercase tracking-[0.1em] text-foreground/65">Run details</h5>
            <dl className="mt-3 grid grid-cols-2 gap-x-5 gap-y-3 text-xs">
              {facts.map(([label, value]) => (
                <div className="min-w-0" key={label}>
                  <dt className="text-muted-foreground">{label}</dt>
                  <dd className="mt-0.5 truncate font-semibold text-foreground" title={String(value)}>{value}</dd>
                </div>
              ))}
            </dl>
          </section>
          <section aria-label="Analysis timeline">
            <h5 className="text-xs font-bold uppercase tracking-[0.1em] text-foreground/65">Analysis timeline</h5>
            {timeline.rows.length > 0 ? (
              <div className="mt-3 overflow-x-auto">
                <div className="min-w-[34rem]">
                  <div className="grid grid-cols-[minmax(10rem,15rem)_minmax(16rem,1fr)_4.5rem] items-center gap-3 text-[10px] text-muted-foreground">
                    <span />
                    <span className="flex justify-between"><span>0s</span><span>{formatDuration(timeline.durationMs)}</span></span>
                    <span />
                  </div>
                  <div className="mt-1 grid gap-1.5">
                    {timeline.rows.map((stage) => (
                      <div className="grid grid-cols-[minmax(10rem,15rem)_minmax(16rem,1fr)_4.5rem] items-center gap-3 text-xs" key={`${stage.stageId}-${stage.attempt}`}>
                        <span className="min-w-0 truncate font-medium" style={{ paddingLeft: `${stage.depth * 0.75}rem` }} title={stage.label}>
                          {stage.label}
                        </span>
                        <span className="relative h-5 overflow-hidden rounded bg-muted" aria-label={`${stage.label}: ${stage.status}, ${formatDuration(stage.durationMs)}`}>
                          <span
                            className={cn(
                              "absolute inset-y-1 rounded-full bg-primary/70",
                              stage.depth === 0 && "bg-foreground/65",
                              stage.running && "animate-pulse bg-sky",
                              stage.status === "failed" && "bg-coral",
                              ["canceled", "interrupted"].includes(stage.status) && "bg-ochre",
                            )}
                            style={{ left: `${stage.offsetPct}%`, minWidth: "2px", width: `${stage.widthPct}%` }}
                          />
                        </span>
                        <span className={cn(
                          "text-right font-semibold tabular-nums",
                          stage.running && "text-sky-strong",
                          stage.status === "failed" && "text-coral-strong",
                        )}>
                          {formatDuration(stage.durationMs)}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            ) : (
              <p className="mt-3 text-xs text-muted-foreground">Analysis timing starts when the run begins.</p>
            )}
          </section>
        </div>
      </div>
    </CollapsibleContent>
  );
}

function AnalysisRow({ canceling, entry, mode, onCancel }) {
  const run = runForEntry(entry, mode);
  const status = run?.status ?? "not-started";
  const item = entry.queueItem;
  const metrics = run?.metrics ?? {};
  const changedLines = Number.isInteger(item?.additions) && Number.isInteger(item?.deletions)
    ? item.additions + item.deletions
    : Number.isInteger(metrics.changedLines)
      ? metrics.changedLines
      : Number.isInteger(metrics.additions) && Number.isInteger(metrics.deletions)
        ? metrics.additions + metrics.deletions
        : null;
  const changedFiles = Number.isInteger(item?.changedFiles)
    ? item.changedFiles
    : Number.isInteger(metrics.changedFiles)
      ? metrics.changedFiles
      : null;
  const successfulRun = entry.runs.find((candidate) => candidate.status === "succeeded");
  const timeline = analysisTimeline(run);
  const detail = mode === "queued"
    ? `#${entry.queuePosition + 1} in queue`
    : mode === "running"
      ? run.currentStage || run.phase || "Analyzing"
      : mode === "not-started"
        ? "Not queued"
        : run.completedAt || run.updatedAt
          ? `finished ${relativeTime(run.completedAt || run.updatedAt)}`
          : "finished";

  const summary = (
    <span className="block min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span className="font-semibold text-foreground/65">{entry.pr.owner}/{entry.pr.repo} #{entry.pr.number}</span>
          <Badge className={statusStyles[status]} variant="outline">
            {mode === "running" && <LoaderCircle className="size-3 animate-spin" />}
            {status.replace("-", " ")}
          </Badge>
          <span>{detail}</span>
        </span>
        <span className="mt-1.5 block text-[17px] font-semibold leading-snug tracking-[-0.015em]">{entry.title}</span>
        <span className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          {changedLines != null && <span>{changedLines} changed LoC</span>}
          {changedFiles != null && <span>{changedFiles} {changedFiles === 1 ? "file" : "files"}</span>}
          {entry.runs.length > 0 && <span>{entry.runs.length} {entry.runs.length === 1 ? "run" : "runs"}</span>}
        </span>
    </span>
  );

  return (
    <Collapsible>
      <Card aria-label={entry.title} className="gap-0 bg-card/80 py-0 transition-colors hover:border-primary/25" role="article">
        <CardContent className="flex flex-wrap items-center gap-4 p-4">
        {run ? (
          <CollapsibleTrigger className="group flex min-w-0 flex-1 cursor-pointer items-center gap-3 rounded-md text-left outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">
            {summary}
            <ChevronDown className="size-4 flex-none text-muted-foreground transition-transform group-data-[state=open]:rotate-180" aria-hidden="true" />
          </CollapsibleTrigger>
        ) : summary}
        <div className="flex w-full flex-wrap items-center gap-2 md:w-auto md:justify-end">
        {run && ["running", "queued"].includes(mode) && (
          <Button
            className="text-coral-strong"
            disabled={canceling}
            onClick={() => onCancel((mode === "queued" ? entry.queuedRuns : [run]).map((candidate) => ({ entry, run: candidate })))}
            size="sm"
            variant="ghost"
          >
            <X className="size-3.5" />Cancel
          </Button>
        )}
        {successfulRun && (
          <a className="inline-flex h-8 items-center justify-center gap-1 rounded-[0.5rem] px-[0.55rem] text-[0.75rem] font-bold text-primary no-underline hover:bg-primary/9" href={`/reviews/${encodeURIComponent(entry.pr.slug)}/`} target="_blank" rel="noreferrer">
            <Sparkles className="size-3.5" />Open tree
          </a>
        )}
        <a className="inline-flex h-8 items-center justify-center gap-1 rounded-[0.5rem] px-[0.55rem] text-[0.75rem] font-bold text-primary no-underline hover:bg-primary/9" href={safeGitHubUrl(entry.pr.url)} target="_blank" rel="noreferrer">
          GitHub<ArrowUpRight className="size-3.5" />
        </a>
        </div>
        </CardContent>
        {run && <RunDetails run={run} timeline={timeline} />}
      </Card>
    </Collapsible>
  );
}

export function AnalysisSection({ canceling, description, entries, mode, onCancel, title }) {
  const groups = groupByUpdatedDate(entries.map((entry) => {
    const run = runForEntry(entry, mode);
    return {
      ...entry,
      updatedAt: run?.completedAt || run?.startedAt || run?.queuedAt || run?.createdAt || run?.updatedAt || entry.queueItem?.updatedAt,
    };
  }), { preserveOrder: true });

  return (
    <section className="mt-8" aria-labelledby={`analysis-${mode}`}>
      <header className="mb-3 flex items-end justify-between gap-4">
        <div>
          <p className="mb-2 flex items-center gap-2 text-[0.65rem] font-extrabold uppercase tracking-[0.14em] text-primary">{description}</p>
          <h2 className="font-display text-2xl font-semibold tracking-[-0.035em]" id={`analysis-${mode}`}>{title}</h2>
        </div>
        <Badge variant="outline">{entries.length}</Badge>
      </header>
      <div className="grid gap-6">
        {entries.length ? groups.map((group) => (
          <section className="grid gap-3" key={group.label} aria-label={`${group.label} analyses`}>
            <h3 className="flex items-center gap-2 border-b border-border pb-2 text-xs font-semibold text-muted-foreground">
              <FileClock className="size-3.5 text-primary" aria-hidden="true" />{group.label}
            </h3>
            {group.items.map((entry) => (
              <AnalysisRow
                canceling={canceling}
                entry={entry}
                key={`${mode}-${entry.pr.slug || entry.pr.url}`}
                mode={mode}
                onCancel={onCancel}
              />
            ))}
          </section>
        )) : (
          <Empty className="min-h-24 border border-dashed py-6 md:p-6">
            <EmptyHeader>
              <EmptyTitle className="text-sm">Nothing here</EmptyTitle>
              <EmptyDescription>No {title.toLowerCase()}.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
      </div>
    </section>
  );
}
