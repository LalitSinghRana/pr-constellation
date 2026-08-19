import { AlertTriangle } from "lucide-react";
import { parseAsString, useQueryState } from "nuqs";
import { useCallback, useEffect, useMemo, useState } from "react";
import { LIFECYCLE_META, LIFECYCLE_ORDER } from "@/components/inbox/config.jsx";
import { EmptyInbox, InboxSection, LoadingInbox } from "@/components/inbox/inbox-list.jsx";
import { InboxSidebar } from "@/components/inbox/sidebar.jsx";
import { Button } from "@/components/ui/button.jsx";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar.jsx";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs.jsx";
import { useAnalysisDashboard } from "@/hooks/use-analysis-dashboard.js";
import { useDocumentTitle } from "@/hooks/use-document-title.js";
import { useInbox } from "@/hooks/use-inbox.js";
import { useMutation } from "@/hooks/use-mutation.js";
import { readJson } from "@/hooks/use-query.js";
import { useSettingsQuery } from "@/hooks/use-settings.js";
import {
  EMPTY_SETTINGS,
  groupByUpdatedDate,
  inboxProjectTabs,
  matchesPrFilter,
} from "@/lib/queue.js";

export function InboxPage() {
  useDocumentTitle({ title: "Inbox · PR Review Cockpit" });
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
      merged: openPrs.filter((item) => !item.authored && item.lifecycle === "merged").length,
      closed: openPrs.filter((item) => !item.authored && item.lifecycle === "closed").length,
      draft: openPrs.filter((item) => !item.authored && item.lifecycle === "draft").length,
      mine: openPrs.filter((item) => item.authored).length,
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

  const visibleCount = visiblePrs.length + visibleNotifications.length;

  return (
    <SidebarProvider>
      <InboxSidebar activeFilter={activeFilter} counts={counts} onFilter={setActiveFilter} />

      <SidebarInset className="min-h-screen">
        <div className="mx-auto w-full max-w-[1240px] px-5 pb-20 pt-8 sm:px-8 lg:px-12 lg:pt-12">
          <SidebarTrigger className="mb-5 md:hidden" />
          <h1 className="sr-only">{LIFECYCLE_META[activeFilter]?.label ?? "Inbox"}</h1>

          <section aria-label="Repository inbox">
            {activeFilter !== "nonpr" && availableProjects.length > 0 && (
              <Tabs className="gap-0" value={selectedProject} onValueChange={setActiveProject}>
                <TabsList aria-label="Repositories" variant="cockpit">
                  {availableProjects.map((project) => (
                    <TabsTrigger
                      className="group"
                      key={project.repository}
                      title={project.repository}
                      value={project.repository}
                    >
                      {project.repository
                        .split("/")
                        .at(-1)
                        .split("-")
                        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
                        .join(" ")}
                      <span className="min-w-5 rounded-full bg-muted px-1.5 py-0.5 text-[0.64rem] tabular-nums text-muted-foreground group-data-[state=active]:bg-primary/10 group-data-[state=active]:text-primary">
                        {project.count}
                      </span>
                    </TabsTrigger>
                  ))}
                </TabsList>
              </Tabs>
            )}

            {data.warnings.length > 0 && (
              <div className="mx-3 mt-3 grid gap-2" aria-live="polite">
                {data.warnings.map((warning) => (
                  <p
                    className="flex items-center gap-2 rounded-lg border border-ochre/25 bg-ochre/10 px-3 py-2 text-xs text-ochre-strong"
                    key={warning}
                  >
                    <AlertTriangle className="size-3.5" />
                    {warning}
                  </p>
                ))}
              </div>
            )}

            {inboxActionError && (
              <p
                className="mx-3 mt-3 flex items-center gap-2 rounded-lg border border-coral/25 bg-coral/10 px-3 py-2 text-xs text-coral-strong"
                aria-live="polite"
              >
                <AlertTriangle className="size-3.5" />
                {inboxActionError}
              </p>
            )}

            {analysisError && (
              <p
                className="mx-3 mt-3 flex items-center gap-2 rounded-lg border border-coral/25 bg-coral/10 px-3 py-2 text-xs text-coral-strong"
                aria-live="polite"
              >
                <AlertTriangle className="size-3.5" />
                {analysisError}
              </p>
            )}

            <div className="mt-4 grid gap-6" aria-live="polite">
              {loading ? (
                <LoadingInbox />
              ) : error ? (
                <EmptyInbox error={error} onRetry={() => refresh()} />
              ) : visibleCount ? (
                inboxSections.map((section) => (
                  <InboxSection
                    key={section.id}
                    section={section}
                    isDone={isDone}
                    onToggleDone={toggleDone}
                    doneMutation={doneMutation}
                    analyses={analyses}
                    analysisMutation={analysisMutation}
                    onAnalyze={analyze}
                    onPrioritize={prioritize}
                    prioritizeMutation={prioritizeMutationKey}
                    onMarkRead={markRead}
                    showHeader={activeFilter === "done"}
                  />
                ))
              ) : (
                <EmptyInbox canConfigure={!settings.people.length && !settings.teams.length} />
              )}
            </div>
            {data.page?.hasMore && (
              <div className="mt-6 flex justify-center">
                <Button disabled={loadingMore} onClick={loadMore} variant="outline">
                  {loadingMore ? "Loading…" : "Load more"}
                </Button>
              </div>
            )}
          </section>
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}
