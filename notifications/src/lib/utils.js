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
