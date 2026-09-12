import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

function sql(relativePath) {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8").trim();
}

export const schema = sql("./sql/review-conversations/schema.sql");
export const readConversation = sql("./sql/review-conversations/read_conversation.sql");
export const upsertConversation = sql("./sql/review-conversations/upsert_conversation.sql");
