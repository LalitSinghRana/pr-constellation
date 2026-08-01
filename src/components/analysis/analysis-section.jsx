import { ArrowUpRight, LoaderCircle, Sparkles, X } from "lucide-react";
import { Badge } from "@/components/ui/badge.jsx";
import { Button } from "@/components/ui/button.jsx";
import { Card, CardContent } from "@/components/ui/card.jsx";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty.jsx";
import { relativeTime, safeGitHubUrl } from "@/lib/queue.js";

const statusStyles = {
  running: "border-sky/25 bg-sky/10 text-sky-strong",
  queued: "border-lilac/25 bg-lilac/10 text-lilac-strong",
  "not-started": "border-border bg-muted text-muted-foreground",
  succeeded: "border-emerald-700/20 bg-emerald-700/10 text-emerald-800",
  failed: "border-coral/25 bg-coral/10 text-coral-strong",
  canceled: "border-border bg-muted text-muted-foreground",
  interrupted: "border-ochre/25 bg-ochre/10 text-ochre-strong",
};

function AnalysisRow({ canceling, entry, mode, onCancel }) {
  const run = mode === "running" ? entry.runningRun : mode === "queued" ? entry.queuedRuns[0] : entry.latestRun;
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
  const detail = mode === "queued"
    ? `#${entry.queuePosition + 1} in queue`
    : mode === "running"
      ? run.currentStage || run.phase || "Analyzing"
      : mode === "not-started"
        ? "Not queued"
        : run.completedAt || run.updatedAt
          ? `finished ${relativeTime(run.completedAt || run.updatedAt)}`
          : "finished";

  return (
    <Card className="gap-0 bg-card/80 py-0" role="article">
      <CardContent className="flex flex-wrap items-center gap-4 p-4">
        <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span className="font-semibold text-foreground/65">{entry.pr.owner}/{entry.pr.repo} #{entry.pr.number}</span>
          <Badge className={statusStyles[status]} variant="outline">
            {mode === "running" && <LoaderCircle className="size-3 animate-spin" />}
            {status.replace("-", " ")}
          </Badge>
          <span>{detail}</span>
        </div>
        <h3 className="mt-1.5 text-[17px] font-semibold leading-snug tracking-[-0.015em]">{entry.title}</h3>
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          {changedLines != null && <span>{changedLines} changed LoC</span>}
          {changedFiles != null && <span>{changedFiles} {changedFiles === 1 ? "file" : "files"}</span>}
          {entry.runs.length > 0 && <span>{entry.runs.length} {entry.runs.length === 1 ? "run" : "runs"}</span>}
        </div>
        {run?.error?.message && (
          <p className="mt-2 max-w-3xl truncate text-xs text-coral-strong" title={run.error.message}>{run.error.message}</p>
        )}
        </div>
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
          <a className="review-action" href={`/reviews/${encodeURIComponent(entry.pr.slug)}/`} target="_blank" rel="noreferrer">
            <Sparkles className="size-3.5" />Open tree
          </a>
        )}
        <a className="review-action" href={safeGitHubUrl(entry.pr.url)} target="_blank" rel="noreferrer">
          GitHub<ArrowUpRight className="size-3.5" />
        </a>
        </div>
      </CardContent>
    </Card>
  );
}

export function AnalysisSection({ canceling, description, entries, mode, onCancel, title }) {
  return (
    <section className="mt-8" aria-labelledby={`analysis-${mode}`}>
      <header className="mb-3 flex items-end justify-between gap-4">
        <div>
          <p className="eyebrow">{description}</p>
          <h2 className="font-display text-2xl font-semibold tracking-[-0.035em]" id={`analysis-${mode}`}>{title}</h2>
        </div>
        <Badge variant="outline">{entries.length}</Badge>
      </header>
      <div className="grid gap-3">
        {entries.length ? entries.map((entry) => (
          <AnalysisRow
            canceling={canceling}
            entry={entry}
            key={`${mode}-${entry.pr.slug || entry.pr.url}`}
            mode={mode}
            onCancel={onCancel}
          />
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
