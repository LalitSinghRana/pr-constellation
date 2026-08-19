import { ArrowLeft, LoaderCircle, Sparkles, X } from "lucide-react";
import { Button } from "@/components/ui/button.jsx";

export function AnalysisQueueToolbar({
  analysisRunning,
  canQueueAll,
  canceling,
  loading,
  onCancelAll,
  onQueueAll,
  queueAllPending,
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <Button asChild variant="ghost">
        <a href="/">
          <ArrowLeft className="size-4" />
          Inbox
        </a>
      </Button>
      <div className="flex flex-wrap gap-2">
        <Button
          className="text-coral-strong"
          disabled={canceling || !analysisRunning}
          onClick={onCancelAll}
          variant="outline"
        >
          <X className="size-4" />
          Cancel all
        </Button>
        <Button
          disabled={loading || queueAllPending || !canQueueAll}
          onClick={onQueueAll}
          title={canQueueAll ? "Queue every inbox PR except your own" : "Nothing left to queue"}
        >
          {queueAllPending ? (
            <LoaderCircle className="size-4 animate-spin" />
          ) : (
            <Sparkles className="size-4" />
          )}
          {queueAllPending ? "Queueing" : "Queue all"}
        </Button>
      </div>
    </div>
  );
}
