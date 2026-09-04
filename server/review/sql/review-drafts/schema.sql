CREATE TABLE IF NOT EXISTS review_drafts (
  slug TEXT PRIMARY KEY,
  pr_url TEXT NOT NULL,
  owner TEXT NOT NULL,
  repo TEXT NOT NULL,
  number INTEGER NOT NULL,
  head_sha TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS review_draft_comments (
  id TEXT PRIMARY KEY,
  draft_slug TEXT NOT NULL REFERENCES review_drafts(slug) ON DELETE CASCADE,
  path TEXT NOT NULL,
  line INTEGER NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('LEFT', 'RIGHT')),
  body TEXT NOT NULL,
  reply_to_comment_id INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

