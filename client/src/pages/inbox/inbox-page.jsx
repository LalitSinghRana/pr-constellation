import { Bell } from "lucide-react";
import { Button } from "@/components/ui/button.jsx";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar.jsx";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs.jsx";
import { useDocumentTitle } from "@/hooks/use-document-title.js";
import { repositoryTabLabel } from "@/lib/queue.js";
import { AddPullRequestDialog } from "./add-pull-request-dialog.jsx";
import { LIFECYCLE_META } from "./config.jsx";
import { NotificationDateGroup, PullRequestDateGroup } from "./inbox-date-group.jsx";
import { InboxClear, InboxLoadError, LoadingInbox } from "./inbox-empty.jsx";
import { InboxSection } from "./inbox-section.jsx";
import { InboxSidebar } from "./sidebar.jsx";
import { useInboxPage } from "./use-inbox-page.js";

export function InboxPage() {
  useDocumentTitle({ title: "Inbox · PR Constellation" });
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
          <div className="mb-5 flex flex-wrap items-center gap-3">
            <SidebarTrigger className="md:hidden" />
            <h1 className="sr-only">{LIFECYCLE_META[inbox.activeFilter]?.label ?? "Inbox"}</h1>
            <div className="ml-auto">
              <AddPullRequestDialog
                error={inbox.addPullRequestError}
                onAdd={inbox.onAddPullRequest}
                pending={inbox.addPullRequestPending}
              />
            </div>
          </div>

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
                      {repositoryTabLabel(project.repository)}
                      <span className="min-w-5 rounded-full bg-muted px-1.5 py-0.5 text-[0.64rem] tabular-nums text-muted-foreground group-data-[state=active]:bg-primary/10 group-data-[state=active]:text-primary">
                        {project.count}
                      </span>
                    </TabsTrigger>
                  ))}
                </TabsList>
              </Tabs>
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
