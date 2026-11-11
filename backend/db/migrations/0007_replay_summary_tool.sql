-- Phase 8: a replay run has its own KB-summary-tool switch (one for the whole run, both slots), a reasoning level, and
-- optionally the summary a summary-first conversation starts from. Never edit this file after it has been applied.
ALTER TABLE replay_runs ADD COLUMN kb_summary_tool INTEGER NOT NULL DEFAULT 0 CHECK (kb_summary_tool IN (0, 1));
ALTER TABLE replay_runs ADD COLUMN reasoning_level TEXT NOT NULL DEFAULT 'default'
  CHECK (reasoning_level IN ('default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh'));
ALTER TABLE replay_runs ADD COLUMN context_summary TEXT;   -- the compacted summary the replayed conversation began with

-- The summary a slot's model wrote for the file it was routed to (only when the switch was on).
ALTER TABLE replay_results ADD COLUMN kb_summary TEXT;
