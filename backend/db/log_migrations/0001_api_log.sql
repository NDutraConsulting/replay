-- Log.db: the raw REST calls made to the model provider while a replay result was produced.
-- Rows carry plain ids (no foreign keys into app.db, which is a different file); every read is scoped through the
-- replay run, and the API key is never stored: only a placeholder for the Authorization header.
-- Never edit this file after it has been applied.
CREATE TABLE api_log_turns (
  replay_run_id TEXT NOT NULL,
  slot TEXT NOT NULL CHECK (slot IN ('a', 'b')),
  turn_index INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  logged_at TEXT NOT NULL,
  PRIMARY KEY (replay_run_id, slot, turn_index)
);  -- a turn is listed here once it was logged, even when it made no calls (demo mode)

CREATE TABLE api_calls (
  api_call_id INTEGER PRIMARY KEY AUTOINCREMENT,
  replay_run_id TEXT NOT NULL,
  slot TEXT NOT NULL CHECK (slot IN ('a', 'b')),
  turn_index INTEGER NOT NULL,
  seq INTEGER NOT NULL,                 -- the order of the calls within the turn
  user_id TEXT NOT NULL,
  purpose TEXT NOT NULL,                -- answer, kb_summary, compact_summary, kb_route:<level>
  method TEXT NOT NULL,
  url TEXT NOT NULL,
  request_headers_json TEXT NOT NULL,
  request_body_json TEXT NOT NULL,
  response_status INTEGER,              -- NULL when there was no response
  response_body TEXT,
  response_truncated INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  duration_ms INTEGER NOT NULL,
  called_at TEXT NOT NULL,
  UNIQUE (replay_run_id, slot, turn_index, seq)
);
CREATE INDEX idx_api_calls_user ON api_calls(user_id);
