import { AlertTriangle, Bell } from "lucide-react";
import { LIFECYCLE_META } from "@/components/inbox/config.jsx";
import {
  NotificationDateGroup,
  PullRequestDateGroup,
} from "@/components/inbox/inbox-date-group.jsx";
import { InboxClear, InboxLoadError, LoadingInbox } from "@/components/inbox/inbox-empty.jsx";
import { InboxSection } from "@/components/inbox/inbox-section.jsx";
import { InboxSidebar } from "@/components/inbox/sidebar.jsx";
import { useInboxPage } from "@/components/inbox/use-inbox-page.js";
import { Button } from "@/components/ui/button.jsx";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar.jsx";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs.jsx";
import { useDocumentTitle } from "@/hooks/use-document-title.js";

export function InboxPage() {
  useDocumentTitle({ title: "Inbox · PR Review Cockpit" });
  const inbox = useInboxPage();
  const showDoneHeader = inbox.activeFilter === "done";
  const GroupHeading = showDoneHeader ? "h3" : "h2";
  const RowHeading = showDoneHeader ? "h4" : "h3";
  const canConfigure = !inbox.settings.people.length && !inbox.settings.teams.length;

  return (
    <SidebarProvider>
      <InboxSidebar
        activeFilter={inbox.activeFilter}
        counts={inbox.counts}
        onFilter={inbox.setActiveFilter}
      />

      <SidebarInset className="min-h-screen">
        <div className="mx-auto w-full max-w-[1240px] px-5 pb-20 pt-8 sm:px-8 lg:px-12 lg:pt-12">
          <SidebarTrigger className="mb-5 md:hidden" />
          <h1 className="sr-only">{LIFECYCLE_META[inbox.activeFilter]?.label ?? "Inbox"}</h1>

          <section aria-label="Repository inbox">
            {inbox.activeFilter !== "nonpr" && inbox.availableProjects.length > 0 && (
              <Tabs
                className="gap-0"
                value={inbox.selectedProject}
                onValueChange={inbox.setActiveProject}
              >
                <TabsList aria-label="Repositories" variant="cockpit">
                  {inbox.availableProjects.map((project) => (
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

            {inbox.data.warnings.length > 0 && (
              <div className="mx-3 mt-3 grid gap-2" aria-live="polite">
                {inbox.data.warnings.map((warning) => (
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

            {inbox.inboxActionError && (
              <p
                className="mx-3 mt-3 flex items-center gap-2 rounded-lg border border-coral/25 bg-coral/10 px-3 py-2 text-xs text-coral-strong"
                aria-live="polite"
              >
                <AlertTriangle className="size-3.5" />
                {inbox.inboxActionError}
              </p>
            )}

            {inbox.analysisError && (
              <p
                className="mx-3 mt-3 flex items-center gap-2 rounded-lg border border-coral/25 bg-coral/10 px-3 py-2 text-xs text-coral-strong"
                aria-live="polite"
              >
                <AlertTriangle className="size-3.5" />
                {inbox.analysisError}
              </p>
            )}

            <div className="mt-4 grid gap-6" aria-live="polite">
              {inbox.loading ? (
                <LoadingInbox />
              ) : inbox.error ? (
                <InboxLoadError error={inbox.error} onRetry={() => inbox.refresh()} />
              ) : inbox.visibleCount ? (
                inbox.inboxSections.map((section) => (
                  <InboxSection key={section.id} label={section.label}>
                    {showDoneHeader ? (
                      <InboxSection.Header
                        count={section.count}
                        icon={LIFECYCLE_META[section.id]?.icon ?? Bell}
                        label={section.label}
                      />
                    ) : null}
                    <div className="grid gap-4">
                      {section.groups.map((group) =>
                        section.id === "nonpr" ? (
                          <NotificationDateGroup
                            key={group.label}
                            GroupHeading={GroupHeading}
                            RowHeading={RowHeading}
                            label={group.label}
                            items={group.items}
                            isDone={inbox.isDone}
                            onToggleDone={inbox.onToggleDone}
                            doneMutation={inbox.doneMutation}
                          />
                        ) : (
                          <PullRequestDateGroup
                            key={group.label}
                            GroupHeading={GroupHeading}
                            RowHeading={RowHeading}
                            label={group.label}
                            items={group.items}
                            isDone={inbox.isDone}
                            onToggleDone={inbox.onToggleDone}
                            doneMutation={inbox.doneMutation}
                            analyses={inbox.analyses}
                            analysisMutation={inbox.analysisMutation}
                            onAnalyze={inbox.onAnalyze}
                            onPrioritize={inbox.onPrioritize}
                            prioritizeMutation={inbox.prioritizeMutation}
                            onMarkRead={inbox.onMarkRead}
                          />
                        ),
                      )}
                    </div>
                  </InboxSection>
                ))
              ) : (
                <InboxClear>
                  {canConfigure ? (
                    <Button asChild variant="outline">
                      <a href="/settings#team">Add your team</a>
                    </Button>
                  ) : null}
                </InboxClear>
              )}
            </div>
            {inbox.data.page?.hasMore && (
              <div className="mt-6 flex justify-center">
                <Button disabled={inbox.loadingMore} onClick={inbox.loadMore} variant="outline">
                  {inbox.loadingMore ? "Loading…" : "Load more"}
                </Button>
              </div>
            )}
          </section>
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}
