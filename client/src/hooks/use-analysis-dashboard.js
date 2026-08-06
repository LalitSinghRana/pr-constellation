import { useCallback, useEffect, useState } from "react";

export function useAnalysisDashboard() {
  const [dashboard, setDashboard] = useState({
    prs: [],
    queue: { activeRunId: null, queuedRunIds: [] },
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/analyses");
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      setDashboard(result);
      setError("");
    } catch (caught) {
      setError(caught.message || "AI analysis service could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const running = Boolean(
    dashboard.queue?.activeRunId || dashboard.queue?.queuedRunIds?.length,
  );

  useEffect(() => {
    const timer = window.setInterval(refresh, running ? 3_000 : 30_000);
    return () => window.clearInterval(timer);
  }, [refresh, running]);

  return { dashboard, error, loading, refresh, running };
}
