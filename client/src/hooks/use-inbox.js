import { useCallback, useEffect, useState } from "react";

const initialInbox = {
  items: [],
  notifications: [],
  username: "",
  fetchedAt: null,
  repositories: [],
  notificationSummary: { total: 0, pullRequests: 0, nonPullRequests: 0 },
  warnings: [],
};

export function useInbox() {
  const [data, setData] = useState(initialInbox);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const refresh = useCallback(async (background = false, synchronize = false) => {
    if (!background) {
      setLoading(true);
      setError("");
    }
    try {
      if (synchronize) {
        const syncResponse = await fetch(
          synchronize === "notifications" ? "/api/inbox/notifications/sync" : "/api/inbox/sync",
          { method: "POST" },
        );
        const syncResult = await syncResponse.json();
        if (!syncResponse.ok) throw new Error(syncResult.error);
      }
      const response = await fetch("/api/inbox");
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      setData(result);
    } catch (caught) {
      if (!background) setError(caught.message || "Check your GitHub CLI login and retry.");
    } finally {
      if (!background) setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    const timer = window.setInterval(() => refresh(true, "notifications"), 5 * 60_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  return { data, error, loading, refresh, setData, setError };
}
