import { randomUUID } from "node:crypto";

export const ACTIVE_STATUSES = new Set(["queued", "running"]);

export const STAGE_FINISH_EVENT_TYPES = new Set([
  "end",
  "finish",
  "complete",
  "stage-end",
  "stage-finish",
  "fail",
  "error",
]);

export function createRunId(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.valueOf())) {
    throw new TypeError("now returned an invalid date.");
  }
  return `${date.toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
}

export function createBatchId(value) {
  return `batch-${createRunId(value)}`;
}

export function resolveHeadSha(metadata) {
  return metadata?.headRefOid || metadata?.commits?.at(-1)?.oid || null;
}

export function resolveBaseSha(metadata) {
  return metadata?.baseRefOid || null;
}

export function isUnavailableFrozenSourceError(error) {
  return new Set([
    "ENOENT",
    "INVALID_RUN_DOCUMENT",
    "INVALID_SOURCE_INPUT",
    "SOURCE_INPUT_MISSING",
  ]).has(error?.code);
}

export function createAbortError(message) {
  const error = new Error(message);
  error.name = "AbortError";
  error.code = "ABORT_ERR";
  return error;
}

export function throwIfAborted(signal) {
  if (!signal.aborted) {
    return;
  }
  throw signal.reason instanceof Error ? signal.reason : createAbortError("Analysis was canceled.");
}

export function isAbortError(error) {
  return error?.name === "AbortError" || error?.code === "ABORT_ERR";
}

export function isStageFinishEvent(event) {
  return STAGE_FINISH_EVENT_TYPES.has(event?.type);
}

export function cancellationEventError(error) {
  if (error && typeof error === "object" && !Array.isArray(error)) {
    return {
      code: typeof error.code === "string" && error.code ? error.code : "RUN_CANCELED",
      message:
        typeof error.message === "string" && error.message
          ? error.message
          : "Analysis was canceled.",
    };
  }
  if (typeof error === "string" && error) {
    return {
      code: "RUN_CANCELED",
      message: error,
    };
  }
  return {
    code: "RUN_CANCELED",
    message: "Analysis was canceled.",
  };
}

export function createCancellationTargetNotFound(message) {
  const error = new Error(message);
  error.code = "CANCEL_TARGET_NOT_FOUND";
  return error;
}

export function createHistoryTargetNotFound(message) {
  const error = new Error(message);
  error.code = "HISTORY_TARGET_NOT_FOUND";
  return error;
}

export function createHistoryTargetActive(message) {
  const error = new Error(message);
  error.code = "HISTORY_TARGET_ACTIVE";
  return error;
}
