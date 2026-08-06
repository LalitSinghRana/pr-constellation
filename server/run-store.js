import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export const RUN_SCHEMA_VERSION = "pr-review-run/v1";
export const TIMINGS_SCHEMA_VERSION = "pr-review-timings/v1";
export const DASHBOARD_SCHEMA_VERSION = "pr-review-dashboard/v1";

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

const ACTIVE_RUN_STATUSES = new Set(["queued", "running"]);
const TERMINAL_RUN_STATUSES = new Set(["succeeded", "failed", "interrupted", "canceled"]);
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

/**
 * Durable, single-process storage for local PR analysis runs.
 *
 * All public methods which accept a slug or run ID validate it before resolving
 * a path. Writes to JSON documents happen through a same-directory temporary
 * file followed by rename, so readers observe either the previous complete
 * document or the next complete document.
 */
export class RunStore {
  #clock;
  #mutations = new Map();
  #reviewsDir;

  constructor({ reviewsDir, clock = () => new Date() }) {
    if (typeof reviewsDir !== "string" || reviewsDir.trim() === "") {
      throw new TypeError("reviewsDir must be a non-empty path.");
    }
    if (typeof clock !== "function") {
      throw new TypeError("clock must be a function.");
    }

    this.#reviewsDir = path.resolve(reviewsDir);
    this.#clock = clock;
  }

  get reviewsDir() {
    return this.#reviewsDir;
  }

