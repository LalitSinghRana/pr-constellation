UPDATE review_draft_comments
SET body = ?, updated_at = ?
WHERE draft_slug = ? AND id = ?;
