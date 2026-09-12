import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

function sql(relativePath) {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8").trim();
}

export const schema = sql("./sql/inbox/schema.sql");
export const upsertAppMetadata = sql("./sql/inbox/upsert_app_metadata.sql");
export const readAppMetadata = sql("./sql/inbox/read_app_metadata.sql");
export const selectQueueItemsAll = sql("./sql/inbox/select_queue_items_all.sql");
export const selectQueueItemsAllPaged = sql("./sql/inbox/select_queue_items_all_paged.sql");
export const selectQueueItemsActive = sql("./sql/inbox/select_queue_items_active.sql");
export const selectQueueItemsActivePaged = sql("./sql/inbox/select_queue_items_active_paged.sql");
export const selectQueueItemsDone = sql("./sql/inbox/select_queue_items_done.sql");
export const selectQueueItemsDonePaged = sql("./sql/inbox/select_queue_items_done_paged.sql");
export const selectQueueItemsByIdsTemplate = sql("./sql/inbox/select_queue_items_by_ids.sql");
export const queueCounts = sql("./sql/inbox/queue_counts.sql");
export const activeQueueCountRows = sql("./sql/inbox/active_queue_count_rows.sql");
export const countQueueItems = sql("./sql/inbox/count_queue_items.sql");
export const readSettingsDocument = sql("./sql/inbox/read_settings_document.sql");
export const upsertSettings = sql("./sql/inbox/upsert_settings.sql");
export const readSyncDocument = sql("./sql/inbox/read_sync_document.sql");
export const upsertSyncState = sql("./sql/inbox/upsert_sync_state.sql");
export const selectQueueItemIds = sql("./sql/inbox/select_queue_item_ids.sql");
export const deleteQueueItem = sql("./sql/inbox/delete_queue_item.sql");
export const upsertQueueItem = sql("./sql/inbox/upsert_queue_item.sql");

const queueItemsSelect = {
  all: { all: selectQueueItemsAll, paged: selectQueueItemsAllPaged },
  active: { all: selectQueueItemsActive, paged: selectQueueItemsActivePaged },
  done: { all: selectQueueItemsDone, paged: selectQueueItemsDonePaged },
};

export function queueItemsSelectSql(view, { paged = false } = {}) {
  const statements = queueItemsSelect[view];
  if (!statements) {
    throw new TypeError(`Unsupported queue view "${view}".`);
  }
  return paged ? statements.paged : statements.all;
}

export function queueItemsByIdsSql(idCount) {
  if (!Number.isInteger(idCount) || idCount < 1) {
    throw new TypeError("idCount must be a positive integer.");
  }
  const placeholders = Array.from({ length: idCount }, () => "?").join(", ");
  return selectQueueItemsByIdsTemplate.replace("__IDS__", placeholders);
}
