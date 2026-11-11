-- Phase 8: every text a file has held is kept once, as a numbered version, so a record of what a model was shown can
-- point at the text (version_id) instead of copying it. Never edit this file after it has been applied.
--
-- A version is created when a file is created, and again each time its text really changes (content_hash differs).
-- Deleting a file deletes its versions (ON DELETE CASCADE): records that pointed at them stay readable by name and
-- are flagged as "version deleted". Existing files get their version 1 from db/kb_versions.py (it needs sha256).
CREATE TABLE kb_document_versions (
  version_id     TEXT PRIMARY KEY,
  document_id    TEXT NOT NULL REFERENCES kb_documents(document_id) ON DELETE CASCADE,
  version_number INTEGER NOT NULL,
  content_hash   TEXT NOT NULL,
  content        TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  UNIQUE (document_id, version_number)
);

-- Which version of the file's text the model was shown (NULL on records made before this migration, and on the
-- category and sub category steps).
ALTER TABLE knowledge_base_choice ADD COLUMN document_version_id TEXT;
CREATE INDEX idx_kbc_version ON knowledge_base_choice (document_version_id);
