-- The raw REST calls made to the model provider while a replay result was produced (URL, request, response), kept as JSON
-- so the Replay page can show them. NULL for results saved before this existed. The API key is never stored.
-- Never edit this file after it has been applied.
ALTER TABLE replay_results ADD COLUMN api_calls_json TEXT;
