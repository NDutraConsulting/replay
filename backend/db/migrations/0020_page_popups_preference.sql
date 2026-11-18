-- Whether the popups that appear when a page opens (today: the first-login API setup tour on the Account page) are shown.
-- The switch is in the navigation drawer. On for everyone by default; kept per user like the other preferences.
ALTER TABLE user_preferences ADD COLUMN show_page_popups INTEGER NOT NULL DEFAULT 1 CHECK (show_page_popups IN (0, 1));
