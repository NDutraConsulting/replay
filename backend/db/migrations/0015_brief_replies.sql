-- A conversation can append "Respond in 100 words or less." to the end of each request it sends (the "Brief replies"
-- switch in the New conversation popup), fixed for the life of the conversation like the other settings. A replay run
-- carries the same switch so the models it compares are asked the same thing. Existing rows are off.
-- Never edit this file after it has been applied.
ALTER TABLE conversations ADD COLUMN brief_replies INTEGER NOT NULL DEFAULT 0 CHECK (brief_replies IN (0, 1));
ALTER TABLE replay_runs ADD COLUMN brief_replies INTEGER NOT NULL DEFAULT 0 CHECK (brief_replies IN (0, 1));
