CREATE TABLE IF NOT EXISTS review_conversations (
  owner TEXT NOT NULL,
  repo TEXT NOT NULL,
  number INTEGER NOT NULL,
  fetched_at TEXT NOT NULL,
  document TEXT NOT NULL CHECK (json_valid(document)),
  PRIMARY KEY (owner, repo, number)
) STRICT;

CREATE INDEX IF NOT EXISTS review_conversations_fetched_at
  ON review_conversations(fetched_at DESC);