  getRunDir(slug, runId) {
    assertStorageId(slug, "slug");
    assertStorageId(runId, "runId");
    return path.join(this.#reviewsDir, slug, runId);
  }

  async createRun(input) {
    const now = this.#now();
    const manifest = createRunManifest(input, now);
    const runDir = this.getRunDir(manifest.slug, manifest.runId);
    const manifestPath = path.join(runDir, "run.json");
    const timingsPath = path.join(runDir, "timings.json");

    return this.#serialize(manifestPath, async () => {
      await mkdir(runDir, { recursive: true });
      if (await fileExists(manifestPath)) {
        throw createStoreError(
          "RUN_ALREADY_EXISTS",
          `Run "${manifest.slug}/${manifest.runId}" already exists.`,
        );
      }

      await atomicWriteJson(manifestPath, manifest);
      await atomicWriteJson(timingsPath, createTimingsDocument(manifest.runId, now));
      return structuredClone(manifest);
    });
  }

  async readRun(slug, runId) {
    const runPath = path.join(this.getRunDir(slug, runId), "run.json");
    const manifest = await readJson(runPath);
    assertRunDocument(manifest, { slug, runId });
    return normalizeRunDocument(manifest);
  }

  async readTimings(slug, runId) {
    const timingsPath = path.join(this.getRunDir(slug, runId), "timings.json");
    return readJson(timingsPath);
  }

  async updateRun(slug, runId, patchOrUpdater) {
    const manifestPath = path.join(this.getRunDir(slug, runId), "run.json");

    return this.#serialize(manifestPath, async () => {
      const stored = await readJson(manifestPath);
      assertRunDocument(stored, { slug, runId });
      const current = normalizeRunDocument(stored);

      const requestedPatch =
        typeof patchOrUpdater === "function"
          ? await patchOrUpdater(structuredClone(current))
          : patchOrUpdater;
      if (!isPlainObject(requestedPatch)) {
        throw new TypeError("Run update must be an object or return an object.");
      }

      assertImmutableRunFields(current, requestedPatch);
      const updated = mergeRunManifest(current, requestedPatch, this.#now());
      await atomicWriteJson(manifestPath, updated);
      return structuredClone(updated);
    });
  }

  async deleteRun(slug, runId) {
    const runDir = this.getRunDir(slug, runId);

    return this.#serialize(runDir, async () => {
      const reviewsRealPath = await ensureRealDirectory(this.#reviewsDir);
      const runRealPath = await realpath(runDir);
      assertPathContained(reviewsRealPath, runRealPath, "run");
      const stats = await lstat(runDir);
      if (!stats.isDirectory()) {
        throw createStoreError(
          "INVALID_RUN_DOCUMENT",
          `Run "${slug}/${runId}" is not stored in a regular directory.`,
        );
      }

      const manifest = await readJson(path.join(runRealPath, "run.json"));
      assertRunDocument(manifest, { slug, runId });
      await rm(runDir, { recursive: true });
      return normalizeRunDocument(manifest);
    });
  }

  async recordStageEvent(slug, runId, event) {
    const timingsPath = path.join(this.getRunDir(slug, runId), "timings.json");

    return this.#serialize(timingsPath, async () => {
      const timings = await readJson(timingsPath);
      assertTimingsDocument(timings, runId);
      const updated = applyStageEvent(timings, event, this.#now());
      await atomicWriteJson(timingsPath, updated);
      return structuredClone(updated);
    });
  }

  /**
   * Converts work left active by an earlier local server process to interrupted.
   * Completed runs are never changed.
   */
  async recoverInterruptedRuns({
    message = "The local analysis process stopped before this run completed.",
  } = {}) {
    const manifests = await this.scanRuns();
    const recovered = [];

    for (const manifest of manifests) {
      if (!ACTIVE_RUN_STATUSES.has(manifest.status)) {
        continue;
      }

      const interruptedAt = this.#now();
      const updated = await this.updateRun(manifest.slug, manifest.runId, {
        error: {
          code: "RUN_INTERRUPTED",
          message,
        },
        status: "interrupted",
        timestamps: {
          completedAt: interruptedAt,
        },
      });
      await this.#interruptOpenStages(updated.slug, updated.runId, interruptedAt, message);
      recovered.push(updated);
    }

    return recovered;
  }

  async markStaleRunsInterrupted(options) {
    return this.recoverInterruptedRuns(options);
  }

  async scanRuns() {
    const manifests = [];
    const slugEntries = await readDirectoryOrEmpty(this.#reviewsDir);

    for (const slugEntry of slugEntries) {
      if (!slugEntry.isDirectory() || !isStorageId(slugEntry.name)) {
        continue;
      }

      const slugDir = path.join(this.#reviewsDir, slugEntry.name);
      const runEntries = await readDirectoryOrEmpty(slugDir);
      for (const runEntry of runEntries) {
        if (!runEntry.isDirectory() || !isStorageId(runEntry.name)) {
          continue;
        }

        const manifestPath = path.join(slugDir, runEntry.name, "run.json");
        try {
          const manifest = await readJson(manifestPath);
          assertRunDocument(manifest, {
            slug: slugEntry.name,
            runId: runEntry.name,
          });
          manifests.push(normalizeRunDocument(manifest));
        } catch (error) {
          if (
            error?.code !== "ENOENT" &&
            error?.code !== "INVALID_RUN_DOCUMENT" &&
            !(error instanceof SyntaxError)
          ) {
            throw error;
          }
        }
      }
    }

    return manifests.sort(compareRunsNewestFirst);
  }

  async scanDashboard() {
    const generatedAt = this.#now();
    const manifests = await this.scanRuns();
    const groups = new Map();

    for (const manifest of manifests) {
      let group = groups.get(manifest.slug);
      if (!group) {
        group = {
          slug: manifest.slug,
          url: manifest.url,
          owner: manifest.owner,
          repo: manifest.repo,
          number: manifest.number,
          title: manifest.title,
          headSha: manifest.headSha,
          baseSha: manifest.baseSha,
          latestRunId: manifest.runId,
          latestStatus: manifest.status,
          updatedAt: manifest.timestamps.updatedAt,
          runs: [],
        };
        groups.set(manifest.slug, group);
      } else {
        if (!group.title && manifest.title) {
          group.title = manifest.title;
        }
        if (!group.headSha && manifest.headSha) {
          group.headSha = manifest.headSha;
        }
        if (!group.baseSha && manifest.baseSha) {
          group.baseSha = manifest.baseSha;
        }
      }
      let timings = null;
      try {
        timings = await this.readTimings(manifest.slug, manifest.runId);
        assertTimingsDocument(timings, manifest.runId);
      } catch (error) {
        if (
          error?.code !== "ENOENT" &&
          error?.code !== "INVALID_TIMINGS_DOCUMENT" &&
          !(error instanceof SyntaxError)
        ) {
          throw error;
        }
      }
      group.runs.push({
        ...manifest,
        timings,
      });
    }

    return {
      schemaVersion: DASHBOARD_SCHEMA_VERSION,
      generatedAt,
      pullRequests: [...groups.values()].sort(
        (left, right) => timestampValue(right.updatedAt) - timestampValue(left.updatedAt),
      ),
    };
  }

  /**
   * Resolves the immutable input files belonging to sourceRunId. Every resolved
   * path is checked after following symlinks and must remain inside reviewsDir.
   */
  async resolveFrozenSource({ slug, sourceRunId }) {
    const sourceDir = this.getRunDir(slug, sourceRunId);
    const manifest = await this.readRun(slug, sourceRunId);
    const reviewsRealPath = await ensureRealDirectory(this.#reviewsDir);
    const sourceRealPath = await realpath(sourceDir);
    assertPathContained(reviewsRealPath, sourceRealPath, "source run");

    const resolved = {
      run: manifest,
      runDir: sourceRealPath,
    };

    for (const [property, filename] of Object.entries(FROZEN_INPUT_FILES)) {
      const candidate = path.join(sourceRealPath, filename);
      let resolvedPath;
      try {
        resolvedPath = await realpath(candidate);
      } catch (error) {
        if (error?.code === "ENOENT") {
          throw createStoreError(
            "SOURCE_INPUT_MISSING",
            `Frozen source "${slug}/${sourceRunId}" is missing ${filename}.`,
          );
        }
        throw error;
      }
      assertPathContained(sourceRealPath, resolvedPath, filename);
      const stats = await lstat(resolvedPath);
      if (!stats.isFile()) {
        throw createStoreError(
          "INVALID_SOURCE_INPUT",
          `Frozen source input ${filename} is not a regular file.`,
        );
      }
      resolved[property] = resolvedPath;
    }

    return resolved;
  }

  /**
   * Resolves inputs for a target run. A fresh run owns its inputs; a frozen run
   * points at the explicitly recorded sourceRunId under the same PR slug.
   */
  async resolveSourceInputs({ slug, runId }) {
    const manifest = await this.readRun(slug, runId);
    const sourceRunId =
      manifest.sourceMode === "frozen" ? manifest.sourceRunId : manifest.runId;
    return this.resolveFrozenSource({ slug, sourceRunId });
  }

  async #interruptOpenStages(slug, runId, interruptedAt, message) {
    const timingsPath = path.join(this.getRunDir(slug, runId), "timings.json");
    if (!(await fileExists(timingsPath))) {
      return;
    }

    await this.#serialize(timingsPath, async () => {
      const timings = await readJson(timingsPath);
      assertTimingsDocument(timings, runId);
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
        return timings;
      }

      const updated = {
        ...timings,
        updatedAt: interruptedAt,
        events: [...timings.events, ...interruptionEvents],
        stages,
        totalDurationMs: calculateTotalDuration(stages),
      };
      await atomicWriteJson(timingsPath, updated);
      return updated;
    });
  }

  #now() {
    const value = this.#clock();
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.valueOf())) {
      throw new TypeError("clock returned an invalid date.");
    }
    return date.toISOString();
  }

  #serialize(key, operation) {
    const previous = this.#mutations.get(key) ?? Promise.resolve();
    const next = previous.then(operation, operation);
    let tracked;
    const release = () => {
      if (this.#mutations.get(key) === tracked) {
        this.#mutations.delete(key);
      }
    };
    tracked = next.then(
      (value) => {
        release();
        return value;
      },
      () => {
        release();
      },
    );
    this.#mutations.set(key, tracked);
    return next;
  }
}

