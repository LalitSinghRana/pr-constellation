INSERT INTO queue_items(id, version, done_version, updated_at, repository, record)
VALUES (?, ?, ?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET
  version = excluded.version,
  done_version = excluded.done_version,
  updated_at = excluded.updated_at,
  repository = excluded.repository,
  record = excluded.record
WHERE queue_items.record <> excluded.record;
