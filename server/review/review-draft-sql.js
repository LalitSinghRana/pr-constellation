import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

function sql(relativePath) {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8").trim();
}

export const schema = sql("./sql/review-drafts/schema.sql");
export const readDraft = sql("./sql/review-drafts/read_draft.sql");
export const readDraftComments = sql("./sql/review-drafts/read_draft_comments.sql");
export const insertDraft = sql("./sql/review-drafts/insert_draft.sql");
export const updateDraftBody = sql("./sql/review-drafts/update_draft_body.sql");
export const draftExists = sql("./sql/review-drafts/draft_exists.sql");
export const upsertDraftComment = sql("./sql/review-drafts/upsert_draft_comment.sql");
export const migrateDraftCommentLines = sql("./sql/review-drafts/migrate_draft_comment_lines.sql");
export const updateDraftComment = sql("./sql/review-drafts/update_draft_comment.sql");
export const deleteDraftComment = sql("./sql/review-drafts/delete_draft_comment.sql");
export const deleteDraft = sql("./sql/review-drafts/delete_draft.sql");
export const tableInfoReviewDraftComments = sql(
  "./sql/review-drafts/table_info_review_draft_comments.sql",
);
export const addReplyToCommentId = sql("./sql/review-drafts/add_reply_to_comment_id.sql");
