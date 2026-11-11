-- What the user had set for each call (temperature asked for and whether it was sent, reasoning effort), as JSON, so the
-- API log can say it next to the request. NULL for calls logged before this existed.
-- Never edit this file after it has been applied.
ALTER TABLE api_calls ADD COLUMN settings_json TEXT;
