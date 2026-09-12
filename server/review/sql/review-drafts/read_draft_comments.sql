SELECT id, path, line, side, body, reply_to_comment_id, created_at, updated_at
FROM review_draft_comments
WHERE draft_slug = ?
ORDER BY created_at ASC, id ASC;
