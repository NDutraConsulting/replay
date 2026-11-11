-- Idempotent: runs at every startup. Editing a prompt here updates the existing row.
INSERT INTO agents (agent_id, name, system_prompt, sort_order) VALUES
  ('assistant', 'General assistant', 'You are a helpful assistant. Be clear, practical, and concise.', 1),
  ('code', 'Code assistant', 'You are a software engineering assistant. Provide precise, reviewable implementations and explain important tradeoffs.', 2),
  ('research', 'IT Security Assistant', 'You are a careful research assistant. Distinguish evidence from assumptions, indicate uncertainty, and never invent sources.', 3)
ON CONFLICT(agent_id) DO UPDATE SET
  name = excluded.name,
  system_prompt = excluded.system_prompt,
  sort_order = excluded.sort_order;
