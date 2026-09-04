import { parseAsString, useQueryState } from "nuqs";
import { createElement, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useAnalysisDashboard } from "@/hooks/use-analysis-dashboard.js";
import { useInbox } from "@/hooks/use-inbox.js";
import { useMutation } from "@/hooks/use-mutation.js";
import { readJson } from "@/hooks/use-query.js";
import { useSettingsQuery } from "@/hooks/use-settings.js";
import {
  EMPTY_SETTINGS,
  groupByUpdatedDate,
  inboxJumpHref,
  inboxProjectTabs,
  isOpenAuthoredPullRequest,
  matchesPrFilter,
} from "@/lib/queue.js";
import { LIFECYCLE_META, LIFECYCLE_ORDER } from "./config.jsx";
import { InboxToastJump } from "./inbox-toast-jump.jsx";

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
  const syncWarningsKeyRef = useRef("[]");
  const analysisServiceErrorRef = useRef("");

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
      toast.error(caught.message || "AI analysis could not be queued.");
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
      toast.error(caught.message || "Could not prioritize analysis.");
    },
  });
  const addPullRequestMutation = useMutation({
    mutationFn: async (url) => {
      const response = await fetch("/api/inbox/items", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      return readJson(response);
    },
    onSuccess: async (result) => {
      const jump = inboxJumpLink(result);
      const options = jump ? { description: jump } : undefined;
      if (result.warning) {
        toast.warning(result.warning, options);
      } else {
        toast.success("Added to inbox", options);
      }
      await refresh();
    },
    onError: (caught) => {
      toast.error(caught.message || "That pull request could not be added.");
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
      toast.error(caught.message || "Read state could not be saved.");
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
      if (result.warning) toast.warning(result.warning);
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
      toast.error(caught.message || "Done state could not be saved.");
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

  function isDone(item) {
    return Boolean(item.done);
  }

  useEffect(() => {
    if (settingsQuery.data) setSettings(settingsQuery.data);
  }, [settingsQuery.data]);

  useEffect(() => {
    if (!settingsQuery.error) return;
    setError(settingsQuery.error.message || "Local settings could not be loaded.");
  }, [settingsQuery.error, setError]);

  useEffect(() => {
    const warnings = (data.warnings ?? []).filter(
      (warning) => typeof warning === "string" && warning,
    );
    const previous = new Set(JSON.parse(syncWarningsKeyRef.current));
    for (const warning of warnings) {
      if (!previous.has(warning)) toast.warning(warning);
    }
    syncWarningsKeyRef.current = JSON.stringify(warnings);
  }, [data.warnings]);

  useEffect(() => {
    const message = analysisServiceError || "";
    if (message && message !== analysisServiceErrorRef.current) {
      toast.error(message);
    }
    analysisServiceErrorRef.current = message;
  }, [analysisServiceError]);

  const openPrs = data.items.filter((item) => !isDone(item));
  const openNotifications = data.notifications.filter((item) => !isDone(item));
  const analyses = new Map(
    (analysisDashboard.prs ?? analysisDashboard.pullRequests ?? []).map((pr) => [pr.url, pr]),
  );
  const counts = (() => {
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
  })();

  const availableProjects = inboxProjectTabs(data.items, activeFilter, isDone);

  const selectedProject = (() => {
    if (activeFilter === "nonpr") return "";
    if (availableProjects.some((project) => project.repository === activeProject)) {
      return activeProject;
    }
    return availableProjects[0]?.repository ?? "";
  })();

  const { visiblePrs, visibleNotifications } = (() => {
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
  })();

  const inboxSections = (() => {
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
  })();

  function analyze(item, options = {}) {
    analyzeMutation.mutate({ item, options });
  }

  function prioritize(analysis) {
    if (!analysis?.slug || !analysis?.runId) return;
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
    toggleDoneMutation.mutate({ value, ids });
  }

  return {
    activeFilter,
    addPullRequestError: addPullRequestMutation.error?.message || "",
    addPullRequestPending: addPullRequestMutation.isPending,
    analyses,
    analysisMutation,
    availableProjects,
    counts,
    data,
    doneMutation,
    error,
    inboxSections,
    isDone,
    loadMore,
    loading,
    loadingMore,
    onAddPullRequest: addPullRequestMutation.mutateAsync,
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

function inboxJumpLink(item) {
  const href = inboxJumpHref(item);
  return href ? createElement(InboxToastJump, { href }) : undefined;
}
