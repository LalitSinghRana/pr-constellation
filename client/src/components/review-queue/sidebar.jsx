import { ArrowUpRight, GitPullRequest, Settings2, Sparkles, TableProperties } from "lucide-react";
import { ThemeToggle } from "@/components/theme-toggle.jsx";
import {
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  Sidebar as SidebarRoot,
} from "@/components/ui/sidebar.jsx";
import { FILTER_GROUPS } from "./config.jsx";

const menuButtonClass =
  "h-10 px-3 text-sidebar-foreground/70 data-[active=true]:shadow-[inset_2px_0_var(--primary)]";

export function Brand() {
  return (
    <a
      className="flex items-center gap-3 px-2 text-inherit no-underline"
      href="/"
      aria-label="PR Review Cockpit home"
    >
      <span
        className="grid size-10 place-items-center rounded-sm border border-primary/35 bg-primary/12 text-primary"
        aria-hidden="true"
      >
        <GitPullRequest className="size-5" strokeWidth={2.3} />
      </span>
      <span>
        <strong className="block text-[0.95rem] tracking-[-0.01em]">Review cockpit</strong>
        <small className="mt-0.5 block text-[0.7rem] text-sidebar-muted">Local GitHub queue</small>
      </span>
    </a>
  );
}

function AppSidebar({ children, footer }) {
  return (
    <SidebarRoot className="border-sidebar-border">
      <SidebarHeader className="px-5 pb-2 pt-7">
        <div className="flex items-center justify-between gap-2">
          <Brand />
          <ThemeToggle />
        </div>
      </SidebarHeader>
      <SidebarContent className="px-3 py-2">
        <nav aria-label="Cockpit navigation">{children}</nav>
      </SidebarContent>
      {footer && <SidebarFooter className="px-5 pb-5">{footer}</SidebarFooter>}
      <SidebarRail />
    </SidebarRoot>
  );
}

function NavigationGroup({ label, children }) {
  return (
    <SidebarGroup className="p-0 [&+&]:mt-4">
      <SidebarGroupLabel className="h-7 px-3 text-[0.61rem] font-extrabold uppercase tracking-[0.13em] text-sidebar-foreground/55">
        {label}
      </SidebarGroupLabel>
      <SidebarGroupContent>
        <SidebarMenu>{children}</SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}

export function QueueSidebar({ activeFilter, counts, onFilter, onSettings }) {
  return (
    <AppSidebar
      footer={
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton asChild className={menuButtonClass}>
              <a href="/analysis" target="_blank" rel="noreferrer">
                <Sparkles />
                <span>AI analyzer queue</span>
                <ArrowUpRight className="ml-auto" />
              </a>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton className={menuButtonClass} onClick={onSettings}>
              <Settings2 />
              <span>Configure team</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton asChild className={menuButtonClass}>
              <a href="/scoring">
                <TableProperties />
                <span>Scoring details</span>
                <ArrowUpRight className="ml-auto" />
              </a>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      }
    >
      {FILTER_GROUPS.map((group) => (
        <NavigationGroup key={group.label} label={group.label}>
          {group.filters.map(({ id, label, icon: Icon }) => (
            <SidebarMenuItem key={id}>
              <SidebarMenuButton
                className={menuButtonClass}
                isActive={activeFilter === id}
                onClick={() => onFilter(id)}
              >
                <Icon />
                <span>{label}</span>
              </SidebarMenuButton>
              <SidebarMenuBadge>{counts[id]}</SidebarMenuBadge>
            </SidebarMenuItem>
          ))}
        </NavigationGroup>
      ))}
    </AppSidebar>
  );
}
