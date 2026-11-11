-- Replay steps are identified by a client-generated request id, like chat sends, so a stop can name its step
-- (a marker keyed by the cursor would wrongly refuse a later, legitimate step at the same cursor).
ALTER TABLE replay_runs ADD COLUMN step_request_id TEXT;   -- the request id of the running or last step
