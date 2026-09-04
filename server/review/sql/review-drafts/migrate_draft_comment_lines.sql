DELETE FROM review_draft_comments
WHERE id IN (
  SELECT id
  FROM (
    SELECT
      id,
      ROW_NUMBER() OVER (
        PARTITION BY draft_slug, path, line, side
        ORDER BY updated_at DESC, id DESC
      ) AS row_number
    FROM review_draft_comments
  )
  WHERE row_number > 1
);

CREATE UNIQUE INDEX IF NOT EXISTS review_draft_comments_line
  ON review_draft_comments(draft_slug, path, line, side);
