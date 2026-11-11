-- A replay can ask the model for log probabilities in the response (the Config popup's toggle): one switch for the
-- whole run, like the temperature. Existing runs are off. Never edit this file after it has been applied.
ALTER TABLE replay_runs ADD COLUMN logprobs INTEGER NOT NULL DEFAULT 0 CHECK (logprobs IN (0, 1));
