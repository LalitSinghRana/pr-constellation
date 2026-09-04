INSERT INTO review_conversations (owner, repo, number, fetched_at, document)
VALUES (?, ?, ?, ?, ?)
ON CONFLICT (owner, repo, number) DO UPDATE SET
  fetched_at = excluded.fetched_at,
  document = excluded.document
