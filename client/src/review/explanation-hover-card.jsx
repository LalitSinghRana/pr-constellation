import { HoverCard, HoverCardContent, HoverCardTrigger } from "../components/ui/hover-card.jsx";
import { GitHubMarkdown } from "./github-markdown.jsx";

export function ExplanationHoverCard({ children, explanation, side = "top" }) {
  const text = String(explanation || "").trim();
  if (!text) {
    return children;
  }

  return (
    <HoverCard closeDelay={120} openDelay={220}>
      <HoverCardTrigger asChild>{children}</HoverCardTrigger>
      <HoverCardContent
        align="start"
        className="nodrag nopan nowheel max-h-[min(640px,calc(100vh-32px))] w-[min(520px,calc(100vw-32px))] overflow-x-hidden overflow-y-auto border-border bg-popover text-popover-foreground shadow-md"
        side={side}
        sideOffset={10}
      >
        <GitHubMarkdown body={text} className="text-sm font-normal leading-normal" />
      </HoverCardContent>
    </HoverCard>
  );
}

export function plainTextExplanation(explanation) {
  return String(explanation || "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}
