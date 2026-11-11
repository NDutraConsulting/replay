-- A temperature setting (0 to 2), fixed per conversation like the reasoning level, and carried by each replay run.
-- Existing rows get 0. Never edit this file after it has been applied.
ALTER TABLE conversations ADD COLUMN temperature REAL NOT NULL DEFAULT 0;
ALTER TABLE replay_runs ADD COLUMN temperature REAL NOT NULL DEFAULT 0;
