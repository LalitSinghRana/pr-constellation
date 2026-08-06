import { chmod, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";
import { lifecycleForQueueItem } from "../../shared/queue-policy.js";

const defaultQueueState = Object.freeze({
  version: 2,
  sync: { lastSyncedAt: "", username: "", repositories: [] },
  items: {},
});

export async function createInboxStore({
  databasePath,
  legacyQueuePath,
  legacySettingsPath,
  normalizeQueueState = (value) => value,
  normalizeSettings = (value) => value,
}) {
  const directory = path.dirname(databasePath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);

  const store = new InboxStore({ databasePath });
  await Promise.all(
    [databasePath, `${databasePath}-shm`, `${databasePath}-wal`].map((filePath) =>
      chmod(filePath, 0o600).catch((error) => {
        if (error?.code !== "ENOENT") throw error;
      }),
    ),
  );
  await store.importLegacyFiles({
    legacyQueuePath,
    legacySettingsPath,
    normalizeQueueState,
    normalizeSettings,
  });
  return store;
}

export class InboxStore {
  #database;
  #mutation = Promise.resolve();

  constructor({ databasePath }) {
    if (typeof databasePath !== "string" || databasePath.trim() === "") {
      throw new TypeError("databasePath must be a non-empty path.");
    }

    this.databasePath = path.resolve(databasePath);
    this.#database = new Database(this.databasePath);
    this.#database.pragma("journal_mode = WAL");
    this.#database.pragma("foreign_keys = ON");
    this.#database.pragma("busy_timeout = 5000");
    this.#database.pragma("synchronous = NORMAL");
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS app_metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS settings (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        document TEXT NOT NULL CHECK (json_valid(document))
      ) STRICT;

      CREATE TABLE IF NOT EXISTS sync_state (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        document TEXT NOT NULL CHECK (json_valid(document))
      ) STRICT;

      CREATE TABLE IF NOT EXISTS queue_items (
        id TEXT PRIMARY KEY,
        version TEXT NOT NULL,
        done_version TEXT,
        updated_at TEXT NOT NULL,
        repository TEXT NOT NULL,
        record TEXT NOT NULL CHECK (json_valid(record))
      ) STRICT;

      CREATE INDEX IF NOT EXISTS queue_items_active
        ON queue_items(done_version, version, updated_at DESC);
      CREATE INDEX IF NOT EXISTS queue_items_repository
        ON queue_items(repository, updated_at DESC);
    `);
  }

  async importLegacyFiles({
    legacyQueuePath,
    legacySettingsPath,
    normalizeQueueState,
    normalizeSettings,
  }) {
    if (this.#metadata("legacy-json-imported") === "1") return;

    const [legacyQueue, legacySettings] = await Promise.all([
      readOptionalJson(legacyQueuePath),
      readOptionalJson(legacySettingsPath),
    ]);
    const importLegacy = this.#database.transaction(() => {
      if (legacyQueue && this.#queueItemCount() === 0) {
        this.#replaceQueueState(normalizeQueueState(legacyQueue));
      }
      if (legacySettings && !this.#readSettingsDocument()) {
        this.#writeSettings(normalizeSettings(legacySettings));
      }
      this.#database
        .prepare("INSERT OR REPLACE INTO app_metadata(key, value) VALUES (?, ?)")
        .run("legacy-json-imported", "1");
    });
    importLegacy.immediate();
  }

  readSettings(fallback = {}) {
    return structuredClone(this.#readSettingsDocument() ?? fallback);
  }

  saveSettings(value) {
    const save = this.#database.transaction(() => this.#writeSettings(value));
    save.immediate();
    return structuredClone(value);
  }

  readQueueState({ view = "all", limit, offset = 0 } = {}) {
    const where = {
      active: "WHERE done_version IS NULL OR done_version <> version",
      done: "WHERE done_version = version",
      all: "",
    }[view];
    if (where === undefined) throw new TypeError(`Unsupported queue view "${view}".`);

    const boundedLimit = limit == null ? null : normalizeLimit(limit);
    const boundedOffset = normalizeOffset(offset);
    const sql = `
      SELECT id, record
      FROM queue_items
      ${where}
      ORDER BY updated_at DESC, id
      ${boundedLimit == null ? "" : "LIMIT ? OFFSET ?"}
    `;
    const rows =
      boundedLimit == null
        ? this.#database.prepare(sql).all()
        : this.#database.prepare(sql).all(boundedLimit, boundedOffset);
    const sync = this.#database
      .prepare("SELECT document FROM sync_state WHERE singleton = 1")
      .get();
    return {
      version: 2,
      sync: sync ? JSON.parse(sync.document) : structuredClone(defaultQueueState.sync),
      items: Object.fromEntries(rows.map(({ id, record }) => [id, JSON.parse(record)])),
    };
  }

  queueCounts() {
    const row = this.#database
      .prepare(`
        SELECT
          count(*) AS total,
          count(*) FILTER (WHERE done_version = version) AS done,
          count(*) FILTER (WHERE done_version IS NULL OR done_version <> version) AS active
        FROM queue_items
      `)
      .get();
    return { active: row.active, done: row.done, total: row.total };
  }

  activeQueueCounts() {
    const rows = this.#database
      .prepare(`
        SELECT
          COALESCE(json_extract(record, '$.item.kind'), '') AS kind,
          COALESCE(json_extract(record, '$.item.state'), '') AS state,
          COALESCE(json_extract(record, '$.item.draft'), 0) AS draft,
          COALESCE(json_extract(record, '$.item.authored'), 0) AS authored,
          COALESCE(json_extract(record, '$.item.reviewed'), 0) AS reviewed,
          COALESCE(json_extract(record, '$.item.latestReviewState'), '') AS latest_review_state,
          EXISTS (
            SELECT 1
            FROM json_each(queue_items.record, '$.item.signals') AS signal
            WHERE json_extract(signal.value, '$.kind') <> 'team-covered'
          ) AS has_attention_signal
        FROM queue_items
        WHERE (done_version IS NULL OR done_version <> version)
          AND json_type(record, '$.item') = 'object'
      `)
      .all();
    const counts = { reviewed: 0, new: 0, approved: 0, merged: 0, mine: 0, other: 0, nonpr: 0 };
    for (const row of rows) {
      if (row.kind === "notification") {
        counts.nonpr++;
        continue;
      }
      const lifecycle = lifecycleForQueueItem({
        state: row.state,
        draft: Boolean(row.draft),
        authored: Boolean(row.authored),
        reviewed: Boolean(row.reviewed),
        latestReviewState: row.latest_review_state,
        signals: row.has_attention_signal ? [{ kind: "attention" }] : [],
      });
      if (lifecycle !== "mine" && lifecycle !== "draft") counts[lifecycle]++;
      if (row.authored) counts.mine++;
    }
    return counts;
  }

  mutateQueueState(callback, { ids, updateSync = false } = {}) {
    if (typeof callback !== "function") throw new TypeError("callback must be a function.");
    if (typeof updateSync !== "boolean") throw new TypeError("updateSync must be a boolean.");
    const selectedIds = ids ? normalizeIds(ids) : null;
    const operation = this.#mutation.then(() => {
      const mutate = this.#database.transaction(() => {
        const state = selectedIds
          ? this.#readSelectedQueueState(selectedIds)
          : this.readQueueState();
        const result = callback(state);
        if (result && typeof result.then === "function") {
          throw new TypeError("Queue mutations must be synchronous.");
        }
        if (selectedIds) {
          this.#writeQueueRecords(state.items);
          if (updateSync) this.#writeSync(state.sync);
        } else {
          this.#replaceQueueState(state);
        }
        return result;
      });
      return mutate.immediate();
    });
    this.#mutation = operation.catch(() => {});
    return operation;
  }

  close() {
    if (!this.#database.open) return;
    this.#database.pragma("wal_checkpoint(TRUNCATE)");
    this.#database.close();
  }

  #metadata(key) {
    return this.#database.prepare("SELECT value FROM app_metadata WHERE key = ?").get(key)?.value;
  }

  #queueItemCount() {
    return this.#database.prepare("SELECT count(*) AS count FROM queue_items").get().count;
  }

  #readSettingsDocument() {
    const row = this.#database.prepare("SELECT document FROM settings WHERE singleton = 1").get();
    return row ? JSON.parse(row.document) : null;
  }

  #writeSettings(value) {
    this.#database
      .prepare("INSERT OR REPLACE INTO settings(singleton, document) VALUES (1, ?)")
      .run(JSON.stringify(value));
  }

  #readSelectedQueueState(ids) {
    if (ids.length === 0) return this.readQueueState({ limit: 0 });
    const placeholders = ids.map(() => "?").join(", ");
    const rows = this.#database
      .prepare(`SELECT id, record FROM queue_items WHERE id IN (${placeholders})`)
      .all(...ids);
    const sync = this.#database
      .prepare("SELECT document FROM sync_state WHERE singleton = 1")
      .get();
    return {
      version: 2,
      sync: sync ? JSON.parse(sync.document) : structuredClone(defaultQueueState.sync),
      items: Object.fromEntries(rows.map(({ id, record }) => [id, JSON.parse(record)])),
    };
  }

  #replaceQueueState(state) {
    const nextIds = new Set(Object.keys(state.items ?? {}));
    const deleteRecord = this.#database.prepare("DELETE FROM queue_items WHERE id = ?");
    for (const { id } of this.#database.prepare("SELECT id FROM queue_items").all()) {
      if (!nextIds.has(id)) deleteRecord.run(id);
    }
    this.#writeQueueRecords(state.items ?? {});
    this.#writeSync(state.sync);
  }

  #writeQueueRecords(records) {
    const write = this.#database.prepare(`
      INSERT INTO queue_items(id, version, done_version, updated_at, repository, record)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        version = excluded.version,
        done_version = excluded.done_version,
        updated_at = excluded.updated_at,
        repository = excluded.repository,
        record = excluded.record
      WHERE queue_items.record <> excluded.record
    `);
    for (const [id, record] of Object.entries(records)) {
      const item = record?.item ?? {};
      write.run(
        id,
        typeof record?.version === "string" ? record.version : "",
        typeof record?.doneVersion === "string" ? record.doneVersion : null,
        typeof item.updatedAt === "string"
          ? item.updatedAt
          : typeof record?.updatedAt === "string"
            ? record.updatedAt
            : "",
        typeof item.repository === "string" ? item.repository : "",
        JSON.stringify(record),
      );
    }
  }

  #writeSync(sync) {
    this.#database
      .prepare("INSERT OR REPLACE INTO sync_state(singleton, document) VALUES (1, ?)")
      .run(JSON.stringify(sync ?? defaultQueueState.sync));
  }
}

function normalizeIds(ids) {
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string" || id.length === 0)) {
    throw new TypeError("ids must be an array of non-empty strings.");
  }
  return [...new Set(ids)];
}

function normalizeLimit(value) {
  if (!Number.isInteger(value) || value < 0 || value > 1_000) {
    throw new TypeError("limit must be an integer between 0 and 1000.");
  }
  return value;
}

function normalizeOffset(value) {
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError("offset must be a non-negative integer.");
  }
  return value;
}

async function readOptionalJson(filePath) {
  if (!filePath) return null;
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}
