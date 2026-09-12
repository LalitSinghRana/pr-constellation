import { AlertTriangle, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button.jsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.jsx";
import { useQuery } from "@/hooks/use-query.js";
import { probeAnalysisAgent } from "@/lib/cockpit-api.js";
import { cn } from "@/lib/utils.js";

export function useAnalysisAgentStatus() {
  const query = useQuery({
    queryKey: ["analysis-agent", "probe"],
    queryFn: ({ signal }) => probeAnalysisAgent({ signal }),
  });

  const status = query.data ?? { accessible: null, message: "" };
  const error = query.error?.message || "";

  return {
    error,
    loading: query.isLoading,
    refetch: query.refetch,
    status,
    isPending: query.isPending,
  };
}

export function AnalysisAgentStatusDialog() {
  const { error, loading, refetch, status, isPending } = useAnalysisAgentStatus();
  const [open, setOpen] = useState(false);
  const [userDismissed, setUserDismissed] = useState(false);

  const needsAttention = Boolean(error) || status.accessible === false;
  const checking = isPending && (loading || status.accessible !== null);

  useEffect(() => {
    if (loading || status.accessible == null || userDismissed) {
      return;
    }
    setOpen(needsAttention);
  }, [loading, needsAttention, status.accessible, userDismissed]);

  function handleOpenChange(nextOpen) {
    if (!nextOpen) {
      setUserDismissed(true);
    }
    setOpen(nextOpen);
  }

  async function recheck() {
    const result = await refetch();
    if (result?.accessible) {
      setUserDismissed(false);
      setOpen(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="flex max-h-[min(90dvh,36rem)] w-[calc(100%-1.5rem)] max-w-md flex-col gap-4 overflow-hidden p-4 sm:w-full sm:p-6">
        <DialogHeader className="shrink-0 text-left">
          <p className="mb-2 flex items-center gap-2 text-[0.65rem] font-extrabold uppercase tracking-[0.14em] text-warning-strong">
            <AlertTriangle className="size-3.5 shrink-0" />
            Analysis setup
          </p>
          <DialogTitle className="text-balance">AI agent is not accessible</DialogTitle>
          <DialogDescription className="text-pretty">
            PR Constellation needs a working analysis agent to analyze pull requests. Recheck once
            access is restored.
          </DialogDescription>
        </DialogHeader>

        {checking ? (
          <div
            role="status"
            aria-live="polite"
            className="flex items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground"
          >
            <RefreshCw className="size-3.5 shrink-0 animate-spin" aria-hidden="true" />
            Checking AI agent access…
          </div>
        ) : error || status.message ? (
          <div className="min-h-0 max-h-[min(40vh,14rem)] overflow-y-auto overscroll-contain rounded-md border border-warning/25 bg-warning/10 px-3 py-2">
            <pre className="m-0 whitespace-pre-wrap break-words font-sans text-xs leading-5 text-warning-strong">
              {error || status.message}
            </pre>
          </div>
        ) : null}

        <DialogFooter className="shrink-0 sm:justify-end">
          <Button
            type="button"
            variant="outline"
            className="w-full sm:w-auto"
            disabled={checking}
            onClick={() => handleOpenChange(false)}
          >
            Dismiss
          </Button>
          <Button
            type="button"
            className="w-full sm:w-auto"
            disabled={checking}
            aria-busy={checking}
            onClick={recheck}
          >
            <RefreshCw className={cn("size-3.5", checking && "animate-spin")} aria-hidden="true" />
            {checking ? "Checking…" : "Recheck"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
