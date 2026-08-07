CREATE TABLE IF NOT EXISTS app_metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS settings (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  document TEXT NOT NULL CHECK (json_valid(document))
) STRICT;

CREATE TABLE IF NOT EXISTS sync_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  document TEXT NOT NULL CHECK (json_valid(document))
) STRICT;

CREATE TABLE IF NOT EXISTS queue_items (
  id TEXT PRIMARY KEY,
  version TEXT NOT NULL,
  done_version TEXT,
  updated_at TEXT NOT NULL,
  repository TEXT NOT NULL,
  record TEXT NOT NULL CHECK (json_valid(record))
) STRICT;

CREATE INDEX IF NOT EXISTS queue_items_active
  ON queue_items(done_version, version, updated_at DESC);
CREATE INDEX IF NOT EXISTS queue_items_repository
  ON queue_items(repository, updated_at DESC);
