import { Badge } from "@/components/ui/badge.jsx";

export function InboxSection({ children, label }) {
  return (
    <section className="grid gap-3" aria-label={`${label} inbox`}>
      {children}
    </section>
  );
}

function InboxSectionHeader({ count, icon: Icon, label }) {
  return (
    <header className="flex min-h-[3.25rem] items-center justify-between gap-4 p-1 max-[700px]:px-[0.9rem]">
      <h2 className="m-0 flex items-center gap-[0.55rem] font-display text-[1.15rem] font-[650] tracking-[-0.02em]">
        <Icon className="size-4 text-primary" aria-hidden="true" />
        {label}
      </h2>
      <span className="flex items-center gap-[0.55rem]">
        <Badge variant="outline">{count}</Badge>
      </span>
    </header>
  );
}

InboxSection.Header = InboxSectionHeader;
