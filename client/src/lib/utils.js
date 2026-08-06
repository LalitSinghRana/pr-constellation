import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs) {
  return twMerge(clsx(inputs));
}

export function analysisState({ latestRun, queuedRuns, runningRun }) {
  if (runningRun) return "running";
  if (queuedRuns.length) return "queued";
  if (!latestRun) return "not-started";
  return latestRun.status === "succeeded" ? "completed" : "failed";
}

export function analysisTimeline(run, now = Date.now()) {
  const stages = (run?.timings?.stages ?? []).filter((stage) => (
    (stage.stageId === "analysis" || stage.stageId.startsWith("analysis."))
    && stage.stageId !== "analysis.persist-artifacts"
    && stage.status !== "skipped"
  ));
  if (!stages.length) return { durationMs: 0, rows: [] };

  const byId = new Map(stages.map((stage) => [stage.stageId, stage]));
  const root = byId.get("analysis") ?? stages[0];
  const timelineStart = new Date(root.startedAt).getTime();
  const timelineEnd = root.endedAt ? new Date(root.endedAt).getTime() : now;
  const durationMs = Math.max(1, timelineEnd - timelineStart);

  return {
    durationMs,
    rows: stages.map((stage) => {
      const startedAt = new Date(stage.startedAt).getTime();
      const endedAt = stage.endedAt ? new Date(stage.endedAt).getTime() : now;
      let current = stage;
      let depth = 0;
      const seen = new Set([stage.stageId]);
      while (current.parentStageId && byId.has(current.parentStageId) && !seen.has(current.parentStageId)) {
        seen.add(current.parentStageId);
        current = byId.get(current.parentStageId);
        depth += 1;
      }
      const offsetPct = Math.max(0, Math.min(100, ((startedAt - timelineStart) / durationMs) * 100));
      const widthPct = Math.max(0, Math.min(100 - offsetPct, ((endedAt - startedAt) / durationMs) * 100));
      return {
        ...stage,
        depth,
        durationMs: stage.endedAt ? stage.durationMs : Math.max(stage.durationMs ?? 0, endedAt - startedAt),
        offsetPct,
        running: stage.status === "running" && !stage.endedAt,
        widthPct,
      };
    }),
  };
}

export function formatDuration(durationMs) {
  const seconds = Math.max(0, Math.round(durationMs / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${seconds % 60 ? ` ${seconds % 60}s` : ""}`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${minutes % 60 ? ` ${minutes % 60}m` : ""}`;
}
