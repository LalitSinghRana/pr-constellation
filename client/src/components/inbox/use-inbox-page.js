import { parseAsString, useQueryState } from "nuqs";
import { useCallback, useEffect, useMemo, useState } from "react";
import { LIFECYCLE_META, LIFECYCLE_ORDER } from "@/components/inbox/config.jsx";
import { useAnalysisDashboard } from "@/hooks/use-analysis-dashboard.js";
import { useInbox } from "@/hooks/use-inbox.js";
import { useMutation } from "@/hooks/use-mutation.js";
import { readJson } from "@/hooks/use-query.js";
import { useSettingsQuery } from "@/hooks/use-settings.js";
import {
  EMPTY_SETTINGS,
  groupByUpdatedDate,
  inboxProjectTabs,
  isOpenAuthoredPullRequest,
  matchesPrFilter,
} from "@/lib/queue.js";

export function useInboxPage() {
  const [activeFilter, setActiveFilter] = useQueryState("filter", parseAsString.withDefault("new"));
  const [activeProject, setActiveProject] = useQueryState("project", parseAsString.withDefault(""));
  const { data, error, loadMore, loading, loadingMore, refresh, setData, setError } = useInbox(
    activeFilter === "done" ? "done" : "active",
  );
  const {
    dashboard: analysisDashboard,
    error: analysisServiceError,
    refresh: refreshAnalyses,
  } = useAnalysisDashboard();
  const settingsQuery = useSettingsQuery();
  const [settings, setSettings] = useState(EMPTY_SETTINGS);
  const [inboxActionError, setInboxActionError] = useState("");
  const [analysisActionError, setAnalysisActionError] = useState("");
  const analysisError = analysisActionError || analysisServiceError;

  const analyzeMutation = useMutation({
    mutationFn: async ({ item, options }) => {
      const response = await fetch("/api/analyses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...item,
          score: item.score,
          ...(options.prioritize ? { prioritize: true } : {}),
        }),
      });
      return readJson(response);
    },
    onSuccess: () => refreshAnalyses(),
    onError: (caught) => {
      setAnalysisActionError(caught.message || "AI analysis could not be queued.");
    },
  });
  const prioritizeMutation = useMutation({
    mutationFn: async (analysis) => {
      const response = await fetch(
        `/api/runs/${encodeURIComponent(analysis.slug)}/${encodeURIComponent(analysis.runId)}/prioritize`,
        { method: "POST", headers: { "Content-Type": "application/json" } },
      );
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || "Could not prioritize analysis.");
      return result;
    },
    onSuccess: () => refreshAnalyses(),
    onError: (caught) => {
      setAnalysisActionError(caught.message || "Could not prioritize analysis.");
    },
  });
  const markReadMutation = useMutation({
    mutationFn: async (item) => {
      const response = await fetch("/api/inbox/items", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: item.id, read: true }),
      });
      return readJson(response);
    },
    onSuccess: (result) => {
      setData((current) => ({
        ...current,
        items: current.items.map((entry) =>
          entry.id === result.id ? { ...entry, ...result } : entry,
        ),
      }));
    },
    onError: (caught) => {
      setInboxActionError(caught.message || "Read state could not be saved.");
    },
  });
  const toggleDoneMutation = useMutation({
    mutationFn: async ({ value, ids }) => {
      const response = await fetch("/api/inbox/items", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          Array.isArray(value) ? { ids, done: true } : { id: value.id, done: !value.done },
        ),
      });
      return readJson(response);
    },
    onSuccess: (result) => {
      if (result.warning) setInboxActionError(result.warning);
      const updated = new Set(result.ids ?? [result.id]);
      const patch = result.ids ? { done: result.done, hasUpdates: result.hasUpdates } : result;
      const update = (entry) => (updated.has(entry.id) ? { ...entry, ...patch } : entry);
      setData((current) => ({
        ...current,
        items: current.items.map(update),
        notifications: current.notifications.map(update),
      }));
    },
    onError: (caught) => {
      setInboxActionError(caught.message || "Done state could not be saved.");
    },
  });

  const doneMutation = toggleDoneMutation.isPending
    ? (toggleDoneMutation.variables?.ids ?? [])
    : [];
  const analysisMutation = analyzeMutation.isPending
    ? analyzeMutation.variables?.item?.id || ""
    : "";
  const prioritizeMutationKey = prioritizeMutation.isPending
    ? prioritizeMutation.variables?.url || prioritizeMutation.variables?.slug || ""
    : "";

  const isDone = useCallback((item) => Boolean(item.done), []);

  useEffect(() => {
    if (settingsQuery.data) setSettings(settingsQuery.data);
  }, [settingsQuery.data]);

  useEffect(() => {
    if (!settingsQuery.error) return;
    setError(settingsQuery.error.message || "Local settings could not be loaded.");
  }, [settingsQuery.error, setError]);

  const openPrs = useMemo(() => data.items.filter((item) => !isDone(item)), [data.items, isDone]);
  const openNotifications = useMemo(
    () => data.notifications.filter((item) => !isDone(item)),
    [data.notifications, isDone],
  );
  const analyses = useMemo(
    () =>
      new Map(
        (analysisDashboard.prs ?? analysisDashboard.pullRequests ?? []).map((pr) => [pr.url, pr]),
      ),
    [analysisDashboard],
  );
  const counts = useMemo(() => {
    const derived = {
      reviewed: openPrs.filter((item) => !item.authored && item.lifecycle === "reviewed").length,
      new: openPrs.filter((item) => !item.authored && item.lifecycle === "new").length,
      approved: openPrs.filter((item) => !item.authored && item.lifecycle === "approved").length,
      merged: openPrs.filter((item) => item.lifecycle === "merged").length,
      closed: openPrs.filter((item) => item.lifecycle === "closed").length,
      draft: openPrs.filter((item) => !item.authored && item.lifecycle === "draft").length,
      mine: openPrs.filter((item) => isOpenAuthoredPullRequest(item)).length,
      other: openPrs.filter((item) => item.lifecycle === "other" && !item.authored).length,
      nonpr: openNotifications.length,
    };
    return { ...derived, ...data.counts };
  }, [data.counts, openNotifications.length, openPrs]);

  const availableProjects = useMemo(
    () => inboxProjectTabs(data.items, activeFilter, isDone),
    [activeFilter, data.items, isDone],
  );

  const selectedProject = useMemo(() => {
    if (activeFilter === "nonpr") return "";
    if (availableProjects.some((project) => project.repository === activeProject)) {
      return activeProject;
    }
    return availableProjects[0]?.repository ?? "";
  }, [activeFilter, activeProject, availableProjects]);

  const { visiblePrs, visibleNotifications } = useMemo(() => {
    const completed = activeFilter === "done";
    const prs = data.items
      .filter((item) => {
        if (isDone(item) !== completed) return false;
        if (selectedProject && item.repository !== selectedProject) return false;
        return matchesPrFilter(item, activeFilter);
      })
      .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt) || b.score - a.score);
    const notifications = data.notifications
      .filter((item) => isDone(item) === completed && ["nonpr", "done"].includes(activeFilter))
      .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
    return { visiblePrs: prs, visibleNotifications: notifications };
  }, [activeFilter, data.items, data.notifications, isDone, selectedProject]);

  const inboxSections = useMemo(() => {
    if (activeFilter === "done") {
      const sections = LIFECYCLE_ORDER.map((id) => {
        const items = visiblePrs.filter((item) => item.lifecycle === id);
        return {
          id,
          label: LIFECYCLE_META[id].label,
          score: LIFECYCLE_META[id].score,
          count: items.length,
          groups: groupByUpdatedDate(items),
        };
      }).filter((section) => section.count);
      if (visibleNotifications.length) {
        sections.push({
          id: "nonpr",
          label: "Issues & other notifications",
          score: null,
          count: visibleNotifications.length,
          groups: groupByUpdatedDate(visibleNotifications),
        });
      }
      return sections;
    }

    const items = activeFilter === "nonpr" ? visibleNotifications : visiblePrs;
    return [
      {
        id: activeFilter,
        label: LIFECYCLE_META[activeFilter]?.label ?? "Inbox",
        score: activeFilter === "mine" ? null : (LIFECYCLE_META[activeFilter]?.score ?? null),
        count: items.length,
        groups: groupByUpdatedDate(items),
      },
    ];
  }, [activeFilter, visibleNotifications, visiblePrs]);

  function analyze(item, options = {}) {
    setAnalysisActionError("");
    analyzeMutation.mutate({ item, options });
  }

  function prioritize(analysis) {
    if (!analysis?.slug || !analysis?.runId) return;
    setAnalysisActionError("");
    prioritizeMutation.mutate(analysis);
  }

  function markRead(item) {
    if (item.read) return;
    markReadMutation.mutate(item);
  }

  function toggleDone(value) {
    const items = Array.isArray(value) ? value.filter((item) => !item.done) : [value];
    const ids = items.map((item) => item.id);
    if (!ids.length) return;
    setInboxActionError("");
    toggleDoneMutation.mutate({ value, ids });
  }

  return {
    activeFilter,
    analyses,
    analysisError,
    analysisMutation,
    availableProjects,
    counts,
    data,
    doneMutation,
    error,
    inboxActionError,
    inboxSections,
    isDone,
    loadMore,
    loading,
    loadingMore,
    onAnalyze: analyze,
    onMarkRead: markRead,
    onPrioritize: prioritize,
    onToggleDone: toggleDone,
    prioritizeMutation: prioritizeMutationKey,
    refresh,
    selectedProject,
    setActiveFilter,
    setActiveProject,
    settings,
    visibleCount: visiblePrs.length + visibleNotifications.length,
  };
}
