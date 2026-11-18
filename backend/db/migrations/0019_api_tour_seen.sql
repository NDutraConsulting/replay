-- Whether the user has finished (or skipped) the first-login API setup tour on the Account page, kept per user like the
-- other preferences. New accounts start at 0 and are shown the tour; every account that already exists is marked as seen.
ALTER TABLE user_preferences ADD COLUMN api_tour_seen INTEGER NOT NULL DEFAULT 0 CHECK (api_tour_seen IN (0, 1));
INSERT OR IGNORE INTO user_preferences (user_id, updated_at) SELECT user_id, datetime('now') FROM users;
UPDATE user_preferences SET api_tour_seen = 1;
