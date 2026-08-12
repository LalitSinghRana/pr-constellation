import { AlertTriangle, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button.jsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.jsx";
import { cn } from "@/lib/utils.js";

const EMPTY_STATUS = {
  accessible: null,
  message: "",
};

export function useAnalysisAgentStatus() {
  const [status, setStatus] = useState(EMPTY_STATUS);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/analysis-agent/probe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "AI agent probe failed.");
      const agent = body.agent ?? {};
      const accessible = agent.accessible === true;
      setStatus({
        accessible,
        message: agent.message || "",
      });
      return { accessible, error: "" };
    } catch (caught) {
      const message = caught.message || "AI agent probe failed.";
      setStatus(EMPTY_STATUS);
      setError(message);
      return { accessible: false, error: message };
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { error, loading, refresh, status };
}

export function AnalysisAgentStatusDialog() {
  const { error, loading, refresh, status } = useAnalysisAgentStatus();
  const [open, setOpen] = useState(false);

  const needsAttention = Boolean(error) || status.accessible === false;

  useEffect(() => {
    if (loading || status.accessible == null) return;
    setOpen(needsAttention);
  }, [loading, needsAttention, status.accessible]);

  async function recheck() {
    const result = await refresh();
    if (result.accessible && !result.error) {
      setOpen(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={() => {}}>
      <DialogContent
        className="sm:max-w-md"
        showCloseButton={false}
        onEscapeKeyDown={(event) => event.preventDefault()}
        onPointerDownOutside={(event) => event.preventDefault()}
        onInteractOutside={(event) => event.preventDefault()}
      >
        <DialogHeader>
          <p className="mb-2 flex items-center gap-2 text-[0.65rem] font-extrabold uppercase tracking-[0.14em] text-ochre-strong">
            <AlertTriangle className="size-3.5" />
            Analysis setup
          </p>
          <DialogTitle>AI agent is not accessible</DialogTitle>
          <DialogDescription>
            This cockpit needs a working AI agent to analyze pull requests. Recheck once access is
            restored.
          </DialogDescription>
        </DialogHeader>

        {(error || status.message) && (
          <p className="rounded-md border border-ochre/25 bg-ochre/10 px-3 py-2 text-xs text-ochre-strong">
            {error || status.message}
          </p>
        )}

        <DialogFooter>
          <Button type="button" disabled={loading} onClick={recheck}>
            <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
            Recheck
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
