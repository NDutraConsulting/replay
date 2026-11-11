-- The knowledge base database (knowledgebase.db). Never edit this file after it has been applied; add 0002_*.sql.
--
-- It is a separate SQLite file from app.db, so there are NO foreign keys to users or agents: user_id and agent_id are
-- plain columns. The service layer checks the agent against app.db, and every query is scoped by user_id.

CREATE TABLE kb_categories (
  category_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  name TEXT NOT NULL COLLATE NOCASE,
  created_at TEXT NOT NULL,
  UNIQUE (user_id, agent_id, name)
);
CREATE INDEX idx_kb_categories_owner ON kb_categories(user_id, agent_id);

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

-- A user's knowledge base for an agent is seeded once, on first use; this marker stops a user who deleted
-- everything from being re-seeded.
CREATE TABLE kb_seeded (
  user_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  PRIMARY KEY (user_id, agent_id)
);

-- What each agent was offered at every routing level, and what it selected (one row per level, up to three per
-- answer). Written by the routing step (a later phase); created now so the schema is complete.
CREATE TABLE knowledge_base_choice (
  choice_id    TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  agent_id     TEXT NOT NULL,
  scope        TEXT NOT NULL CHECK (scope IN ('chat', 'replay')),
  scope_id     TEXT NOT NULL,   -- chat: conversation_id; replay: replay_run_id
  ref          TEXT NOT NULL,   -- chat: the send's request_id; replay: "{slot}:{turn_index}", e.g. "a:2"
  step_number  INTEGER NOT NULL CHECK (step_number BETWEEN 1 AND 3),
  level        TEXT NOT NULL CHECK (level IN ('category', 'subcategory', 'file')),
  model        TEXT,            -- the model that chose (the slot's model in a replay)
  options_json TEXT NOT NULL,   -- what the agent was offered: [{"id": ..., "name": ...}, ...]
  chosen_id    TEXT,            -- NULL unless outcome = 'chosen'
  chosen_name  TEXT,            -- kept so the record stays readable if the item is later renamed or deleted
  reason       TEXT,            -- the agent's one-sentence explanation, if it gave one
  outcome      TEXT NOT NULL CHECK (outcome IN ('chosen', 'none', 'invalid')),
  created_at   TEXT NOT NULL,
  UNIQUE (scope, scope_id, ref, step_number)
);
CREATE INDEX idx_kbc_lookup ON knowledge_base_choice (scope, scope_id, ref);
CREATE INDEX idx_kbc_user_agent ON knowledge_base_choice (user_id, agent_id, created_at);
