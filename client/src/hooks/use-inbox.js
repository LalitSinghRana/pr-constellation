import { useCallback, useEffect, useRef, useState } from "react";

const initialInbox = {
  items: [],
  notifications: [],
  username: "",
  fetchedAt: null,
  repositories: [],
  notificationSummary: { total: 0, pullRequests: 0, nonPullRequests: 0 },
  counts: {},
  page: { hasMore: false, limit: 0, nextOffset: 0, offset: 0, total: 0, view: "active" },
  warnings: [],
};

export function useInbox(view = "active") {
  const [data, setData] = useState(initialInbox);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const loadMoreRef = useRef(false);
  const loadingSequenceRef = useRef(0);
  const refreshSequenceRef = useRef(0);

  const refresh = useCallback(
    async (background = false, synchronize = false) => {
      const requestSequence = ++refreshSequenceRef.current;
      if (!background) {
        loadingSequenceRef.current = requestSequence;
        setLoading(true);
        setError("");
      }
      try {
        if (synchronize) {
          const syncResponse = await fetch(
            synchronize === "notifications" ? "/api/inbox/notifications/sync" : "/api/inbox/sync",
            { method: "POST", headers: { "Content-Type": "application/json" } },
          );
          const syncResult = await syncResponse.json();
          if (!syncResponse.ok) throw new Error(syncResult.error);
        }
        const response = await fetch(`/api/inbox?view=${encodeURIComponent(view)}`);
        const result = await response.json();
        if (!response.ok) throw new Error(result.error);
        if (requestSequence === refreshSequenceRef.current) setData(result);
      } catch (caught) {
        if (!background && requestSequence === refreshSequenceRef.current) {
          setError(caught.message || "Check your GitHub CLI login and retry.");
        }
      } finally {
        if (!background && requestSequence === loadingSequenceRef.current) setLoading(false);
      }
    },
    [view],
  );

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    const events = new EventSource("/api/events");
    let timer;
    const refreshSoon = () => {
      if (timer) return;
      timer = window.setTimeout(() => {
        timer = undefined;
        void refresh(true);
      }, 250);
    };
    events.addEventListener("inbox", refreshSoon);
    events.addEventListener("ready", refreshSoon);
    return () => {
      window.clearTimeout(timer);
      events.close();
    };
  }, [refresh]);

  const loadMore = useCallback(async () => {
    if (!data.page?.hasMore || loadMoreRef.current) return;
    loadMoreRef.current = true;
    setLoadingMore(true);
    const requestSequence = refreshSequenceRef.current;
    try {
      const offset = data.page.nextOffset ?? data.page.offset + data.page.limit;
      const response = await fetch(`/api/inbox?view=${encodeURIComponent(view)}&offset=${offset}`);
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      if (requestSequence !== refreshSequenceRef.current) return;
      setData((current) => ({
        ...result,
        items: [...current.items, ...result.items],
        notifications: [...current.notifications, ...result.notifications],
      }));
    } catch (caught) {
      if (requestSequence === refreshSequenceRef.current) {
        setError(caught.message || "More queue items could not be loaded.");
      }
    } finally {
      loadMoreRef.current = false;
      setLoadingMore(false);
    }
  }, [data.page, view]);

  return { data, error, loadMore, loading, loadingMore, refresh, setData, setError };
}
