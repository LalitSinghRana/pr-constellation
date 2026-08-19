import {
  assertStorageId,
  createStoreError,
  isPlainObject,
  normalizeError,
  normalizeObject,
  normalizeTimestamp,
  nullableString,
  requirePositiveInteger,
  requireString,
  timestampValue,
} from "./run-manifest.js";

export const TIMINGS_SCHEMA_VERSION = "pr-review-timings/v1";

const TERMINAL_STAGE_STATUSES = new Set([
  "succeeded",
  "completed",
  "failed",
  "interrupted",
  "canceled",
  "skipped",
]);
const START_EVENT_TYPES = new Set(["start", "begin", "stage-start"]);
const END_EVENT_TYPES = new Set([
  "end",
  "finish",
  "complete",
  "stage-end",
  "stage-finish",
  "fail",
  "error",
]);

export function createTimingsDocument(runId, now = new Date().toISOString()) {
  assertStorageId(runId, "runId");
  const createdAt = normalizeTimestamp(now, "createdAt");
  return {
    schemaVersion: TIMINGS_SCHEMA_VERSION,
    runId,
    createdAt,
    updatedAt: createdAt,
    totalDurationMs: 0,
    events: [],
    stages: [],
  };
}

export function applyStageEvent(timings, event, fallbackAt = new Date().toISOString()) {
  assertTimingsDocument(timings, timings?.runId);
  const normalized = normalizeStageEvent(event, fallbackAt);
  const stages = timings.stages.map((stage) => ({ ...stage }));
  const attempt = normalized.attempt;
  let stageIndex = stages.findIndex(
    (stage) => stage.stageId === normalized.stageId && stage.attempt === attempt,
  );
  const isStart = START_EVENT_TYPES.has(normalized.type);
  const isEnd =
    END_EVENT_TYPES.has(normalized.type) ||
    (normalized.status != null && TERMINAL_STAGE_STATUSES.has(normalized.status));

  if (stageIndex < 0) {
    stages.push({
      stageId: normalized.stageId,
      label: normalized.label ?? normalized.stageId,
      parentStageId: normalized.parentStageId ?? null,
      attempt,
      startedAt: normalized.at,
      endedAt: null,
      durationMs: 0,
      status: normalized.status ?? "running",
      error: normalized.error ?? null,
      metrics: normalized.metrics ?? {},
    });
    stageIndex = stages.length - 1;
  }

  const stage = stages[stageIndex];
  if (isStart && stage.endedAt) {
    throw createStoreError(
      "STAGE_ALREADY_FINISHED",
      `Stage "${normalized.stageId}" attempt ${attempt} has already finished.`,
    );
  }

  const updatedStage = {
    ...stage,
    label: normalized.label ?? stage.label,
    parentStageId: normalized.parentStageId ?? stage.parentStageId,
    status: normalized.status ?? (isEnd ? inferEndStatus(normalized.type) : stage.status),
    error: normalized.error ?? stage.error,
    metrics: normalized.metrics ? { ...stage.metrics, ...normalized.metrics } : stage.metrics,
  };

  if (isStart && !stage.startedAt) {
    updatedStage.startedAt = normalized.at;
  }
  if (isEnd) {
    updatedStage.endedAt = normalized.at;
  }
  const measuredElapsedMs = normalized.metrics?.elapsedMs;
  updatedStage.durationMs =
    isEnd &&
    typeof measuredElapsedMs === "number" &&
    Number.isFinite(measuredElapsedMs) &&
    measuredElapsedMs >= 0
      ? measuredElapsedMs
      : durationBetween(updatedStage.startedAt, updatedStage.endedAt ?? normalized.at);
  stages[stageIndex] = updatedStage;
  const liveStages = stages.map((candidate) =>
    candidate.endedAt
      ? candidate
      : {
          ...candidate,
          durationMs: durationBetween(candidate.startedAt, normalized.at),
        },
  );

  return {
    ...timings,
    updatedAt: normalized.at,
    totalDurationMs: calculateTotalDuration(liveStages, normalized.at),
    events: [...timings.events, normalized],
    stages: liveStages,
  };
}

export function interruptOpenStages(timings, interruptedAt, message) {
  let changed = false;
  const interruptionEvents = [];
  const stages = timings.stages.map((stage) => {
    if (TERMINAL_STAGE_STATUSES.has(stage.status) || stage.endedAt) {
      return stage;
    }
    changed = true;
    const error = stage.error ?? {
      code: "RUN_INTERRUPTED",
      message,
    };
    interruptionEvents.push({
      type: "stage-finish",
      stageId: stage.stageId,
      label: stage.label,
      parentStageId: stage.parentStageId,
      attempt: stage.attempt,
      at: interruptedAt,
      status: "interrupted",
      error,
      metrics: null,
    });
    return {
      ...stage,
      endedAt: interruptedAt,
      durationMs: durationBetween(stage.startedAt, interruptedAt),
      status: "interrupted",
      error,
    };
  });

  if (!changed) {
    return null;
  }
  return {
    ...timings,
    updatedAt: interruptedAt,
    events: [...timings.events, ...interruptionEvents],
    stages,
    totalDurationMs: calculateTotalDuration(stages),
  };
}

function normalizeStageEvent(event, fallbackAt) {
  if (!isPlainObject(event)) {
    throw new TypeError("Timing event must be an object.");
  }
  const type = requireString(event.type, "event.type");
  const stageId = requireString(event.stageId, "event.stageId");
  const at = normalizeTimestamp(event.at ?? fallbackAt, "event.at");
  const attempt =
    event.attempt == null ? 1 : requirePositiveInteger(event.attempt, "event.attempt");

  return {
    type,
    stageId,
    label: nullableString(event.label, "event.label"),
    parentStageId: nullableString(event.parentStageId, "event.parentStageId"),
    attempt,
    at,
    status: nullableString(event.status, "event.status"),
    error: normalizeError(event.error),
    metrics: normalizeObject(event.metrics, "event.metrics"),
  };
}

export function assertTimingsDocument(value, runId) {
  if (
    !isPlainObject(value) ||
    value.schemaVersion !== TIMINGS_SCHEMA_VERSION ||
    value.runId !== runId ||
    !Array.isArray(value.events) ||
    !Array.isArray(value.stages)
  ) {
    throw createStoreError(
      "INVALID_TIMINGS_DOCUMENT",
      "timings.json is not a valid timing document.",
    );
  }
}

function inferEndStatus(type) {
  if (type === "fail" || type === "error") {
    return "failed";
  }
  return type === "stage-finish" || type === "complete" ? "completed" : "succeeded";
}

function calculateTotalDuration(stages, fallbackEndAt) {
  if (stages.length === 0) {
    return 0;
  }
  const starts = stages.map((stage) => timestampValue(stage.startedAt));
  const ends = stages.map((stage) =>
    timestampValue(stage.endedAt ?? fallbackEndAt ?? stage.startedAt),
  );
  return Math.max(0, Math.max(...ends) - Math.min(...starts));
}

function durationBetween(start, end) {
  return Math.max(0, timestampValue(end) - timestampValue(start));
}
