-- Phase 8: a message has a type. Never edit this file after it has been applied.
--
--   chat             a normal turn (everything that existed before this migration)
--   kb_reference     internal row: "this turn was answered with version X of a knowledge base file". It holds NO text
--                    (content is only the display label); the text is read from the version when history is built.
--   kb_summary_tool  internal row: the model-written summary of that file that was sent in place of its text
--   compacted_summary  the first message of a conversation that was started by Compact: a model-written summary of the
--                    earlier conversation. The earlier conversation is untouched.
--
-- Internal rows share the request_id of the prompt they belong to. They are never shown as turns.
ALTER TABLE messages ADD COLUMN message_type TEXT NOT NULL DEFAULT 'chat'
  CHECK (message_type IN ('chat', 'kb_reference', 'kb_summary_tool', 'compacted_summary'));
ALTER TABLE messages ADD COLUMN kb_version_id TEXT;   -- kb_document_versions.version_id (lives in knowledgebase.db)
ALTER TABLE messages ADD COLUMN kb_label TEXT;        -- "Category / Sub category / file", readable after a deletion
CREATE INDEX idx_messages_kb_version ON messages(kb_version_id);

-- A conversation started by Compact points back at the conversation it summarises.
ALTER TABLE conversations ADD COLUMN source_conversation_id TEXT REFERENCES conversations(conversation_id) ON DELETE SET NULL;
