import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card.jsx";
import { ACTIVITY_SIGNAL_KINDS } from "@/lib/queue.js";

export const titleClassName = "text-[17px] font-semibold leading-snug tracking-[-0.015em]";

export const signalStyles = {
  "direct-review": "border-coral/20 bg-coral/10 text-coral-strong",
  "teammate-pr": "border-ochre/25 bg-ochre/10 text-ochre-strong",
  "team-review": "border-lilac/25 bg-lilac/10 text-lilac-strong",
};

export function ActivityHoverCard({ children, updates, since = "last open" }) {
  return (
    <HoverCard openDelay={250} closeDelay={100}>
      <HoverCardTrigger asChild>{children}</HoverCardTrigger>
      <HoverCardContent
        align="center"
        className="w-80 border-border bg-popover text-xs leading-relaxed text-popover-foreground shadow-xl"
        side="top"
        sideOffset={8}
      >
        <strong className="block text-[0.68rem] uppercase tracking-[0.06em]">
          Changes since {since}
        </strong>
        {updates.length ? (
          <ul className="mt-1 list-disc pl-4">
            {updates.map((update) => (
              <li key={update}>{update}</li>
            ))}
          </ul>
        ) : (
          <p className="mt-1 text-muted-foreground">No new activity.</p>
        )}
      </HoverCardContent>
    </HoverCard>
  );
}

export function activityUpdates(item) {
  const reviewRequest =
    item.signals.find((signal) => signal.kind === "direct-review") ??
    item.signals.find((signal) => signal.kind === "team-review");
  const reportedUpdates = item.updatesSinceRead ?? [];
  const signalUpdates = item.read
    ? []
    : [...item.signals]
        .filter((signal) => ACTIVITY_SIGNAL_KINDS.has(signal.kind))
        .filter(
          (signal) =>
            !["direct-review", "team-review"].includes(signal.kind) || signal === reviewRequest,
        )
        .sort((left, right) => right.weight - left.weight)
        .filter(
          (signal) =>
            !(
              (signal.kind === "new-commits" && reportedUpdates.includes("New commits")) ||
              (signal.kind === "new-comments" &&
                reportedUpdates.some((update) => /new comments?$/.test(update)))
            ),
        )
        .map((signal) => `${signal.label}${signal.detail ? ` · ${signal.detail}` : ""}`);
  const initialUpdates =
    item.read || item.authored
      ? []
      : [
          `Pull request opened${item.author ? ` by ${item.author}` : ""}`,
          Number.isInteger(item.additions) && Number.isInteger(item.deletions)
            ? `+${item.additions} −${item.deletions}${Number.isInteger(item.changedFiles) ? ` across ${item.changedFiles} changed ${item.changedFiles === 1 ? "file" : "files"}` : ""}`
            : Number.isInteger(item.changedFiles)
              ? `${item.changedFiles} changed ${item.changedFiles === 1 ? "file" : "files"}`
              : null,
          item.comments > 0
            ? `${item.comments} ${item.comments === 1 ? "comment" : "comments"}`
            : null,
          item.draft ? "Opened as draft" : null,
          item.state === "MERGED" ? "Merged" : null,
        ].filter(Boolean);
  const fallbackUpdates = reportedUpdates.length
    ? reportedUpdates[0] === "PR activity changed" && signalUpdates.length
      ? []
      : reportedUpdates
    : initialUpdates;
  return [...new Set([...signalUpdates, ...fallbackUpdates])];
}
