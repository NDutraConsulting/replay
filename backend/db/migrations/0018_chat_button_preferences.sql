-- Which optional buttons the Chat page shows (the Config popup's two switches), kept per user like the other preferences.
-- Compact is off by default; the Rewind button (which enters rewind mode) is on by default.
ALTER TABLE user_preferences ADD COLUMN show_compact_button INTEGER NOT NULL DEFAULT 0 CHECK (show_compact_button IN (0, 1));
ALTER TABLE user_preferences ADD COLUMN show_rewind_button INTEGER NOT NULL DEFAULT 1 CHECK (show_rewind_button IN (0, 1));
