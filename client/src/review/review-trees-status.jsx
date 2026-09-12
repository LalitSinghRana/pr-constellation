import { LoaderCircle, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button.jsx";

const retryStatuses = new Set(["canceled", "failed", "interrupted", "not_started"]);

const statusCopy = {
  not_started: {
    title: "AI analysis has not been started",
    detail: "Conversation and other review tabs still work. Start analysis to build Review Trees.",
  },
  queued: {
    title: "Analysis is queued",
    detail: "Review Trees will appear here when this pull request reaches the front of the queue.",
  },
  running: {
    title: "Analysis is in progress",
    detail: "Review Trees will appear here when generation finishes.",
  },
  failed: {
    title: "Analysis failed",
    detail: "Retry analysis to generate Review Trees. Conversation still works.",
  },
  interrupted: {
    title: "Analysis was interrupted",
    detail: "Retry analysis to generate Review Trees. Conversation still works.",
  },
  canceled: {
    title: "Analysis was canceled",
    detail: "Retry analysis to generate Review Trees. Conversation still works.",
  },
};

export function ReviewTreesStatus({ analysisBusy, onAnalyze, status }) {
  const copy = statusCopy[status] ?? statusCopy.not_started;
  const showAnalyze = retryStatuses.has(status);
  const running = status === "queued" || status === "running" || analysisBusy;

  return (
    <section
      aria-label="Review trees unavailable"
      className="grid size-full min-h-0 place-items-center overflow-hidden rounded-none border-0 bg-card px-6 text-center shadow-none"
    >
      <div className="max-w-md space-y-3">
        <h2 className="text-lg font-semibold tracking-tight">{copy.title}</h2>
        <p className="text-sm text-muted-foreground">{copy.detail}</p>
        {showAnalyze && onAnalyze ? (
          <Button disabled={running} onClick={onAnalyze} type="button">
            {running ? (
              <LoaderCircle className="size-3.5 animate-spin" />
            ) : (
              <Sparkles className="size-3.5" />
            )}
            {analysisBusy ? "Queueing" : status === "not_started" ? "Analyze" : "Retry analysis"}
          </Button>
        ) : null}
      </div>
    </section>
  );
}
