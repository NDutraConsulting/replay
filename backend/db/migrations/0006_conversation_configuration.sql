-- Phase 8: a conversation's configuration is chosen once, in the New conversation popup, and is fixed for its life:
-- agent, model, reasoning level and the KB-summary-tool switch. Only the name (a free label) can be renamed later.
-- Never edit this file after it has been applied.
--
-- Older conversations are filled in from what they already used: the agent and model of their latest answer, else the
-- user's saved preferences. A conversation that has neither keeps model '' and is given the user's first model the
-- next time it is opened (conversation_service).
ALTER TABLE conversations ADD COLUMN name TEXT NOT NULL DEFAULT '';
ALTER TABLE conversations ADD COLUMN agent_id TEXT NOT NULL DEFAULT '';
ALTER TABLE conversations ADD COLUMN model TEXT NOT NULL DEFAULT '';
ALTER TABLE conversations ADD COLUMN reasoning_level TEXT NOT NULL DEFAULT 'default'
  CHECK (reasoning_level IN ('default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh'));
ALTER TABLE conversations ADD COLUMN kb_summary_tool INTEGER NOT NULL DEFAULT 0 CHECK (kb_summary_tool IN (0, 1));

UPDATE conversations SET agent_id = COALESCE(
  (SELECT a.agent_id FROM messages m JOIN agents a ON a.name = m.agent
    WHERE m.conversation_id = conversations.conversation_id AND m.agent IS NOT NULL
    ORDER BY m.sequence_number DESC LIMIT 1),
  (SELECT p.agent_id FROM user_preferences p WHERE p.user_id = conversations.user_id),
  'assistant');
UPDATE conversations SET model = COALESCE(
  (SELECT m.model FROM messages m
    WHERE m.conversation_id = conversations.conversation_id AND m.model IS NOT NULL
    ORDER BY m.sequence_number DESC LIMIT 1),
  (SELECT p.model FROM user_preferences p WHERE p.user_id = conversations.user_id),
  '');
UPDATE conversations SET name = agent_id || ' ' || substr(created_at, 1, 10);
