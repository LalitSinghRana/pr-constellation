INSERT INTO review_draft_comments(
  id, draft_slug, path, line, side, body, reply_to_comment_id, created_at, updated_at
)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);
