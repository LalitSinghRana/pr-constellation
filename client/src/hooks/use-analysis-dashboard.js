import { useEffect } from "react";
import { fetchAnalysisDashboard } from "../lib/cockpit-api.js";
import { useQuery } from "./use-query.js";

const emptyDashboard = {
  prs: [],
  queue: { activeRunId: null, queuedRunIds: [] },
};

export function useAnalysisDashboard() {
  const query = useQuery({
    queryKey: ["analyses"],
    queryFn: ({ signal }) => fetchAnalysisDashboard({ signal }),
  });

  useEffect(() => {
    const events = new EventSource("/api/events");
    let timer;
    const refreshSoon = () => {
      if (timer) return;
      timer = window.setTimeout(() => {
        timer = undefined;
        void query.refetch();
      }, 1_500);
    };
    events.addEventListener("analysis", refreshSoon);
    events.addEventListener("ready", refreshSoon);
    return () => {
      window.clearTimeout(timer);
      events.close();
    };
  }, [query.refetch]);

  const dashboard = query.data ?? emptyDashboard;
  const running = Boolean(
    dashboard.queue?.activeRunIds?.length ||
      dashboard.queue?.activeRunId ||
      dashboard.queue?.queuedRunIds?.length,
  );

  return {
    dashboard,
    error: query.error?.message || "",
    loading: query.isLoading,
    refresh: query.refetch,
    running,
  };
}
