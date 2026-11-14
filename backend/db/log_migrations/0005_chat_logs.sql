-- Log.db chat logs, redone for immutability (the project is in beta, so the old chat log rows are discarded here, once,
-- BEFORE the append-only triggers below exist). After this migration the application never updates or deletes a row of
-- these tables: a log is an append-only record. Deleting logs is an administrator procedure that this application does
-- not provide (it would have to drop the triggers first).
DROP TABLE IF EXISTS chat_api_calls;
DROP TABLE IF EXISTS chat_api_requests;

-- One row per prompt of a conversation, pointing at the logged request. A fork copies these rows (new conversation id,
-- new message id, same request id): the calls themselves are shared and never copied.
CREATE TABLE chat_api_conversation_requests (
  conversation_id TEXT NOT NULL,   -- the conversation whose prompt this is (a source or a fork)
  request_id      TEXT NOT NULL,   -- joins to chat_api_calls.request_id
  message_id      TEXT NOT NULL,   -- the prompt (user message) in that conversation
  user_id         TEXT NOT NULL,
  logged_at       TEXT NOT NULL,   -- a prompt is listed once it was logged, even when it made no calls (demo mode)
  UNIQUE (conversation_id, request_id)
);
CREATE INDEX idx_cacr_conversation ON chat_api_conversation_requests(conversation_id, user_id);
CREATE INDEX idx_cacr_request ON chat_api_conversation_requests(request_id, user_id);

-- The raw REST calls made to the model provider for a prompt, one row per attempt. The API key is never stored.
CREATE TABLE chat_api_calls (
  chat_api_call_id      INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id            TEXT NOT NULL,
  conversation_id       TEXT NOT NULL,   -- the conversation that made the call
  seq                   INTEGER NOT NULL,-- the order of the calls for the prompt
  user_id               TEXT NOT NULL,
  purpose               TEXT NOT NULL,   -- answer, kb_summary, kb_route:<level>
  method                TEXT NOT NULL,
  url                   TEXT NOT NULL,
  request_headers_json  TEXT NOT NULL,
  request_body_json     TEXT NOT NULL,
  http_status           INTEGER,         -- the HTTP status; NULL when there was no response
  response_body         TEXT,
  response_truncated    INTEGER NOT NULL DEFAULT 0,
  error                 TEXT,
  duration_ms           INTEGER NOT NULL,
  called_at             TEXT NOT NULL,
  settings_json         TEXT,
  logprobs_json         TEXT,
  request_retry_counter INTEGER,         -- 0 = first attempt of this purpose for the prompt, 1 = first retry, ...
  api_response_code     TEXT,            -- the provider's own error code, NULL on success or without a response
  response_status       TEXT NOT NULL CHECK (response_status IN ('failed', 'timeout', 'success', 'error')),
  UNIQUE (request_id, seq)
);
CREATE INDEX idx_chat_api_calls_request ON chat_api_calls(request_id, user_id);
CREATE INDEX idx_chat_api_calls_conversation ON chat_api_calls(conversation_id, user_id);

-- Who forked a conversation from which. One row per fork; a conversation comes into being as a fork at most once.
CREATE TABLE conversation_fork_log (
  fork_id                TEXT PRIMARY KEY,
  conversation_id        TEXT NOT NULL UNIQUE,  -- the new conversation (the fork)
  origin_conversation_id TEXT NOT NULL,         -- the conversation it was forked from (the direct parent)
  created_at             TEXT NOT NULL,
  created_by             TEXT NOT NULL          -- user_id of whoever forked
);
CREATE INDEX idx_cfl_origin ON conversation_fork_log(origin_conversation_id, created_by);

-- Append-only: refuse every UPDATE and DELETE. Inserts are the only way in.
CREATE TRIGGER chat_api_conversation_requests_no_update BEFORE UPDATE ON chat_api_conversation_requests
BEGIN SELECT RAISE(ABORT, 'Log.db is append-only'); END;
CREATE TRIGGER chat_api_conversation_requests_no_delete BEFORE DELETE ON chat_api_conversation_requests
BEGIN SELECT RAISE(ABORT, 'Log.db is append-only'); END;
CREATE TRIGGER chat_api_calls_no_update BEFORE UPDATE ON chat_api_calls
BEGIN SELECT RAISE(ABORT, 'Log.db is append-only'); END;
CREATE TRIGGER chat_api_calls_no_delete BEFORE DELETE ON chat_api_calls
BEGIN SELECT RAISE(ABORT, 'Log.db is append-only'); END;
CREATE TRIGGER conversation_fork_log_no_update BEFORE UPDATE ON conversation_fork_log
BEGIN SELECT RAISE(ABORT, 'Log.db is append-only'); END;
CREATE TRIGGER conversation_fork_log_no_delete BEFORE DELETE ON conversation_fork_log
BEGIN SELECT RAISE(ABORT, 'Log.db is append-only'); END;
