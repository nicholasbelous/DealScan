-- Store the minimum needed. No seller names, no profile URLs, no raw page HTML.

CREATE TABLE tokens (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);

CREATE TABLE listings (
  item_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  title TEXT NOT NULL,
  price REAL NOT NULL,
  condition TEXT,
  category TEXT,
  description TEXT,
  first_seen_at INTEGER NOT NULL,
  PRIMARY KEY (item_id, content_hash)
);

CREATE TABLE evaluations (
  id INTEGER PRIMARY KEY,
  token_id INTEGER REFERENCES tokens (id),
  item_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('valid', 'rejected', 'error')),
  rejection_reason TEXT,
  score INTEGER,
  verdict TEXT,
  price_low REAL,
  price_high REAL,
  suggested_offer REAL,
  raw_response TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL,
  latency_ms INTEGER,
  cache_hit INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE INDEX evaluations_created_at ON evaluations (created_at);
CREATE INDEX evaluations_item ON evaluations (item_id, created_at);

-- Human labels, for the eval harness.
CREATE TABLE labels (
  item_id TEXT PRIMARY KEY,
  human_price_low REAL,
  human_price_high REAL,
  readable INTEGER NOT NULL,
  notes TEXT,
  labeled_at INTEGER NOT NULL
);
