import { useAnalysisDashboard } from "@/hooks/use-analysis-dashboard.js";
import { useQuery } from "@/hooks/use-query.js";
import { analysisState } from "@/lib/analysis.js";
import { fetchInbox } from "@/lib/cockpit-api.js";

const terminalStatuses = new Set(["succeeded", "failed", "canceled", "interrupted"]);

export function useAnalysisQueueEntries() {
  const {
    dashboard,
    error: dashboardError,
    loading,
    refresh: refreshDashboard,
    running: analysisRunning,
  } = useAnalysisDashboard();
  const inboxQuery = useQuery({
    queryKey: ["inbox", "active"],
    queryFn: ({ signal }) => fetchInbox({ view: "active", signal }),
  });
  const queueItems = inboxQuery.data?.items ?? [];

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
  const notStartedEntries = queueItems
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
  const entries = [...dashboardEntries, ...notStartedEntries];

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
  const canceled = entries
    .filter((entry) => entry.state === "canceled")
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
  const canQueueAll = queueItems.some((item) => {
    if (
      item.authored ||
      item.done ||
      item.state === "MERGED" ||
      item.state === "CLOSED" ||
      ["mine", "merged", "closed"].includes(item.lifecycle)
    ) {
      return false;
    }
    const entry = entries.find((candidate) => candidate.pr.url === item.url);
    if (!entry || entry.state === "not-started") return true;
    if (entry.runningRun || entry.queuedRuns.length) return false;
    return (
      entry.latestRun?.status !== "succeeded" ||
      (item.headSha && entry.latestRun.headSha && entry.latestRun.headSha !== item.headSha)
    );
  });

  return {
    analysisRunning,
    canQueueAll,
    canceled,
    completed,
    dashboardError,
    failed,
    loading,
    notStarted,
    queued,
    refreshDashboard,
    running,
  };
}
