import { ArrowUp, FileClock, Layers3, LoaderCircle, X } from "lucide-react";
import { Badge } from "@/components/ui/badge.jsx";
import { Button } from "@/components/ui/button.jsx";
import { Collapsible } from "@/components/ui/collapsible.jsx";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty.jsx";
import {
  Item,
  ItemGroup,
  itemGroupCardClassName,
  itemListRowClassName,
} from "@/components/ui/item.jsx";
import { analysisTimeline, groupByAnalysisQueueBand } from "@/lib/analysis.js";
import { groupByUpdatedDate, relativeTime, reviewPageHref, safeGitHubUrl } from "@/lib/queue.js";
import { RunDetails } from "./run-details.jsx";

function cancelableTargetsForEntry(entry) {
  return [
    ...(entry.queuedRuns || []).map((run) => ({ entry, run })),
    ...(entry.runningRun ? [{ entry, run: entry.runningRun }] : []),
  ].filter(
    (target, index, list) =>
      list.findIndex((candidate) => candidate.run.runId === target.run.runId) === index,
  );
}

function runForEntry(entry, mode) {
  if (mode === "ongoing") {
    return entry.runningRun || entry.queuedRuns[0] || entry.latestRun;
  }
  if (mode === "running") return entry.runningRun;
  if (mode === "queued") return entry.queuedRuns[0];
  return entry.latestRun;
}

function entryDetail(entry, mode, run) {
  if (entry.runningRun || mode === "running") {
    return run?.currentStage || run?.phase || "Analyzing";
  }
  if ((entry.queuedRuns?.length && !entry.runningRun) || mode === "queued") {
    return `#${entry.queuePosition + 1} in queue`;
  }
  if (mode === "not-started" || !run) return "Not queued";
  if (run.completedAt || run.updatedAt) {
    return `finished ${relativeTime(run.completedAt || run.updatedAt)}`;
  }
  return "finished";
}

function AnalysisRow({ canceling, entry, mode, onCancel, onPrioritize, prioritizing }) {
  const run = runForEntry(entry, mode);
  const item = entry.queueItem;
  const metrics = run?.metrics ?? {};
  const changedLines =
    Number.isInteger(item?.additions) && Number.isInteger(item?.deletions)
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
  const timeline = analysisTimeline(run);
  const cancelableTargets = cancelableTargetsForEntry(entry);
  const canCancel = cancelableTargets.length > 0;
  const queuedRun = entry.queuedRuns?.[0];
  const canPrioritize = Boolean(queuedRun && !entry.runningRun && mode !== "running");
  const bumped = Boolean(queuedRun?.metrics?.bumpedAt);
  const detail = entryDetail(entry, mode, run);
  const running = Boolean(entry.runningRun || mode === "running");

  const row = (
    <Item asChild className={itemListRowClassName}>
      <article>
        <Item.Content className="min-w-0 gap-0">
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span className="font-semibold text-foreground/65">
              {entry.pr.owner}/{entry.pr.repo} #{entry.pr.number}
            </span>
            {running && (
              <LoaderCircle className="size-3 animate-spin text-info-strong" aria-hidden="true" />
            )}
            <span>{detail}</span>
          </div>
          <h3 className="mt-1.5 text-[17px] font-semibold leading-snug tracking-[-0.015em]">
            <a
              className="decoration-primary/35 underline-offset-4 hover:underline"
              href={reviewPageHref(entry.pr.slug) || safeGitHubUrl(entry.pr.url)}
              target="_blank"
              rel="noreferrer"
            >
              {entry.title}
            </a>
          </h3>
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
            {changedLines != null && <span>{changedLines} changed LoC</span>}
            {changedFiles != null && (
              <span>
                {changedFiles} {changedFiles === 1 ? "file" : "files"}
              </span>
            )}
            {(entry.pr.runCount ?? entry.runs.length) > 0 && (
              <span>
                {entry.pr.runCount ?? entry.runs.length}{" "}
                {(entry.pr.runCount ?? entry.runs.length) === 1 ? "run" : "runs"}
              </span>
            )}
          </div>
        </Item.Content>
        <Item.Actions className="ml-auto basis-full md:basis-auto">
          {canPrioritize && (
            <Button
              disabled={prioritizing || bumped || canceling}
              onClick={() => onPrioritize?.(entry, queuedRun)}
              size="sm"
              variant="outline"
              title={bumped ? "Already at the front of the queue" : "Move to front of queue"}
            >
              {prioritizing ? (
                <LoaderCircle className="size-3.5 animate-spin" />
              ) : (
                <ArrowUp className="size-3.5" />
              )}
              {bumped ? "Prioritized" : "Prioritize"}
            </Button>
          )}
          {canCancel && (
            <Button
              className="text-error-strong"
              disabled={canceling}
              onClick={() => onCancel(cancelableTargets)}
              size="sm"
              variant="ghost"
            >
              <X className="size-3.5" />
              Cancel
            </Button>
          )}
          {run && <Item.Trigger />}
        </Item.Actions>
        {run && (
          <Item.Panel>
            <RunDetails run={run} timeline={timeline} />
          </Item.Panel>
        )}
      </article>
    </Item>
  );

  if (!run) return row;
  return <Collapsible asChild>{row}</Collapsible>;
}

