export const RUN_SCHEMA_VERSION = "pr-review-run/v1";

export const RUN_STATUSES = Object.freeze([
  "queued",
  "running",
  "succeeded",
  "failed",
  "interrupted",
  "canceled",
]);

export const SOURCE_MODES = Object.freeze(["fresh", "frozen"]);

export const FROZEN_INPUT_FILES = Object.freeze({
  metadataPath: "metadata.json",
  diffPath: "diff.patch",
  diffInventoryPath: "diff-inventory.json",
  diffSummaryPath: "diff-summary.json",
});

const TERMINAL_RUN_STATUSES = new Set(["succeeded", "failed", "interrupted", "canceled"]);

export function assertStorageId(value, label = "identifier") {
  if (!isStorageId(value)) {
    throw createStoreError(
      "INVALID_STORAGE_ID",
      `${label} must contain only letters, numbers, ".", "_" or "-", may not be "." or "..", and must be at most 200 characters.`,
    );
  }
  return value;
}

export function createRunManifest(input, now = new Date().toISOString()) {
  if (!isPlainObject(input)) {
    throw new TypeError("Run input must be an object.");
  }

  const runId = assertStorageId(input.runId, "runId");
  const slug = assertStorageId(input.slug, "slug");
  const status = input.status ?? "queued";
  const sourceMode = input.sourceMode ?? "fresh";
  assertEnum(status, RUN_STATUSES, "status");
  assertEnum(sourceMode, SOURCE_MODES, "sourceMode");
  if (sourceMode === "frozen") {
    assertStorageId(input.sourceRunId, "sourceRunId");
    if (input.sourceRunId === runId) {
      throw createStoreError("INVALID_SOURCE_RUN", "A frozen run cannot use itself as its source.");
    }
  } else if (input.sourceRunId != null) {
    throw createStoreError(
      "INVALID_SOURCE_RUN",
      "sourceRunId is only valid when sourceMode is frozen.",
    );
  }

  const createdAt = normalizeTimestamp(input.timestamps?.createdAt ?? now, "createdAt");
  const manifest = {
    schemaVersion: RUN_SCHEMA_VERSION,
    runId,
    url: requireString(input.url, "url"),
    owner: requireString(input.owner, "owner"),
    repo: requireString(input.repo, "repo"),
    number: requirePositiveInteger(input.number, "number"),
    slug,
    title: typeof input.title === "string" ? input.title : "",
    headSha: nullableString(input.headSha, "headSha"),
    baseSha: nullableString(input.baseSha, "baseSha"),
    status,
    sourceMode,
    sourceRunId: sourceMode === "frozen" ? input.sourceRunId : null,
    timestamps: {
      createdAt,
      queuedAt: normalizeOptionalTimestamp(input.timestamps?.queuedAt ?? createdAt, "queuedAt"),
      startedAt: normalizeOptionalTimestamp(input.timestamps?.startedAt, "startedAt"),
      completedAt: normalizeOptionalTimestamp(input.timestamps?.completedAt, "completedAt"),
      updatedAt: normalizeTimestamp(input.timestamps?.updatedAt ?? createdAt, "updatedAt"),
    },
    phase: nullableString(input.phase, "phase"),
    error: normalizeError(input.error),
    reviewUrl: status === "succeeded" ? `/reviews/${slug}/${runId}/` : null,
    gitCommit: nullableString(input.gitCommit, "gitCommit"),
    metrics: normalizeRunMetrics(input.metrics),
  };

  if (status === "running" && !manifest.timestamps.startedAt) {
    manifest.timestamps.startedAt = createdAt;
  }
  if (TERMINAL_RUN_STATUSES.has(status) && !manifest.timestamps.completedAt) {
    manifest.timestamps.completedAt = createdAt;
  }

  return manifest;
}

