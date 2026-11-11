-- A stop command can reach the server BEFORE the request it cancels (the UI shows "Stop" the moment a prompt is
-- sent). The early stop leaves a marker that the request consumes when it arrives.
ALTER TABLE messages ADD COLUMN request_id TEXT;       -- the client's id for the send (user messages only)
CREATE INDEX idx_messages_request ON messages(conversation_id, request_id);

CREATE TABLE stop_requests (
  scope TEXT NOT NULL CHECK (scope IN ('message', 'step')),
  scope_id TEXT NOT NULL,        -- conversation id (message) or replay run id (step)
  token TEXT NOT NULL,           -- the send's request_id (message) or the replay cursor (step)
  created_at TEXT NOT NULL,
  PRIMARY KEY (scope, scope_id, token)
);
