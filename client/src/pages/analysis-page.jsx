import { AlertTriangle, ArrowLeft, RefreshCw, X } from "lucide-react";
import { parseAsStringEnum, useQueryState } from "nuqs";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AnalysisSection } from "@/components/analysis/analysis-section.jsx";
import { Button } from "@/components/ui/button.jsx";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs.jsx";
import { useAnalysisDashboard } from "@/hooks/use-analysis-dashboard.js";
import { useDocumentTitle } from "@/hooks/use-document-title.js";
import { analysisState } from "@/lib/analysis.js";
import { cn } from "@/lib/utils.js";

const terminalStatuses = new Set(["succeeded", "failed", "canceled", "interrupted"]);

export function AnalysisPage() {
  useDocumentTitle({ title: "AI Analyzer Queue · PR Review Cockpit" });
  const {
    dashboard,
    error: dashboardError,
    loading,
    refresh: refreshDashboard,
    running: analysisRunning,
  } = useAnalysisDashboard();
  const [queueItems, setQueueItems] = useState([]);
  const [canceling, setCanceling] = useState(false);
  const [actionError, setActionError] = useState("");
  const [activeTab, setActiveTab] = useQueryState(
    "tab",
    parseAsStringEnum(["ongoing", "not-started", "successful", "failed"]).withDefault("ongoing"),
  );
  const error = actionError || dashboardError;

  useEffect(() => {
    fetch("/api/inbox?view=active")
      .then((response) => response.json())
      .then((inbox) => setQueueItems(inbox.items ?? []))
      .catch(() => {});
  }, []);

  const entries = useMemo(() => {
    const itemsByUrl = new Map(queueItems.map((item) => [item.url, item]));
    const queueOrder = new Map(
      (dashboard.queue?.queuedRunIds ?? []).map((runId, index) => [runId, index]),
    );
    const pullRequests = dashboard.prs ?? dashboard.pullRequests ?? [];
    const dashboardEntries = pullRequests.map((pr) => {
      const runs = [...(pr.runs ?? [])].sort(
        (left, right) =>
          new Date(right.createdAt || right.queuedAt) - new Date(left.createdAt || left.queuedAt),
      );
      const queueItem = itemsByUrl.get(pr.url);
      const runningRun = runs.find((run) => run.status === "running");
      const queuedRuns = runs
        .filter((run) => run.status === "queued")
        .sort(
          (left, right) =>
            (queueOrder.get(left.runId) ?? Number.MAX_SAFE_INTEGER) -
            (queueOrder.get(right.runId) ?? Number.MAX_SAFE_INTEGER),
        );
      const latestRun = runs.find((run) => terminalStatuses.has(run.status));
      const entry = {
        pr,
        runs,
        queueItem,
        runningRun,
        queuedRuns,
        latestRun,
        queuePosition: queueOrder.get(queuedRuns[0]?.runId) ?? Number.MAX_SAFE_INTEGER,
        title:
          queueItem?.title ||
          pr.title ||
          runs.find((run) => run.title)?.title ||
          `Pull request #${pr.number}`,
      };
      return { ...entry, state: analysisState(entry) };
    });
    const dashboardUrls = new Set(pullRequests.map((pr) => pr.url));
    const notStarted = queueItems
      .filter((item) => !item.done && !dashboardUrls.has(item.url))
      .map((item) => {
        const [owner, repo] = item.repository.split("/");
        const entry = {
          pr: { number: item.number, owner, repo, slug: "", url: item.url },
          runs: [],
          queueItem: item,
          runningRun: null,
          queuedRuns: [],
          latestRun: null,
          queuePosition: Number.MAX_SAFE_INTEGER,
          title: item.title,
        };
        return { ...entry, state: analysisState(entry) };
      });
    return [...dashboardEntries, ...notStarted];
  }, [dashboard, queueItems]);

  const running = entries
    .filter((entry) => entry.state === "running")
    .sort(
      (left, right) =>
        Number(right.runningRun.runId === dashboard.queue?.activeRunId) -
        Number(left.runningRun.runId === dashboard.queue?.activeRunId),
    );
  const queued = entries
    .filter((entry) => entry.state === "queued")
    .sort((left, right) => left.queuePosition - right.queuePosition);
  const completed = entries
    .filter((entry) => entry.state === "completed")
    .sort(
      (left, right) =>
        new Date(right.latestRun.completedAt || right.latestRun.updatedAt) -
        new Date(left.latestRun.completedAt || left.latestRun.updatedAt),
    );
  const failed = entries
    .filter((entry) => entry.state === "failed")
    .sort(
      (left, right) =>
        new Date(right.latestRun.completedAt || right.latestRun.updatedAt) -
        new Date(left.latestRun.completedAt || left.latestRun.updatedAt),
    );
  const notStarted = entries
    .filter((entry) => entry.state === "not-started")
    .sort(
      (left, right) => new Date(right.queueItem.updatedAt) - new Date(left.queueItem.updatedAt),
    );

  const cancelRuns = useCallback(
    async (targets) => {
      setCanceling(true);
      setActionError("");
      let failure;
      try {
        for (const { entry, run } of targets) {
          const response = await fetch(
            `/api/runs/${encodeURIComponent(entry.pr.slug)}/${encodeURIComponent(run.runId)}/cancel`,
            { method: "POST", headers: { "Content-Type": "application/json" } },
          );
          if (!response.ok && response.status !== 404) {
            const body = await response.json().catch(() => ({}));
            failure = body.error || "Analysis could not be canceled.";
          }
        }
      } catch (caught) {
        failure = caught.message || "Analysis could not be canceled.";
      } finally {
        await refreshDashboard();
        if (failure) setActionError(failure);
        setCanceling(false);
      }
    },
    [refreshDashboard],
  );

  const cancelAll = useCallback(
    () =>
      cancelRuns([
        ...queued.flatMap((entry) => entry.queuedRuns.map((run) => ({ entry, run }))),
        ...running.map((entry) => ({ entry, run: entry.runningRun })),
      ]),
    [cancelRuns, queued, running],
  );

  return (
    <main className="min-h-screen">
      <div className="mx-auto w-full max-w-[1240px] px-5 pb-20 pt-5 sm:px-8 lg:px-12 lg:pt-8">
        <h1 className="sr-only">Analysis queue</h1>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Button asChild variant="ghost">
            <a href="/">
              <ArrowLeft className="size-4" />
              Review queue
            </a>
          </Button>
          <div className="flex flex-wrap gap-2">
            <Button
              className="text-coral-strong"
              disabled={canceling || !analysisRunning}
              onClick={cancelAll}
              variant="outline"
            >
              <X className="size-4" />
              Cancel all
            </Button>
            <Button variant="outline" disabled={loading} onClick={refreshDashboard}>
              <RefreshCw className={cn("size-4", loading && "animate-spin")} />
              Refresh
            </Button>
          </div>
        </div>

        {error && (
          <p className="mt-5 flex items-center gap-2 rounded-lg border border-coral/25 bg-coral/10 px-3 py-2 text-xs text-coral-strong">
            <AlertTriangle className="size-3.5" />
            {error}
          </p>
        )}

        <Tabs className="mt-6 gap-0" value={activeTab} onValueChange={setActiveTab}>
          <TabsList aria-label="Analysis status" variant="cockpit" style={{ height: "3rem" }}>
            {[
              ["ongoing", "Ongoing", running.length + queued.length],
              ["not-started", "Not started", notStarted.length],
              ["successful", "Successful", completed.length],
              ["failed", "Failed", failed.length],
            ].map(([id, label, count]) => (
              <TabsTrigger className="group" key={id} value={id}>
                {label}
                <span className="min-w-5 rounded-full bg-muted px-1.5 py-0.5 text-[0.64rem] tabular-nums text-muted-foreground group-data-[state=active]:bg-primary/10 group-data-[state=active]:text-primary">
                  {count}
                </span>
              </TabsTrigger>
            ))}
          </TabsList>

          <TabsContent value="ongoing">
            <AnalysisSection
              canceling={canceling}
              description="Current work"
              entries={running}
              mode="running"
              onCancel={cancelRuns}
              title="In progress"
            />
            <AnalysisSection
              canceling={canceling}
              description="Smallest first"
              entries={queued}
              mode="queued"
              onCancel={cancelRuns}
              title="In queue"
            />
          </TabsContent>
          <TabsContent value="not-started">
            <AnalysisSection
              canceling={canceling}
              description="No analysis yet"
              entries={notStarted}
              mode="not-started"
              onCancel={cancelRuns}
              title="Not started"
            />
          </TabsContent>
          <TabsContent value="successful">
            <AnalysisSection
              canceling={canceling}
              description="Successful analyses"
              entries={completed}
              mode="completed"
              onCancel={cancelRuns}
              title="Successful"
            />
          </TabsContent>
          <TabsContent value="failed">
            <AnalysisSection
              canceling={canceling}
              description="Failed, canceled, or interrupted"
              entries={failed}
              mode="failed"
              onCancel={cancelRuns}
              title="Failed"
            />
          </TabsContent>
        </Tabs>
      </div>
    </main>
  );
}
