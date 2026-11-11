-- A replay run remembers the chat it was started from, so the Replay page can show each chat's saved replays as
-- numbered versions. Runs made before this (or from explicit prompts) have none. If the chat is deleted the link clears.
-- Never edit this file after it has been applied.
ALTER TABLE replay_runs ADD COLUMN source_conversation_id TEXT REFERENCES conversations(conversation_id) ON DELETE SET NULL;