export function AnalysisSection({
  canceling,
  entries,
  mode,
  onCancel,
  onPrioritize,
  prioritizingRunId,
}) {
  const groups =
    mode === "ongoing"
      ? groupByAnalysisQueueBand(entries)
      : groupByUpdatedDate(
          entries.map((entry) => {
            const run = runForEntry(entry, mode);
            return {
              ...entry,
              updatedAt:
                run?.completedAt ||
                run?.startedAt ||
                run?.queuedAt ||
                run?.createdAt ||
                run?.updatedAt ||
                entry.queueItem?.updatedAt,
            };
          }),
          { preserveOrder: true },
        );
  const GroupIcon = mode === "ongoing" ? Layers3 : FileClock;

  return (
    <section className="mt-6" aria-label={`${mode} analyses`}>
      <div className="grid gap-4">
        {entries.length ? (
          groups.map((group) => {
            const cancelableTargets = group.items.flatMap(cancelableTargetsForEntry);
            return (
              <ItemGroup
                className={itemGroupCardClassName}
                key={group.key || group.label}
                aria-label={`${group.label} analyses`}
              >
                <ItemGroup.Header>
                  <h3 className="m-0 flex min-w-0 items-center gap-[0.55rem] text-[0.75rem] font-[750] tracking-[0.01em] text-foreground [overflow-wrap:anywhere]">
                    <GroupIcon className="size-4 flex-none text-primary" aria-hidden="true" />
                    {group.label}
                  </h3>
                  <span className="flex items-center gap-2">
                    <Badge variant="outline">
                      {group.items.length} {group.items.length === 1 ? "item" : "items"}
                    </Badge>
                    {cancelableTargets.length > 0 && (
                      <Button
                        className="text-error-strong"
                        disabled={canceling}
                        onClick={() => onCancel(cancelableTargets)}
                        size="icon-sm"
                        variant="ghost"
                        aria-label={`Cancel all ${group.label} analyses`}
                        title="Cancel all"
                      >
                        <X className="size-3.5" />
                      </Button>
                    )}
                  </span>
                </ItemGroup.Header>
                {group.items.map((entry) => (
                  <AnalysisRow
                    canceling={canceling}
                    entry={entry}
                    key={`${mode}-${entry.pr.slug || entry.pr.url}-${entry.runningRun?.runId || entry.queuedRuns?.[0]?.runId || entry.latestRun?.runId || "none"}`}
                    mode={mode}
                    onCancel={onCancel}
                    onPrioritize={onPrioritize}
                    prioritizing={prioritizingRunId === entry.queuedRuns?.[0]?.runId}
                  />
                ))}
              </ItemGroup>
            );
          })
        ) : (
          <Empty className="min-h-24 border border-dashed py-6 md:p-6">
            <EmptyHeader>
              <EmptyTitle className="text-sm">Nothing here</EmptyTitle>
              <EmptyDescription>No analyses in this tab.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
      </div>
    </section>
  );
}
