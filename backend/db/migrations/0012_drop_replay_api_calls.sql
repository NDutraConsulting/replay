-- The raw API log moved to its own database (Log.db), so the column added by 0011 is not used. Dropped here (0011 stays,
-- because it may already be applied). Calls kept in it were only a few minutes old at most and are not carried over.
-- Never edit this file after it has been applied.
ALTER TABLE replay_results DROP COLUMN api_calls_json;
