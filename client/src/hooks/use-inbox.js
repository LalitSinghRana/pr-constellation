import { useCallback, useEffect, useRef, useState } from "react";
import { fetchInbox } from "../lib/cockpit-api.js";

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
    async (background = false) => {
      const requestSequence = ++refreshSequenceRef.current;
      if (!background) {
        loadingSequenceRef.current = requestSequence;
        setLoading(true);
        setError("");
      }
      try {
        const result = await fetchInbox({ view });
        if (requestSequence === refreshSequenceRef.current) setData(result);
      } catch (caught) {
        if (!background && requestSequence === refreshSequenceRef.current) {
          setError(caught.message || "Check your GitHub CLI login and retry.");
        }
      }
      if (!background && requestSequence === loadingSequenceRef.current) {
        setLoading(false);
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
      const result = await fetchInbox({ view, offset });
      if (requestSequence === refreshSequenceRef.current) {
        setData((current) => ({
          ...result,
          items: [...current.items, ...result.items],
          notifications: [...current.notifications, ...result.notifications],
        }));
      }
    } catch (caught) {
      if (requestSequence === refreshSequenceRef.current) {
        setError(caught.message || "More inbox items could not be loaded.");
      }
    }
    loadMoreRef.current = false;
    setLoadingMore(false);
  }, [data.page, view]);

  return { data, error, loadMore, loading, loadingMore, refresh, setData, setError };
}
