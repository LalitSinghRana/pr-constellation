import { AlertTriangle } from "lucide-react";
import { parseAsStringEnum, useQueryState } from "nuqs";
import { useCallback, useState } from "react";
import { AnalysisQueueToolbar } from "@/components/analysis/analysis-queue-toolbar.jsx";
import { AnalysisSection } from "@/components/analysis/analysis-section.jsx";
import { useAnalysisQueueEntries } from "@/components/analysis/use-analysis-queue-entries.js";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs.jsx";
import { useDocumentTitle } from "@/hooks/use-document-title.js";
import { useMutation } from "@/hooks/use-mutation.js";
import { readJson } from "@/hooks/use-query.js";

const analysisTabs = ["ongoing", "not-started", "successful", "failed", "canceled"];

export function AnalysisPage() {
  useDocumentTitle({ title: "AI Analyzer Queue · PR Review Cockpit" });
  const queue = useAnalysisQueueEntries();
  const [canceling, setCanceling] = useState(false);
  const [actionError, setActionError] = useState("");
  const prioritizeRunMutation = useMutation({
    mutationFn: async ({ entry, run }) => {
      const response = await fetch(
        `/api/runs/${encodeURIComponent(entry.pr.slug)}/${encodeURIComponent(run.runId)}/prioritize`,
        { method: "POST", headers: { "Content-Type": "application/json" } },
      );
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "Could not prioritize analysis.");
      return body;
    },
    onSuccess: () => queue.refreshDashboard(),
    onError: (caught) => {
      setActionError(caught.message || "Could not prioritize analysis.");
    },
  });
  const queueAllMutation = useMutation({
    mutationFn: async () => {
      const response = await fetch("/api/analyses/queue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      return readJson(response);
    },
    onSuccess: () => queue.refreshDashboard(),
    onError: (caught) => {
      setActionError(caught.message || "Inbox pull requests could not be queued.");
    },
  });
  const prioritizingRunId = prioritizeRunMutation.isPending
    ? prioritizeRunMutation.variables?.run?.runId || ""
    : "";
  const [activeTab, setActiveTab] = useQueryState(
    "tab",
    parseAsStringEnum(analysisTabs).withDefault("ongoing"),
  );
  const error = actionError || queue.dashboardError;

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
        await queue.refreshDashboard();
        if (failure) setActionError(failure);
        setCanceling(false);
      }
    },
    [queue.refreshDashboard],
  );

  const prioritizeRun = useCallback(
    (entry, run) => {
      if (!entry?.pr?.slug || !run?.runId) return;
      setActionError("");
      prioritizeRunMutation.mutate({ entry, run });
    },
    [prioritizeRunMutation.mutate],
  );

  const cancelAll = useCallback(
    () =>
      cancelRuns([
        ...queue.queued.flatMap((entry) => entry.queuedRuns.map((run) => ({ entry, run }))),
        ...queue.running.map((entry) => ({ entry, run: entry.runningRun })),
      ]),
    [cancelRuns, queue.queued, queue.running],
  );

  return (
    <main className="min-h-screen">
      <div className="mx-auto w-full max-w-[1240px] px-5 pb-20 pt-5 sm:px-8 lg:px-12 lg:pt-8">
        <h1 className="sr-only">Analysis queue</h1>
        <AnalysisQueueToolbar
          analysisRunning={queue.analysisRunning}
          canQueueAll={queue.canQueueAll}
          canceling={canceling}
          loading={queue.loading}
          onCancelAll={cancelAll}
          onQueueAll={() => {
            setActionError("");
            queueAllMutation.mutate();
          }}
          queueAllPending={queueAllMutation.isPending}
        />

        {error && (
          <p className="mt-5 flex items-center gap-2 rounded-lg border border-coral/25 bg-coral/10 px-3 py-2 text-xs text-coral-strong">
            <AlertTriangle className="size-3.5" />
            {error}
          </p>
        )}

        <Tabs className="mt-6 gap-0" value={activeTab} onValueChange={setActiveTab}>
          <TabsList aria-label="Analysis status" variant="cockpit" style={{ height: "3rem" }}>
            {[
              ["ongoing", "Ongoing", queue.running.length + queue.queued.length],
              ["not-started", "Not started", queue.notStarted.length],
              ["successful", "Successful", queue.completed.length],
              ["failed", "Failed", queue.failed.length],
              ["canceled", "Canceled", queue.canceled.length],
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
              entries={[...queue.running, ...queue.queued]}
              mode="ongoing"
              onCancel={cancelRuns}
              onPrioritize={prioritizeRun}
              prioritizingRunId={prioritizingRunId}
            />
          </TabsContent>
          <TabsContent value="not-started">
            <AnalysisSection
              canceling={canceling}
              entries={queue.notStarted}
              mode="not-started"
              onCancel={cancelRuns}
            />
          </TabsContent>
          <TabsContent value="successful">
            <AnalysisSection
              canceling={canceling}
              entries={queue.completed}
              mode="completed"
              onCancel={cancelRuns}
            />
          </TabsContent>
          <TabsContent value="failed">
            <AnalysisSection
              canceling={canceling}
              entries={queue.failed}
              mode="failed"
              onCancel={cancelRuns}
            />
          </TabsContent>
          <TabsContent value="canceled">
            <AnalysisSection
              canceling={canceling}
              entries={queue.canceled}
              mode="canceled"
              onCancel={cancelRuns}
            />
          </TabsContent>
        </Tabs>
      </div>
    </main>
  );
}
