import { analysisTimeline, formatDuration } from "@/lib/analysis.js";
import { cn } from "@/lib/utils.js";

const timestampFormatter = new Intl.DateTimeFormat("en", {
  dateStyle: "medium",
  timeStyle: "short",
});

function formatTimestamp(value) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : timestampFormatter.format(date);
}

export function RunDetails({ run, timeline = analysisTimeline(run) }) {
  const metrics = run.metrics ?? {};
  const totalTokens = metrics.usage?.totalTokens ?? metrics.tokens?.totalTokens;
  const startedAt = new Date(run.startedAt).getTime();
  const endedAt = run.completedAt ? new Date(run.completedAt).getTime() : Date.now();
  const elapsedMs =
    Number.isFinite(startedAt) && Number.isFinite(endedAt)
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
    <div className="border-t border-border bg-muted/20 px-4 py-4">
      {run.error?.message && (
        <p className="mb-4 rounded-md border border-error/25 bg-error/10 px-3 py-2 text-xs text-error-strong">
          {run.error.message}
        </p>
      )}
      <div className="grid gap-6 lg:grid-cols-[minmax(14rem,0.55fr)_minmax(30rem,1.45fr)]">
        <section aria-label="Run details">
          <h5 className="text-xs font-bold uppercase tracking-[0.1em] text-foreground/65">
            Run details
          </h5>
          <dl className="mt-3 grid grid-cols-2 gap-x-5 gap-y-3 text-xs">
            {facts.map(([label, value]) => (
              <div className="min-w-0" key={label}>
                <dt className="text-muted-foreground">{label}</dt>
                <dd className="mt-0.5 truncate font-semibold text-foreground" title={String(value)}>
                  {value}
                </dd>
              </div>
            ))}
          </dl>
        </section>
        <section aria-label="Analysis timeline">
          <h5 className="text-xs font-bold uppercase tracking-[0.1em] text-foreground/65">
            Analysis timeline
          </h5>
          {timeline.rows.length > 0 ? (
            <div className="mt-3 overflow-x-auto">
              <div className="min-w-[34rem]">
                <div className="grid grid-cols-[minmax(10rem,15rem)_minmax(16rem,1fr)_4.5rem] items-center gap-3 text-[10px] text-muted-foreground">
                  <span />
                  <span className="flex justify-between">
                    <span>0s</span>
                    <span>{formatDuration(timeline.durationMs)}</span>
                  </span>
                  <span />
                </div>
                <div className="mt-1 grid gap-1.5">
                  {timeline.rows.map((stage) => (
                    <div
                      className="grid grid-cols-[minmax(10rem,15rem)_minmax(16rem,1fr)_4.5rem] items-center gap-3 text-xs"
                      key={`${stage.stageId}-${stage.attempt}`}
                    >
                      <span
                        className="min-w-0 truncate font-medium"
                        style={{ paddingLeft: `${stage.depth * 0.75}rem` }}
                        title={stage.label}
                      >
                        {stage.label}
                      </span>
                      <span
                        className="relative h-5 overflow-hidden rounded bg-muted"
                        aria-label={`${stage.label}: ${stage.status}, ${formatDuration(stage.durationMs)}`}
                        role="img"
                      >
                        <span
                          className={cn(
                            "absolute inset-y-1 rounded-full bg-primary/70",
                            stage.depth === 0 && "bg-foreground/65",
                            stage.running && "animate-pulse bg-info",
                            stage.status === "failed" && "bg-error",
                            ["canceled", "interrupted"].includes(stage.status) && "bg-warning",
                          )}
                          style={{
                            left: `${stage.offsetPct}%`,
                            minWidth: "2px",
                            width: `${stage.widthPct}%`,
                          }}
                        />
                      </span>
                      <span
                        className={cn(
                          "text-right font-semibold tabular-nums",
                          stage.running && "text-info-strong",
                          stage.status === "failed" && "text-error-strong",
                        )}
                      >
                        {formatDuration(stage.durationMs)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          ) : (
            <p className="mt-3 text-xs text-muted-foreground">
              Analysis timing starts when the run begins.
            </p>
          )}
        </section>
      </div>
    </div>
  );
}
