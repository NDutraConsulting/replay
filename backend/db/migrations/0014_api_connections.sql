-- An account can hold several API connections: a label, a URL, a key and the models served there. A model is picked as
-- "<label>::<model>", so the same model name on two APIs stays two choices. The single connection an account had
-- (provider_settings) is copied in as one labelled "Default" when it was complete (URL and key). provider_settings stays in
-- the file but is no longer read. Never edit this file after it has been applied.
CREATE TABLE api_connections (
  connection_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  base_url TEXT NOT NULL,
  api_key TEXT NOT NULL DEFAULT '',        -- Fernet ciphertext
  models_json TEXT NOT NULL DEFAULT '[]',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_api_connections_label ON api_connections(user_id, label COLLATE NOCASE);

INSERT INTO api_connections (connection_id, user_id, label, base_url, api_key, models_json, sort_order, created_at, updated_at)
  SELECT lower(hex(randomblob(16))), user_id, 'Default', base_url, api_key, models_json, 0, updated_at, updated_at
  FROM provider_settings
  WHERE base_url != '' AND api_key != '';
