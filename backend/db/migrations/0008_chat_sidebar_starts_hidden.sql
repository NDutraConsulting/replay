-- The chat page's "This conversation" sidebar now starts hidden (like the replay page's "Your prompts" panel).
-- SQLite cannot change a column's default in place, so the small table is rebuilt with chat_sidebar_hidden DEFAULT 1.
-- Everyone's saved value is set to hidden once, because a 0 saved by an older default cannot be told apart from a
-- deliberate choice. They can open it again; that choice is remembered. Never edit this file after it has been applied.
CREATE TABLE user_preferences_new (
  user_id TEXT PRIMARY KEY REFERENCES users(user_id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL DEFAULT 'assistant',
  model TEXT,
  chat_sidebar_hidden INTEGER NOT NULL DEFAULT 1,
  replay_prompts_hidden INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);
INSERT INTO user_preferences_new (user_id, agent_id, model, chat_sidebar_hidden, replay_prompts_hidden, updated_at)
  SELECT user_id, agent_id, model, 1, replay_prompts_hidden, updated_at FROM user_preferences;
DROP TABLE user_preferences;
ALTER TABLE user_preferences_new RENAME TO user_preferences;
