import { chmod, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";
import { lifecycleForQueueItem } from "../../shared/queue-policy.js";
import {
  readConversation,
  schema as reviewConversationSchema,
  upsertConversation,
} from "../review/review-conversation-sql.js";
import {
  addReplyToCommentId,
  deleteDraft,
  deleteDraftComment,
  draftExists,
  insertDraft,
  insertDraftComment,
  readDraft,
  readDraftComments,
  schema as reviewDraftSchema,
  tableInfoReviewDraftComments,
  updateDraftBody,
  updateDraftComment,
} from "../review/review-draft-sql.js";
import {
  activeQueueCountRows,
  countQueueItems,
  deleteQueueItem,
  schema as inboxSchema,
  queueCounts,
  queueItemsByIdsSql,
  queueItemsSelectSql,
  readAppMetadata,
  readSettingsDocument,
  readSyncDocument,
  selectQueueItemIds,
  upsertAppMetadata,
  upsertQueueItem,
  upsertSettings,
  upsertSyncState,
} from "./inbox-sql.js";

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
    this.#database.exec(inboxSchema);
    this.#database.exec(reviewDraftSchema);
    this.#database.exec(reviewConversationSchema);
    this.#migrateReviewDraftComments();
  }

  #migrateReviewDraftComments() {
    const columns = this.#database.prepare(tableInfoReviewDraftComments).all();
    if (!columns.some((column) => column.name === "reply_to_comment_id")) {
      this.#database.exec(addReplyToCommentId);
    }
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
      this.#database.prepare(upsertAppMetadata).run("legacy-json-imported", "1");
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
    const boundedLimit = limit == null ? null : normalizeLimit(limit);
    const boundedOffset = normalizeOffset(offset);
    const sql = queueItemsSelectSql(view, { paged: boundedLimit != null });
    const rows =
      boundedLimit == null
        ? this.#database.prepare(sql).all()
        : this.#database.prepare(sql).all(boundedLimit, boundedOffset);
    const sync = this.#database.prepare(readSyncDocument).get();
    return {
      version: 2,
      sync: sync ? JSON.parse(sync.document) : structuredClone(defaultQueueState.sync),
      items: Object.fromEntries(rows.map(({ id, record }) => [id, JSON.parse(record)])),
    };
  }

  queueCounts() {
    const row = this.#database.prepare(queueCounts).get();
    return { active: row.active, done: row.done, total: row.total };
  }

  activeQueueCounts() {
    const rows = this.#database.prepare(activeQueueCountRows).all();
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

  readReviewDraft(slug) {
    const draft = this.#database.prepare(readDraft).get(slug);
    if (!draft) return null;
    const comments = this.#database.prepare(readDraftComments).all(slug);
    return {
      body: draft.body,
      comments: comments.map((comment) => ({
        body: comment.body,
        createdAt: comment.created_at,
        id: comment.id,
        line: comment.line,
        path: comment.path,
        replyToCommentId: comment.reply_to_comment_id ?? null,
        side: comment.side,
        updatedAt: comment.updated_at,
      })),
      createdAt: draft.created_at,
      headSha: draft.head_sha,
      number: draft.number,
      owner: draft.owner,
      prUrl: draft.pr_url,
      repo: draft.repo,
      slug: draft.slug,
      updatedAt: draft.updated_at,
    };
  }

  ensureReviewDraft(context, { now = new Date().toISOString() } = {}) {
    const existing = this.readReviewDraft(context.slug);
    if (existing) {
      if (existing.headSha !== context.headSha) {
        const error = new Error("Review draft is tied to an older commit.");
        error.code = "HEAD_STALE";
        throw error;
      }
      return existing;
    }
    this.#database
      .prepare(insertDraft)
      .run(
        context.slug,
        context.prUrl,
        context.owner,
        context.repo,
        Number(context.number),
        context.headSha,
        now,
        now,
      );
    return this.readReviewDraft(context.slug);
  }

  updateReviewDraftBody(slug, body, { now = new Date().toISOString() } = {}) {
    const result = this.#database.prepare(updateDraftBody).run(String(body || ""), now, slug);
    if (result.changes === 0) {
      throw new Error("Review draft not found.");
    }
    return this.readReviewDraft(slug);
  }

  addReviewDraftComment(slug, comment, { now = new Date().toISOString() } = {}) {
    const insert = this.#database.transaction(() => {
      if (!this.#database.prepare(draftExists).get(slug)) {
        throw new Error("Review draft not found.");
      }
      this.#database
        .prepare(insertDraftComment)
        .run(
          comment.id,
          slug,
          comment.path,
          comment.line,
          comment.side,
          comment.body,
          comment.replyToCommentId ?? null,
          now,
          now,
        );
      return this.readReviewDraft(slug);
    });
    return insert.immediate();
  }

  updateReviewDraftComment(slug, commentId, body, { now = new Date().toISOString() } = {}) {
    const result = this.#database
      .prepare(updateDraftComment)
      .run(String(body || ""), now, slug, commentId);
    if (result.changes === 0) {
      throw new Error("Draft comment not found.");
    }
    return this.readReviewDraft(slug);
  }

  deleteReviewDraftComment(slug, commentId) {
    const result = this.#database.prepare(deleteDraftComment).run(slug, commentId);
    if (result.changes === 0) {
      throw new Error("Draft comment not found.");
    }
    return this.readReviewDraft(slug);
  }

  deleteReviewDraft(slug) {
    this.#database.prepare(deleteDraft).run(slug);
  }

  readReviewConversation({ number, owner, repo }) {
    const coordinates = normalizePullRequestCoordinates({ number, owner, repo });
    const row = this.#database
      .prepare(readConversation)
      .get(coordinates.owner, coordinates.repo, coordinates.number);
    return row ? JSON.parse(row.document) : null;
  }

  saveReviewConversation({
    conversation,
    number,
    owner,
    repo,
    fetchedAt = new Date().toISOString(),
  }) {
    const coordinates = normalizePullRequestCoordinates({ number, owner, repo });
    if (!isConversationDocument(conversation)) {
      throw new TypeError("conversation must contain timeline and threads arrays.");
    }
    if (typeof fetchedAt !== "string" || Number.isNaN(new Date(fetchedAt).getTime())) {
      throw new TypeError("fetchedAt must be an ISO timestamp.");
    }
    this.#database
      .prepare(upsertConversation)
      .run(
        coordinates.owner,
        coordinates.repo,
        coordinates.number,
        fetchedAt,
        JSON.stringify(conversation),
      );
    return structuredClone(conversation);
  }

  #metadata(key) {
    return this.#database.prepare(readAppMetadata).get(key)?.value;
  }

  #queueItemCount() {
    return this.#database.prepare(countQueueItems).get().count;
  }

  #readSettingsDocument() {
    const row = this.#database.prepare(readSettingsDocument).get();
    return row ? JSON.parse(row.document) : null;
  }

  #writeSettings(value) {
    this.#database.prepare(upsertSettings).run(JSON.stringify(value));
  }

  #readSelectedQueueState(ids) {
    if (ids.length === 0) return this.readQueueState({ limit: 0 });
    const rows = this.#database.prepare(queueItemsByIdsSql(ids.length)).all(...ids);
    const sync = this.#database.prepare(readSyncDocument).get();
    return {
      version: 2,
      sync: sync ? JSON.parse(sync.document) : structuredClone(defaultQueueState.sync),
      items: Object.fromEntries(rows.map(({ id, record }) => [id, JSON.parse(record)])),
    };
  }

  #replaceQueueState(state) {
    const nextIds = new Set(Object.keys(state.items ?? {}));
    const deleteRecord = this.#database.prepare(deleteQueueItem);
    for (const { id } of this.#database.prepare(selectQueueItemIds).all()) {
      if (!nextIds.has(id)) deleteRecord.run(id);
    }
    this.#writeQueueRecords(state.items ?? {});
    this.#writeSync(state.sync);
  }

  #writeQueueRecords(records) {
    const write = this.#database.prepare(upsertQueueItem);
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
    this.#database.prepare(upsertSyncState).run(JSON.stringify(sync ?? defaultQueueState.sync));
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

function normalizePullRequestCoordinates({ number, owner, repo }) {
  if (typeof owner !== "string" || !owner.trim()) {
    throw new TypeError("owner must be a non-empty string.");
  }
  if (typeof repo !== "string" || !repo.trim()) {
    throw new TypeError("repo must be a non-empty string.");
  }
  if (!Number.isInteger(number) || number < 1) {
    throw new TypeError("number must be a positive integer.");
  }
  return { number, owner: owner.trim(), repo: repo.trim() };
}

function isConversationDocument(value) {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    Array.isArray(value.timeline) &&
    Array.isArray(value.threads)
  );
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
