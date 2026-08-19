import { chmodSync, constants, lstatSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { access, lstat, mkdir, realpath, rm } from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";
import {
  assertImmutableRunFields,
  assertRunDocument,
  assertStorageId,
  compareRunsNewestFirst,
  createRunManifest,
  createStoreError,
  FROZEN_INPUT_FILES,
  isPlainObject,
  isStorageId,
  mergeRunManifest,
  normalizeRunDocument,
  RUN_SCHEMA_VERSION,
  RUN_STATUSES,
  SOURCE_MODES,
  timestampValue,
} from "./run-manifest.js";
import {
  applyStageEvent,
  assertTimingsDocument,
  createTimingsDocument,
  interruptOpenStages,
  TIMINGS_SCHEMA_VERSION,
} from "./run-timings.js";

export {
  applyStageEvent,
  assertStorageId,
  createRunManifest,
  createTimingsDocument,
  FROZEN_INPUT_FILES,
  interruptOpenStages,
  mergeRunManifest,
  normalizeRunDocument,
  RUN_SCHEMA_VERSION,
  RUN_STATUSES,
  SOURCE_MODES,
  TIMINGS_SCHEMA_VERSION,
};

export const DASHBOARD_SCHEMA_VERSION = "pr-review-dashboard/v1";

const LEGACY_IMPORT_KEY = "legacy-json-imported";
const MAX_WRITE_ATTEMPTS = 5;
const STORE_FILENAME = ".run-store.sqlite";

/**
 * Durable storage for local PR analysis runs.
 *
 * Mutable run metadata lives in SQLite. Large immutable run inputs and rendered
 * output stay in their existing directories under reviewsDir.
 */
export class RunStore {
  #clock;
  #database;
  #mutations = new Map();
  #reviewsDir;
  #statements;

  constructor({ reviewsDir, clock = () => new Date() }) {
    if (typeof reviewsDir !== "string" || reviewsDir.trim() === "") {
      throw new TypeError("reviewsDir must be a non-empty path.");
    }
    if (typeof clock !== "function") {
      throw new TypeError("clock must be a function.");
    }

    this.#reviewsDir = path.resolve(reviewsDir);
    this.#clock = clock;
    mkdirSync(this.#reviewsDir, { recursive: true, mode: 0o700 });
    if (!lstatSync(this.#reviewsDir).isDirectory()) {
      throw new TypeError("reviewsDir must be a directory, not a symbolic link.");
    }
    chmodSync(this.#reviewsDir, 0o700);

    this.#database = new Database(path.join(this.#reviewsDir, STORE_FILENAME));
    try {
      chmodSync(this.#database.name, 0o600);
      this.#database.pragma("busy_timeout = 5000");
      this.#database.pragma("journal_mode = WAL");
      this.#database.pragma("foreign_keys = ON");
      this.#database.pragma("synchronous = NORMAL");
      for (const suffix of ["-shm", "-wal"]) {
        try {
          chmodSync(`${this.#database.name}${suffix}`, 0o600);
        } catch (error) {
          if (error?.code !== "ENOENT") throw error;
        }
      }
      this.#database.exec(`
        CREATE TABLE IF NOT EXISTS runs (
          slug TEXT NOT NULL,
          run_id TEXT NOT NULL,
          document TEXT NOT NULL CHECK (json_valid(document)),
          PRIMARY KEY (slug, run_id)
        ) STRICT;

        CREATE TABLE IF NOT EXISTS timings (
          slug TEXT NOT NULL,
          run_id TEXT NOT NULL,
          document TEXT NOT NULL CHECK (json_valid(document)),
          PRIMARY KEY (slug, run_id),
          FOREIGN KEY (slug, run_id) REFERENCES runs (slug, run_id) ON DELETE CASCADE
        ) STRICT;

        CREATE TABLE IF NOT EXISTS store_metadata (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        ) STRICT;
      `);
      this.#statements = {
        deleteRun: this.#database.prepare("DELETE FROM runs WHERE slug = ? AND run_id = ?"),
        insertRun: this.#database.prepare(
          "INSERT INTO runs (slug, run_id, document) VALUES (?, ?, ?)",
        ),
        insertRunIfMissing: this.#database.prepare(
          "INSERT OR IGNORE INTO runs (slug, run_id, document) VALUES (?, ?, ?)",
        ),
        insertTimings: this.#database.prepare(
          "INSERT INTO timings (slug, run_id, document) VALUES (?, ?, ?)",
        ),
        insertTimingsIfMissing: this.#database.prepare(
          "INSERT OR IGNORE INTO timings (slug, run_id, document) VALUES (?, ?, ?)",
        ),
        readMetadata: this.#database.prepare("SELECT value FROM store_metadata WHERE key = ?"),
        readRun: this.#database.prepare("SELECT document FROM runs WHERE slug = ? AND run_id = ?"),
        readTimings: this.#database.prepare(
          "SELECT document FROM timings WHERE slug = ? AND run_id = ?",
        ),
        scanRuns: this.#database.prepare("SELECT slug, run_id, document FROM runs"),
        updateRun: this.#database.prepare(
          "UPDATE runs SET document = ? WHERE slug = ? AND run_id = ? AND document = ?",
        ),
        updateTimings: this.#database.prepare(
          "UPDATE timings SET document = ? WHERE slug = ? AND run_id = ? AND document = ?",
        ),
        writeMetadata: this.#database.prepare(
          "INSERT OR REPLACE INTO store_metadata (key, value) VALUES (?, ?)",
        ),
      };
      this.#importLegacyDocuments();
    } catch (error) {
      this.#database.close();
      throw error;
    }
  }

  get reviewsDir() {
    return this.#reviewsDir;
  }

  getRunDir(slug, runId) {
    assertStorageId(slug, "slug");
    assertStorageId(runId, "runId");
    return path.join(this.#reviewsDir, slug, runId);
  }

  /**
   * Newest succeeded run for a slug that has a readable analysis.json on disk.
   * Scan order is newest-first (createdAt, then runId).
   */
  async getLatestSucceededReviewRun(slug) {
    assertStorageId(slug, "slug");
    const manifests = (await this.scanRuns()).filter(
      (manifest) => manifest.slug === slug && manifest.status === "succeeded",
    );

    for (const manifest of manifests) {
      const runDir = this.getRunDir(slug, manifest.runId);
      try {
        await Promise.all([
          access(path.join(runDir, "analysis.json"), constants.R_OK),
          access(path.join(runDir, "diff-inventory.json"), constants.R_OK),
          access(path.join(runDir, "diff.patch"), constants.R_OK),
          access(path.join(runDir, "metadata.json"), constants.R_OK),
        ]);
        return structuredClone(manifest);
      } catch (error) {
        if (error?.code !== "ENOENT") {
          throw error;
        }
      }
    }

    return null;
  }

  close() {
    if (this.#database.open) {
      this.#database.pragma("wal_checkpoint(TRUNCATE)");
      this.#database.close();
    }
  }

  async createRun(input) {
    const now = this.#now();
    const manifest = createRunManifest(input, now);
    const runDir = this.getRunDir(manifest.slug, manifest.runId);

    return this.#serialize(runDir, async () => {
      await mkdir(runDir, { recursive: true });
      const timings = createTimingsDocument(manifest.runId, now);
      const insertDocuments = this.#database.transaction(() => {
        this.#statements.insertRun.run(manifest.slug, manifest.runId, JSON.stringify(manifest));
        this.#statements.insertTimings.run(manifest.slug, manifest.runId, JSON.stringify(timings));
      });

      try {
        insertDocuments.immediate();
      } catch (error) {
        if (["SQLITE_CONSTRAINT_PRIMARYKEY", "SQLITE_CONSTRAINT_UNIQUE"].includes(error?.code)) {
          throw createStoreError(
            "RUN_ALREADY_EXISTS",
            `Run "${manifest.slug}/${manifest.runId}" already exists.`,
          );
        }
        throw error;
      }

      return structuredClone(manifest);
    });
  }

  async readRun(slug, runId) {
    this.getRunDir(slug, runId);
    return this.#readRunRecord(slug, runId).value;
  }

  async readTimings(slug, runId) {
    this.getRunDir(slug, runId);
    return this.#readTimingsRecord(slug, runId).value;
  }

  async updateRun(slug, runId, patchOrUpdater) {
    const runDir = this.getRunDir(slug, runId);

    return this.#serialize(runDir, async () => {
      const stored = this.#readRunRecord(slug, runId);
      const current = stored.value;

      const requestedPatch =
        typeof patchOrUpdater === "function"
          ? await patchOrUpdater(structuredClone(current))
          : patchOrUpdater;
      if (!isPlainObject(requestedPatch)) {
        throw new TypeError("Run update must be an object or return an object.");
      }

      assertImmutableRunFields(current, requestedPatch);
      const updated = mergeRunManifest(current, requestedPatch, this.#now());
      const result = this.#statements.updateRun.run(
        JSON.stringify(updated),
        slug,
        runId,
        stored.document,
      );
      if (result.changes !== 1) {
        if (!this.#statements.readRun.get(slug, runId)) {
          throw createMissingDocumentError("Run", slug, runId);
        }
        throw createUpdateConflictError("Run", slug, runId);
      }
      return structuredClone(updated);
    });
  }

  async deleteRun(slug, runId) {
    const runDir = this.getRunDir(slug, runId);

    return this.#serialize(runDir, async () => {
      const manifest = await this.readRun(slug, runId);
      const reviewsRealPath = await ensureRealDirectory(this.#reviewsDir);
      let stats;
      try {
        stats = await lstat(runDir);
      } catch (error) {
        if (error?.code !== "ENOENT") {
          throw error;
        }
      }

      if (stats) {
        if (!stats.isDirectory()) {
          throw createStoreError(
            "INVALID_RUN_DOCUMENT",
            `Run "${slug}/${runId}" is not stored in a regular directory.`,
          );
        }
        const runRealPath = await realpath(runDir);
        assertPathContained(reviewsRealPath, runRealPath, "run");
        await rm(runDir, { recursive: true });
      }

      this.#statements.deleteRun.run(slug, runId);
      return manifest;
    });
  }

  async recordStageEvent(slug, runId, event) {
    const runDir = this.getRunDir(slug, runId);

    return this.#serialize(runDir, async () => {
      const eventTime = this.#now();
      for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt += 1) {
        const stored = this.#readTimingsRecord(slug, runId);
        const updated = applyStageEvent(stored.value, event, eventTime);
        const result = this.#statements.updateTimings.run(
          JSON.stringify(updated),
          slug,
          runId,
          stored.document,
        );
        if (result.changes === 1) {
          return structuredClone(updated);
        }
        if (!this.#statements.readTimings.get(slug, runId)) {
          throw createMissingDocumentError("Timings", slug, runId);
        }
      }
      throw createUpdateConflictError("Timings", slug, runId);
    });
  }

  /**
   * Converts work left running by an earlier local server process to interrupted.
   * Queued runs remain durable so the next server can restore them.
   */
  async recoverInterruptedRuns({
    message = "The local analysis process stopped before this run completed.",
  } = {}) {
    const manifests = await this.scanRuns();
    const recovered = [];

    for (const manifest of manifests) {
      if (manifest.status !== "running") {
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
    for (const row of this.#statements.scanRuns.all()) {
      try {
        const manifest = JSON.parse(row.document);
        assertRunDocument(manifest, { slug: row.slug, runId: row.run_id });
        manifests.push(normalizeRunDocument(manifest));
      } catch (error) {
        if (!isInvalidPersistedDocumentError(error)) {
          throw error;
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
    const sourceRunId = manifest.sourceMode === "frozen" ? manifest.sourceRunId : manifest.runId;
    return this.resolveFrozenSource({ slug, sourceRunId });
  }

  async #interruptOpenStages(slug, runId, interruptedAt, message) {
    const runDir = this.getRunDir(slug, runId);

    await this.#serialize(runDir, async () => {
      for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt += 1) {
        let stored;
        try {
          stored = this.#readTimingsRecord(slug, runId);
        } catch (error) {
          if (error?.code === "ENOENT") {
            return;
          }
          throw error;
        }
        const updated = interruptOpenStages(stored.value, interruptedAt, message);
        if (!updated) {
          return stored.value;
        }
        const result = this.#statements.updateTimings.run(
          JSON.stringify(updated),
          slug,
          runId,
          stored.document,
        );
        if (result.changes === 1) {
          return updated;
        }
        if (!this.#statements.readTimings.get(slug, runId)) {
          return;
        }
      }
      throw createUpdateConflictError("Timings", slug, runId);
    });
  }

  #readRunRecord(slug, runId) {
    const row = this.#statements.readRun.get(slug, runId);
    if (!row) {
      throw createMissingDocumentError("Run", slug, runId);
    }
    const manifest = JSON.parse(row.document);
    assertRunDocument(manifest, { slug, runId });
    return { document: row.document, value: normalizeRunDocument(manifest) };
  }

  #readTimingsRecord(slug, runId) {
    const row = this.#statements.readTimings.get(slug, runId);
    if (!row) {
      throw createMissingDocumentError("Timings", slug, runId);
    }
    const timings = JSON.parse(row.document);
    assertTimingsDocument(timings, runId);
    return { document: row.document, value: timings };
  }

  #importLegacyDocuments() {
    if (this.#statements.readMetadata.get(LEGACY_IMPORT_KEY)) {
      return;
    }

    const documents = readLegacyDocuments(this.#reviewsDir);
    const importDocuments = this.#database.transaction(() => {
      for (const { manifest, timings } of documents) {
        this.#statements.insertRunIfMissing.run(
          manifest.slug,
          manifest.runId,
          JSON.stringify(manifest),
        );
        if (timings) {
          this.#statements.insertTimingsIfMissing.run(
            manifest.slug,
            manifest.runId,
            JSON.stringify(timings),
          );
        }
      }
      this.#statements.writeMetadata.run(LEGACY_IMPORT_KEY, "1");
    });
    importDocuments.immediate();
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

async function ensureRealDirectory(directory) {
  await mkdir(directory, { recursive: true });
  return realpath(directory);
}

function assertPathContained(root, candidate, label) {
  const relative = path.relative(root, candidate);
  if (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  ) {
    return;
  }
  throw createStoreError("SOURCE_PATH_ESCAPE", `Resolved ${label} escapes the reviews directory.`);
}

function readDirectorySyncOrEmpty(directory) {
  try {
    return readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

function readLegacyJson(filePath) {
  try {
    if (!lstatSync(filePath).isFile()) {
      return null;
    }
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) {
      return null;
    }
    throw error;
  }
}

function readLegacyDocuments(reviewsDir) {
  const documents = [];
  for (const slugEntry of readDirectorySyncOrEmpty(reviewsDir)) {
    if (!slugEntry.isDirectory() || !isStorageId(slugEntry.name)) {
      continue;
    }

    const slugDir = path.join(reviewsDir, slugEntry.name);
    for (const runEntry of readDirectorySyncOrEmpty(slugDir)) {
      if (!runEntry.isDirectory() || !isStorageId(runEntry.name)) {
        continue;
      }

      const runDir = path.join(slugDir, runEntry.name);
      const legacyManifest = readLegacyJson(path.join(runDir, "run.json"));
      if (!legacyManifest) {
        continue;
      }

      let manifest;
      try {
        assertRunDocument(legacyManifest, {
          slug: slugEntry.name,
          runId: runEntry.name,
        });
        manifest = normalizeRunDocument(legacyManifest);
      } catch (error) {
        if (isInvalidPersistedDocumentError(error)) {
          continue;
        }
        throw error;
      }

      const legacyTimings = readLegacyJson(path.join(runDir, "timings.json"));
      let timings = null;
      if (legacyTimings) {
        try {
          assertTimingsDocument(legacyTimings, manifest.runId);
          timings = legacyTimings;
        } catch (error) {
          if (!isInvalidPersistedDocumentError(error)) {
            throw error;
          }
        }
      }
      documents.push({ manifest, timings });
    }
  }
  return documents;
}

function isInvalidPersistedDocumentError(error) {
  return (
    error instanceof SyntaxError ||
    error instanceof TypeError ||
    [
      "INVALID_RUN_DOCUMENT",
      "INVALID_SOURCE_RUN",
      "INVALID_STORAGE_ID",
      "INVALID_TIMINGS_DOCUMENT",
    ].includes(error?.code)
  );
}

function createMissingDocumentError(documentName, slug, runId) {
  return createStoreError("ENOENT", `${documentName} for run "${slug}/${runId}" does not exist.`);
}

function createUpdateConflictError(documentName, slug, runId) {
  return createStoreError(
    "RUN_UPDATE_CONFLICT",
    `${documentName} for run "${slug}/${runId}" changed during the update.`,
  );
}
