import { useCallback, useEffect, useRef, useState } from "react";

export function useAnalysisDashboard() {
  const [dashboard, setDashboard] = useState({
    prs: [],
    queue: { activeRunId: null, queuedRunIds: [] },
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const refreshAgainRef = useRef(false);
  const refreshPromiseRef = useRef(null);

  const refresh = useCallback(() => {
    if (refreshPromiseRef.current) {
      refreshAgainRef.current = true;
      return refreshPromiseRef.current;
    }

    const request = (async () => {
      do {
        refreshAgainRef.current = false;
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
      } while (refreshAgainRef.current);
    })();
    refreshPromiseRef.current = request;
    request.finally(() => {
      if (refreshPromiseRef.current === request) refreshPromiseRef.current = null;
    });
    return request;
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const running = Boolean(
    dashboard.queue?.activeRunIds?.length ||
      dashboard.queue?.activeRunId ||
      dashboard.queue?.queuedRunIds?.length,
  );

  useEffect(() => {
    const events = new EventSource("/api/events");
    let timer;
    const refreshSoon = () => {
      if (timer) return;
      timer = window.setTimeout(() => {
        timer = undefined;
        void refresh();
      }, 1_500);
    };
    events.addEventListener("analysis", refreshSoon);
    events.addEventListener("ready", refreshSoon);
    return () => {
      window.clearTimeout(timer);
      events.close();
    };
  }, [refresh]);

  return { dashboard, error, loading, refresh, running };
}
