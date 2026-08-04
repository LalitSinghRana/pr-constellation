import { ArrowLeft, ArrowUpRight, LoaderCircle, Sparkles, Square } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { ThemeToggle } from "@/components/theme-toggle.jsx";
import { Badge } from "@/components/ui/badge.jsx";
import { Button } from "@/components/ui/button.jsx";
import { Card, CardContent } from "@/components/ui/card.jsx";

const STATUS_STYLES = {
  running: "border-sky/25 bg-sky/10 text-sky-strong",
  "not-started": "border-border bg-muted text-muted-foreground",
  succeeded: "border-emerald-700/20 bg-emerald-700/10 text-emerald-800",
  failed: "border-coral/25 bg-coral/10 text-coral-strong",
  canceled: "border-border bg-muted text-muted-foreground",
};

function useFixtures() {
  const [fixtures, setFixtures] = useState([]);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/fixtures");
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      setFixtures(result.fixtures);
      setError("");
    } catch (caught) {
      setError(caught.message || "Fixtures could not be loaded.");
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const running = fixtures.some((fixture) => fixture.isRunning);
  useEffect(() => {
    const timer = window.setInterval(refresh, running ? 3_000 : 30_000);
    return () => window.clearInterval(timer);
  }, [refresh, running]);

  return { error, fixtures, refresh };
}

