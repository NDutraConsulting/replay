-- The token log probabilities of a response, kept compactly ([{token, logprob}]) when the call asked for them, so the Diff
-- page can mark where the probability drops without reading the whole raw response (which the log cuts when it is long).
-- NULL when the call did not ask for them. Never edit this file after it has been applied.
ALTER TABLE api_calls ADD COLUMN logprobs_json TEXT;
