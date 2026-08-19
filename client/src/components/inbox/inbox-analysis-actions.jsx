import { ArrowUp, Check, LoaderCircle, RotateCcw, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button.jsx";

export function InboxAnalysisActions({
  analysis,
  analysisBusy,
  item,
  onAnalyze,
  onMarkRead,
  onPrioritize,
  prioritizeBusy,
}) {
  if (analysis.href) {
    return (
      <>
        <a
          className="inline-flex h-8 items-center justify-center gap-1 rounded-[0.5rem] px-[0.55rem] text-[0.75rem] font-bold text-primary no-underline hover:bg-primary/9"
          href={analysis.href}
          target="_blank"
          rel="noreferrer"
          onClick={() => onMarkRead(item)}
        >
          <Sparkles className="size-3.5" />
          Open review
        </a>
        {analysis.active?.status === "queued" ? (
          <Button
            size="sm"
            variant="outline"
            disabled={prioritizeBusy || analysis.bumped}
            onClick={() => onPrioritize(analysis)}
            title={analysis.bumped ? "Already at the front of the queue" : "Move to front of queue"}
          >
            {prioritizeBusy ? (
              <LoaderCircle className="size-3.5 animate-spin" />
            ) : (
              <ArrowUp className="size-3.5" />
            )}
            {analysis.bumped ? "Prioritized" : "Prioritize"}
          </Button>
        ) : analysis.active?.status === "running" ? (
          <Button size="sm" variant="outline" disabled>
            <LoaderCircle className="size-3.5 animate-spin" />
            Analyzing
          </Button>
        ) : (
          <Button
            size="icon-sm"
            variant="outline"
            disabled={analysisBusy}
            onClick={() => onAnalyze(item)}
            aria-label="Retry analysis"
            title="Retry analysis"
          >
            {analysisBusy ? (
              <LoaderCircle className="size-3.5 animate-spin" />
            ) : (
              <RotateCcw className="size-3.5" />
            )}
          </Button>
        )}
      </>
    );
  }
  if (analysis.active?.status === "queued") {
    return (
      <Button
        size="sm"
        variant="outline"
        disabled={prioritizeBusy || analysis.bumped}
        onClick={() => onPrioritize(analysis)}
        title={analysis.bumped ? "Already at the front of the queue" : "Move to front of queue"}
      >
        {prioritizeBusy ? (
          <LoaderCircle className="size-3.5 animate-spin" />
        ) : (
          <ArrowUp className="size-3.5" />
        )}
        {analysis.bumped ? "Prioritized" : "Prioritize"}
      </Button>
    );
  }
  return (
    <Button
      size="sm"
      variant="outline"
      disabled={analysisBusy || analysis.active?.status === "running"}
      onClick={() => onAnalyze(item)}
    >
      {analysisBusy || analysis.active?.status === "running" ? (
        <LoaderCircle className="size-3.5 animate-spin" />
      ) : (
        <Sparkles className="size-3.5" />
      )}
      {analysisBusy ? "Queueing" : analysis.active?.status === "running" ? "Analyzing" : "Analyze"}
    </Button>
  );
}

export function MarkDoneOrRestore({ completed, doneBusy, item, onToggleDone }) {
  return (
    <Button
      size={completed ? "sm" : "icon-sm"}
      variant="outline"
      disabled={doneBusy}
      onClick={() => onToggleDone(item)}
      aria-label={completed ? undefined : "Mark done"}
      title={completed ? undefined : "Mark done"}
    >
      {doneBusy ? (
        <LoaderCircle className="size-3.5 animate-spin" />
      ) : completed ? (
        <>
          <RotateCcw className="size-3.5" />
          Restore
        </>
      ) : (
        <Check className="size-3.5 text-emerald-700" />
      )}
    </Button>
  );
}
