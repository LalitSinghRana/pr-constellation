import { ArrowUp, Check, LoaderCircle, RotateCcw, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button.jsx";

export function InboxAnalysisActions({
  analysis,
  analysisBusy,
  item,
  onAnalyze,
  onPrioritize,
  prioritizeBusy,
}) {
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
  if (analysis.active?.status === "running" || analysisBusy) {
    return (
      <Button size="sm" variant="outline" disabled>
        <LoaderCircle className="size-3.5 animate-spin" />
        {analysisBusy ? "Queueing" : "Analyzing"}
      </Button>
    );
  }
  if (analysis.href || analysis.pastSuccess) {
    return (
      <Button
        size="icon-sm"
        variant="outline"
        onClick={() => onAnalyze(item)}
        aria-label="Retry analysis"
        title="Retry analysis"
      >
        <RotateCcw className="size-3.5" />
      </Button>
    );
  }
  return (
    <Button size="sm" variant="outline" onClick={() => onAnalyze(item)}>
      <Sparkles className="size-3.5" />
      Analyze
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
        <Check className="size-3.5 text-success" />
      )}
    </Button>
  );
}
