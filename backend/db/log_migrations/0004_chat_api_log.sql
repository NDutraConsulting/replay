-- Log.db: the raw REST calls made to the model provider while the Chat page answered a prompt, so the chat can show
-- exactly what was sent (the education view). A call is kept under the request id of the prompt that caused it (the same
-- id the app.db message carries), so a rewound prompt simply has no visible message to show them under.
-- Rows carry plain ids (no foreign keys into app.db); the API key is never stored. Never edit this file after it has
-- been applied.
CREATE TABLE chat_api_requests (
  request_id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  logged_at TEXT NOT NULL
);  -- a prompt is listed here once it was logged, even when it made no calls (demo mode)
CREATE INDEX idx_chat_api_requests_conversation ON chat_api_requests(conversation_id, user_id);

CREATE TABLE chat_api_calls (
  chat_api_call_id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  seq INTEGER NOT NULL,                 -- the order of the calls for the prompt
  user_id TEXT NOT NULL,
  purpose TEXT NOT NULL,                -- answer, kb_summary, kb_route:<level>
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
  settings_json TEXT,
  logprobs_json TEXT,
  UNIQUE (request_id, seq)
);
CREATE INDEX idx_chat_api_calls_conversation ON chat_api_calls(conversation_id, user_id);
