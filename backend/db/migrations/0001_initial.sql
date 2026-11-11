-- Initial schema. Never edit this file after it has been applied anywhere; add 0002_*.sql instead.

CREATE TABLE users (
  user_id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE sessions (
  session_token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

CREATE TABLE agents (
  agent_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  system_prompt TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE provider_settings (
  user_id TEXT PRIMARY KEY REFERENCES users(user_id) ON DELETE CASCADE,
  base_url TEXT NOT NULL DEFAULT '',
  api_key TEXT NOT NULL DEFAULT '',          -- Fernet ciphertext, '' = none
  models_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE user_preferences (
  user_id TEXT PRIMARY KEY REFERENCES users(user_id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL DEFAULT 'assistant',
  model TEXT,
  chat_sidebar_hidden INTEGER NOT NULL DEFAULT 0,
  replay_prompts_hidden INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);

CREATE TABLE conversations (
  conversation_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  is_sample INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_conversations_user ON conversations(user_id, created_at);

CREATE TABLE messages (
  message_id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(conversation_id) ON DELETE CASCADE,
  sequence_number INTEGER NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  -- complete | pending | stopped | failed | ignored (see models/conversation.py)
  status TEXT NOT NULL DEFAULT 'complete' CHECK (status IN ('complete', 'pending', 'stopped', 'failed', 'ignored')),
  model TEXT,
  agent TEXT,
  demo INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE (conversation_id, sequence_number)
);

CREATE TABLE chat_records (
  chat_record_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  prompts_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_chat_records_user ON chat_records(user_id, created_at);

CREATE TABLE replay_runs (
  replay_run_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL,
  prompts_json TEXT NOT NULL,
  model_a TEXT NOT NULL,
  model_b TEXT NOT NULL,
  cursor INTEGER NOT NULL DEFAULT 0,
  stop_requested INTEGER NOT NULL DEFAULT 0,
  step_started_at TEXT,                       -- set while a step is running (stale after a timeout)
  saved_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_replay_runs_user ON replay_runs(user_id, created_at);

CREATE TABLE replay_results (
  replay_result_id TEXT PRIMARY KEY,
  replay_run_id TEXT NOT NULL REFERENCES replay_runs(replay_run_id) ON DELETE CASCADE,
  slot TEXT NOT NULL CHECK (slot IN ('a', 'b')),
  turn_index INTEGER NOT NULL,
  content TEXT NOT NULL,
  model TEXT NOT NULL,
  demo INTEGER NOT NULL DEFAULT 0,
  error INTEGER NOT NULL DEFAULT 0,
  decision_trace_json TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (replay_run_id, slot, turn_index)
);

CREATE TABLE kb_categories (
  category_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(agent_id),
  name TEXT NOT NULL COLLATE NOCASE,
  created_at TEXT NOT NULL,
  UNIQUE (user_id, agent_id, name)
);

CREATE TABLE kb_subcategories (
  subcategory_id TEXT PRIMARY KEY,
  category_id TEXT NOT NULL REFERENCES kb_categories(category_id) ON DELETE CASCADE,
  name TEXT NOT NULL COLLATE NOCASE,
  created_at TEXT NOT NULL,
  UNIQUE (category_id, name)
);

CREATE TABLE kb_documents (
  document_id TEXT PRIMARY KEY,
  subcategory_id TEXT NOT NULL REFERENCES kb_subcategories(subcategory_id) ON DELETE CASCADE,
  title TEXT NOT NULL COLLATE NOCASE,
  content TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending-review'
    CHECK (status IN ('current', 'pending-review', 'malicious-active', 'quarantined', 'archived')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (subcategory_id, title)
);

-- A user's knowledge base for an agent is seeded once, on first read; this marker stops a
-- user who deleted everything from being re-seeded.
CREATE TABLE kb_seeded (
  user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(agent_id),
  PRIMARY KEY (user_id, agent_id)
);