function FixtureCard({ fixture, onStop, onTrigger, stopping, triggering }) {
  const latestRun = fixture.runs[0] || null;
  const pinnedRuns = fixture.runs.filter((run) => run.pinned);
  const unpinnedRuns = fixture.runs.filter((run) => !run.pinned);
  const isRunning = fixture.isRunning;
  const status = isRunning ? "running" : latestRun?.status ?? "not-started";

  return (
    <Card className="gap-0 bg-card/80">
      <CardContent className="flex flex-col gap-3 p-5">
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <Badge variant="outline">{fixture.kind}</Badge>
          <Badge variant="outline">PR #{fixture.realPr.number}</Badge>
          <Badge className={STATUS_STYLES[status] || STATUS_STYLES["not-started"]} variant="outline">
            {isRunning && <LoaderCircle className="size-3 animate-spin" />}
            {status.replace("-", " ")}
          </Badge>
          {fixture.runs.length > 0 && (
            <span>{fixture.runs.length} {fixture.runs.length === 1 ? "run" : "runs"}</span>
          )}
        </div>
        <h3 className="text-[17px] font-semibold leading-snug tracking-[-0.015em]">{fixture.realPr.title}</h3>
        <p className="text-sm text-muted-foreground">{fixture.purpose}</p>
        {latestRun?.metrics && (
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            {latestRun.metrics.stackCount != null && (
              <Badge variant="outline">{latestRun.metrics.stackCount} stacks</Badge>
            )}
            {latestRun.metrics.flowDepth != null && (
              <Badge variant="outline">flow depth {latestRun.metrics.flowDepth}</Badge>
            )}
            {latestRun.metrics.sourceOrderMatch != null && (
              <Badge variant="outline">
                source-order match {Math.round(latestRun.metrics.sourceOrderMatch * 100)}%
              </Badge>
            )}
            {latestRun.metrics.badRootCount != null && (
              <Badge variant="outline">{latestRun.metrics.badRootCount} bad roots</Badge>
            )}
          </div>
        )}
        {latestRun?.error?.message && (
          <p className="text-xs text-coral-strong" title={latestRun.error.message}>
            {latestRun.error.message}
          </p>
        )}
        <div className="mt-1 flex flex-wrap items-center gap-2">
          {isRunning ? (
            <Button
              className="text-coral-strong"
              disabled={stopping}
              onClick={() => onStop(fixture.key)}
              size="sm"
              variant="outline"
            >
              {stopping ? <LoaderCircle className="size-3.5 animate-spin" /> : <Square className="size-3.5" />}
              Stop
            </Button>
          ) : (
            <Button disabled={triggering} onClick={() => onTrigger(fixture.key)} size="sm">
              {triggering ? <LoaderCircle className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />}
              Run AI analysis
            </Button>
          )}
          {fixture.referenceUrls.map((url) => (
            <a className="inline-flex h-8 items-center justify-center gap-1 rounded-[0.5rem] px-[0.55rem] text-[0.75rem] font-bold text-primary no-underline hover:bg-primary/9" href={url} key={url} rel="noreferrer" target="_blank">
              Source PR<ArrowUpRight className="size-3.5" />
            </a>
          ))}
        </div>
        {unpinnedRuns.length > 0 && (
          <div className="mt-1 flex flex-wrap items-center gap-2 border-t border-dashed pt-3">
            <span className="text-xs text-muted-foreground">Runs:</span>
            {unpinnedRuns.map((run, index) =>
              run.status === "succeeded" && run.graphUrl ? (
                <a
                  className="inline-flex h-8 items-center justify-center gap-1 rounded-[0.5rem] px-[0.55rem] text-[0.75rem] font-bold text-primary no-underline hover:bg-primary/9"
                  href={run.graphUrl}
                  key={run.runId}
                  rel="noreferrer"
                  target="_blank"
                >
                  Run {index + 1}<ArrowUpRight className="size-3.5" />
                </a>
              ) : (
                <Badge className={STATUS_STYLES[run.status] || STATUS_STYLES["not-started"]} key={run.runId} variant="outline">
                  Run {index + 1} ({run.status})
                </Badge>
              ),
            )}
          </div>
        )}
        {pinnedRuns.length > 0 && (
          <div className="mt-1 flex flex-wrap items-center gap-2 border-t border-dashed pt-3">
            <span className="text-xs text-muted-foreground">Pinned:</span>
            {pinnedRuns.map((run, index) => (
              <a
                className="inline-flex h-8 items-center justify-center gap-1 rounded-[0.5rem] px-[0.55rem] text-[0.75rem] font-bold text-primary no-underline hover:bg-primary/9"
                href={run.graphUrl}
                key={run.runId}
                rel="noreferrer"
                target="_blank"
              >
                Pin {index + 1}<ArrowUpRight className="size-3.5" />
              </a>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function FixturesPage() {
  const { error, fixtures, refresh } = useFixtures();
  const [triggeringKey, setTriggeringKey] = useState(null);
  const [stoppingKey, setStoppingKey] = useState(null);
  const [actionError, setActionError] = useState("");

  const trigger = useCallback(async (key) => {
    setTriggeringKey(key);
    setActionError("");
    try {
      const response = await fetch(`/api/fixtures/${key}/run`, { method: "POST" });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(result.error || "Could not start the run.");
      }
      await refresh();
    } catch (caught) {
      setActionError(caught.message || "Could not start the run.");
    } finally {
      setTriggeringKey(null);
    }
  }, [refresh]);

  const stop = useCallback(async (key) => {
    setStoppingKey(key);
    setActionError("");
    try {
      const response = await fetch(`/api/fixtures/${key}/stop`, { method: "POST" });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(result.error || "Could not stop the run.");
      }
      await refresh();
    } catch (caught) {
      setActionError(caught.message || "Could not stop the run.");
    } finally {
      setStoppingKey(null);
    }
  }, [refresh]);

  return (
    <main className="min-h-screen">
      <div className="mx-auto w-full max-w-[1000px] px-5 pb-20 pt-8 sm:px-8 lg:px-12 lg:pt-12">
        <div className="flex items-center justify-between">
          <a className="inline-flex items-center gap-[0.45rem] text-[0.78rem] font-bold text-muted-foreground no-underline hover:text-foreground" href="/">
            <ArrowLeft className="size-4" />
            Back to the queue
          </a>
          <ThemeToggle />
        </div>

        <header className="mt-6">
          <p className="mb-2 flex items-center gap-2 text-[0.65rem] font-extrabold uppercase tracking-[0.14em] text-primary"><span className="size-1.5 rounded-full bg-primary" />Review-stack test fixtures</p>
          <h1 className="font-display text-4xl font-semibold tracking-[-0.045em] sm:text-5xl">
            Control-group PRs
          </h1>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
            Four frozen, SHA-pinned PR diffs used to gate the review-stack
            feature. Each one probes a different failure mode. Run the real
            pipeline against a fixture to see how it splits the PR into
            themed review stacks, then open the result next to what the
            fixture is supposed to prove.
          </p>
        </header>

        {(error || actionError) && (
          <p className="mt-5 rounded-lg border border-coral/25 bg-coral/10 px-3 py-2 text-xs text-coral-strong">
            {actionError || error}
          </p>
        )}

        <div className="mt-6 grid gap-3">
          {fixtures.map((fixture) => (
            <FixtureCard
              fixture={fixture}
              key={fixture.key}
              onStop={stop}
              onTrigger={trigger}
              stopping={stoppingKey === fixture.key}
              triggering={triggeringKey === fixture.key}
            />
          ))}
        </div>
      </div>
    </main>
  );
}
