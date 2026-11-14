-- Which conversation was forked from which. One row per fork, written in the same transaction that copies the messages.
-- The ids are plain (no foreign keys), on purpose: deleting a conversation keeps the rows, so a fork still knows where it
-- came from after its source is gone. `fork_id` is also the id of the matching row in Log.db's conversation_fork_log,
-- which is the append-only audit copy of the same event; the application reads only this table.
CREATE TABLE conversation_forks (
  fork_id                TEXT PRIMARY KEY,
  conversation_id        TEXT NOT NULL UNIQUE,   -- the new conversation (the fork): a conversation is forked into existence at most once
  origin_conversation_id TEXT NOT NULL,          -- the conversation it was forked from (the direct parent)
  created_at             TEXT NOT NULL,
  created_by             TEXT NOT NULL           -- user_id of whoever forked
);
CREATE INDEX idx_conversation_forks_origin ON conversation_forks(origin_conversation_id, created_by);
