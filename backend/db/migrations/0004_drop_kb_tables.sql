-- The knowledge base now lives in its own database file (knowledgebase.db, see db/kb_migrations/).
-- db/kb_move.py copies any existing rows there and VERIFIES the copy before this migration can run (startup aborts
-- otherwise), so dropping the old tables here loses nothing.
DROP TABLE IF EXISTS kb_seeded;
DROP TABLE IF EXISTS kb_documents;
DROP TABLE IF EXISTS kb_subcategories;
DROP TABLE IF EXISTS kb_categories;
