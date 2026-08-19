import ReactMarkdown from "react-markdown";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "../components/ui/hover-card.jsx";

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
        className="explanation-hover-card nodrag nopan nowheel max-h-[min(640px,calc(100vh_-_32px))] w-[min(520px,calc(100vw_-_32px))] overflow-x-hidden overflow-y-auto border-border bg-popover text-popover-foreground shadow-md"
        side={side}
        sideOffset={10}
      >
        <div className="explanation-hover-body text-base leading-relaxed font-medium text-foreground [overflow-wrap:anywhere] [&>:first-child]:mt-0 [&>:last-child]:mb-0 [&_code]:rounded-sm [&_code]:bg-muted [&_code]:px-1 [&_code]:py-px [&_code]:font-mono [&_code]:text-[0.92em] [&_code]:text-foreground [&_li]:pl-0.5 [&_li]:marker:text-muted-foreground [&_ol]:my-3 [&_ol]:grid [&_ol]:gap-2 [&_ol]:pl-5 [&_p]:my-2.5 [&_ul]:my-3 [&_ul]:grid [&_ul]:gap-2 [&_ul]:pl-5">
          <ReactMarkdown>{text}</ReactMarkdown>
        </div>
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
