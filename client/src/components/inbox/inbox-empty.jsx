import { AlertTriangle, Check } from "lucide-react";
import { Button } from "@/components/ui/button.jsx";
import { Card } from "@/components/ui/card.jsx";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty.jsx";
import { Skeleton } from "@/components/ui/skeleton.jsx";
import { cn } from "@/lib/utils.js";

const emptyClassName =
  "min-h-80 overflow-hidden rounded-lg border border-solid bg-card/75 shadow-lg backdrop-blur-sm";

export function LoadingInbox() {
  return (
    <Card
      className="grid min-h-72 gap-5 rounded-lg bg-card/75 p-6 shadow-lg backdrop-blur-sm"
      aria-label="Building your current inbox"
    >
      {["w-3/5", "w-4/5", "w-2/3"].map((width) => (
        <div className="flex items-center gap-4" key={width}>
          <Skeleton className="size-12 shrink-0 rounded-xl" />
          <div className="grid flex-1 gap-2">
            <Skeleton className={cn("h-4", width)} />
            <Skeleton className="h-3 w-2/5" />
          </div>
        </div>
      ))}
      <span className="sr-only">Building your current inbox…</span>
    </Card>
  );
}

export function InboxLoadError({ error, onRetry }) {
  return (
    <Empty className={emptyClassName}>
      <EmptyHeader>
        <EmptyMedia
          className="rounded-full border bg-background border-coral/30 text-coral-strong"
          variant="icon"
        >
          <AlertTriangle />
        </EmptyMedia>
        <EmptyTitle className="font-display text-2xl font-semibold">
          GitHub could not be loaded
        </EmptyTitle>
        <EmptyDescription>{error}</EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button onClick={onRetry}>Retry</Button>
      </EmptyContent>
    </Empty>
  );
}

export function InboxClear({ children }) {
  return (
    <Empty className={emptyClassName}>
      <EmptyHeader>
        <EmptyMedia
          className="rounded-full border bg-background border-primary/25 text-primary"
          variant="icon"
        >
          <Check />
        </EmptyMedia>
        <EmptyTitle className="font-display text-2xl font-semibold">This view is clear</EmptyTitle>
        <EmptyDescription>No current items match this lifecycle.</EmptyDescription>
      </EmptyHeader>
      {children ? <EmptyContent>{children}</EmptyContent> : null}
    </Empty>
  );
}