export function mergeRunManifest(current, patch, now) {
  if (patch.status != null) {
    assertEnum(patch.status, RUN_STATUSES, "status");
  }
  if (patch.sourceMode != null) {
    assertEnum(patch.sourceMode, SOURCE_MODES, "sourceMode");
  }

  const status = patch.status ?? current.status;
  const sourceMode = patch.sourceMode ?? current.sourceMode;
  const sourceRunId = patch.sourceRunId === undefined ? current.sourceRunId : patch.sourceRunId;
  if (sourceMode === "frozen") {
    assertStorageId(sourceRunId, "sourceRunId");
    if (sourceRunId === current.runId) {
      throw createStoreError("INVALID_SOURCE_RUN", "A frozen run cannot use itself as its source.");
    }
  } else if (sourceRunId != null) {
    throw createStoreError(
      "INVALID_SOURCE_RUN",
      "sourceRunId is only valid when sourceMode is frozen.",
    );
  }

  const timestamps = {
    ...current.timestamps,
    ...(patch.timestamps ?? {}),
    updatedAt: now,
  };
  for (const [key, value] of Object.entries(timestamps)) {
    timestamps[key] = normalizeOptionalTimestamp(value, key);
  }
  if (status === "running" && !timestamps.startedAt) {
    timestamps.startedAt = now;
  }
  if (TERMINAL_RUN_STATUSES.has(status) && !timestamps.completedAt) {
    timestamps.completedAt = now;
  }

  return createRunManifest(
    {
      ...current,
      ...patch,
      schemaVersion: RUN_SCHEMA_VERSION,
      runId: current.runId,
      slug: current.slug,
      status,
      sourceMode,
      sourceRunId: sourceMode === "frozen" ? sourceRunId : null,
      timestamps,
      metrics:
        patch.metrics == null
          ? current.metrics
          : normalizeRunMetrics({ ...current.metrics, ...patch.metrics }),
      error: patch.error === undefined ? current.error : normalizeError(patch.error),
    },
    now,
  );
}

export function normalizeRunDocument(manifest) {
  return createRunManifest(manifest, manifest.timestamps?.updatedAt);
}

function normalizeRunMetrics(metrics) {
  const value = normalizeObject(metrics, "metrics") ?? {};
  const normalized = {
    changedFiles: normalizeOptionalNonNegativeNumber(value.changedFiles, "metrics.changedFiles"),
    additions: normalizeOptionalNonNegativeNumber(value.additions, "metrics.additions"),
    deletions: normalizeOptionalNonNegativeNumber(value.deletions, "metrics.deletions"),
    changedLines: normalizeOptionalNonNegativeNumber(value.changedLines, "metrics.changedLines"),
  };

  for (const [key, metric] of Object.entries(value)) {
    if (!(key in normalized)) {
      normalized[key] = metric;
    }
  }
  return normalized;
}

export function normalizeError(error) {
  if (error == null) {
    return null;
  }
  if (typeof error === "string") {
    return { message: error };
  }
  if (!isPlainObject(error)) {
    throw new TypeError("error must be null, a string, or an object.");
  }
  return structuredClone(error);
}

export function normalizeObject(value, label) {
  if (value == null) {
    return null;
  }
  if (!isPlainObject(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  return structuredClone(value);
}

function normalizeOptionalNonNegativeNumber(value, label) {
  if (value == null) {
    return null;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative finite number.`);
  }
  return value;
}

export function assertImmutableRunFields(current, patch) {
  for (const field of ["schemaVersion", "runId", "slug"]) {
    if (patch[field] != null && patch[field] !== current[field]) {
      throw createStoreError("IMMUTABLE_RUN_FIELD", `${field} cannot be changed.`);
    }
  }
}

export function assertRunDocument(value, expected) {
  if (
    !isPlainObject(value) ||
    value.schemaVersion !== RUN_SCHEMA_VERSION ||
    value.slug !== expected.slug ||
    value.runId !== expected.runId
  ) {
    throw createStoreError("INVALID_RUN_DOCUMENT", "run.json is not a valid run manifest.");
  }
}

export function compareRunsNewestFirst(left, right) {
  const timeDifference =
    timestampValue(right.timestamps?.createdAt) - timestampValue(left.timestamps?.createdAt);
  return timeDifference || right.runId.localeCompare(left.runId);
}

export function timestampValue(value) {
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

export function normalizeTimestamp(value, label) {
  if (typeof value !== "string" && !(value instanceof Date)) {
    throw new TypeError(`${label} must be a valid timestamp.`);
  }
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.valueOf())) {
    throw new TypeError(`${label} must be a valid timestamp.`);
  }
  return date.toISOString();
}

export function normalizeOptionalTimestamp(value, label) {
  return value == null ? null : normalizeTimestamp(value, label);
}

export function requireString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${label} must be a non-empty string.`);
  }
  return value;
}

export function nullableString(value, label) {
  if (value == null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new TypeError(`${label} must be a string or null.`);
  }
  return value;
}

export function requirePositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${label} must be a positive integer.`);
  }
  return value;
}

function assertEnum(value, allowed, label) {
  if (!allowed.includes(value)) {
    throw new TypeError(`${label} must be one of: ${allowed.join(", ")}.`);
  }
}

export function isStorageId(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 200 &&
    value !== "." &&
    value !== ".." &&
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)
  );
}

export function isPlainObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

export function createStoreError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
