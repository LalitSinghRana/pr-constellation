INSERT INTO review_draft_comments(
  id, draft_slug, path, line, side, body, reply_to_comment_id, created_at, updated_at
)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(draft_slug, path, line, side) DO UPDATE SET
  body = excluded.body,
  reply_to_comment_id = excluded.reply_to_comment_id,
  updated_at = excluded.updated_at;
