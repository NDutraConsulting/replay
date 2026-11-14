-- A conversation can be locked: no more prompts can be added to it, but it stays available for replay. Opening a locked
-- conversation to continue it creates a fork (a copy with a new conversation id), so replays stay bound to the source.
-- A conversation is locked by the user (lock_reason 'user') or automatically when a replay of it starts (lock_reason 'replay').
-- Forks are recorded in Log.db (conversation_fork_log), not here.
ALTER TABLE conversations ADD COLUMN locked_at TEXT;      -- NULL = open, else when it was locked
ALTER TABLE conversations ADD COLUMN lock_reason TEXT CHECK (lock_reason IN ('user', 'replay'));

-- Conversations that already have a started replay bound to them are locked, so old data follows the new rule.
UPDATE conversations
   SET locked_at = strftime('%Y-%m-%dT%H:%M:%f+00:00', 'now'), lock_reason = 'replay'
 WHERE conversation_id IN (
   SELECT DISTINCT source_conversation_id FROM replay_runs
    WHERE source_conversation_id IS NOT NULL AND cursor > 0);