export async function atomicWriteJson(filePath, value) {
  const directory = path.dirname(filePath);
  const temporaryPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  await mkdir(directory, { recursive: true });

  let handle;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporaryPath, filePath);
  } catch (error) {
    await handle?.close().catch(() => {});
    await rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

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
      throw createStoreError(
        "INVALID_SOURCE_RUN",
        "A frozen run cannot use itself as its source.",
      );
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
    reviewUrl: status === "succeeded" ? reviewUrlFor(slug, runId) : null,
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
  const attempt = normalized.attempt ?? 1;
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
      status: isStart ? normalized.status ?? "running" : normalized.status ?? "running",
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

function mergeRunManifest(current, patch, now) {
  if (patch.status != null) {
    assertEnum(patch.status, RUN_STATUSES, "status");
  }
  if (patch.sourceMode != null) {
    assertEnum(patch.sourceMode, SOURCE_MODES, "sourceMode");
  }

  const status = patch.status ?? current.status;
  const sourceMode = patch.sourceMode ?? current.sourceMode;
  const sourceRunId =
    patch.sourceRunId === undefined ? current.sourceRunId : patch.sourceRunId;
  if (sourceMode === "frozen") {
    assertStorageId(sourceRunId, "sourceRunId");
    if (sourceRunId === current.runId) {
      throw createStoreError(
        "INVALID_SOURCE_RUN",
        "A frozen run cannot use itself as its source.",
      );
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

  return createRunManifest({
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
  }, now);
}

function normalizeRunDocument(manifest) {
  return createRunManifest(manifest, manifest.timestamps?.updatedAt);
}

function reviewUrlFor(slug, runId) {
  return `/reviews/${slug}/${runId}/`;
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

function normalizeError(error) {
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

function normalizeObject(value, label) {
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

function assertImmutableRunFields(current, patch) {
  for (const field of ["schemaVersion", "runId", "slug"]) {
    if (patch[field] != null && patch[field] !== current[field]) {
      throw createStoreError("IMMUTABLE_RUN_FIELD", `${field} cannot be changed.`);
    }
  }
}

function assertRunDocument(value, expected) {
  if (
    !isPlainObject(value) ||
    value.schemaVersion !== RUN_SCHEMA_VERSION ||
    value.slug !== expected.slug ||
    value.runId !== expected.runId
  ) {
    throw createStoreError("INVALID_RUN_DOCUMENT", "run.json is not a valid run manifest.");
  }
}

function assertTimingsDocument(value, runId) {
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

function compareRunsNewestFirst(left, right) {
  const timeDifference =
    timestampValue(right.timestamps?.createdAt) - timestampValue(left.timestamps?.createdAt);
  return timeDifference || right.runId.localeCompare(left.runId);
}

function timestampValue(value) {
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

function normalizeTimestamp(value, label) {
  if (typeof value !== "string" && !(value instanceof Date)) {
    throw new TypeError(`${label} must be a valid timestamp.`);
  }
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.valueOf())) {
    throw new TypeError(`${label} must be a valid timestamp.`);
  }
  return date.toISOString();
}

function normalizeOptionalTimestamp(value, label) {
  return value == null ? null : normalizeTimestamp(value, label);
}

function requireString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${label} must be a non-empty string.`);
  }
  return value;
}

function nullableString(value, label) {
  if (value == null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new TypeError(`${label} must be a string or null.`);
  }
  return value;
}

function requirePositiveInteger(value, label) {
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

function isStorageId(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 200 &&
    value !== "." &&
    value !== ".." &&
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)
  );
}

function isPlainObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

async function ensureRealDirectory(directory) {
  await mkdir(directory, { recursive: true });
  return realpath(directory);
}

function assertPathContained(root, candidate, label) {
  const relative = path.relative(root, candidate);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    return;
  }
  throw createStoreError(
    "SOURCE_PATH_ESCAPE",
    `Resolved ${label} escapes the reviews directory.`,
  );
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function readDirectoryOrEmpty(directory) {
  try {
    return await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function fileExists(filePath) {
  try {
    await lstat(filePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function createStoreError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
