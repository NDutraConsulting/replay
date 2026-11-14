-- Replay lesson support: a lesson can carry a sample conversation (seeded into each user's chat history), and a step can wait
-- for an element to appear (advance_on). The step actions grow (check-radio, open-details), and SQLite cannot change a CHECK in
-- place, so lesson_steps is rebuilt (nothing references it).

ALTER TABLE lessons ADD COLUMN sample_json TEXT;

CREATE TABLE lesson_steps_new (
  step_id        INTEGER PRIMARY KEY AUTOINCREMENT,
  lesson_id      INTEGER NOT NULL REFERENCES lessons(lesson_id) ON DELETE CASCADE,
  position       INTEGER NOT NULL,
  title          TEXT NOT NULL,
  body           TEXT NOT NULL,
  target         TEXT,
  action         TEXT NOT NULL DEFAULT 'none' CHECK (action IN ('none','open-menu','open-select','fill','focus','check-radio','open-details')),
  action_arg     TEXT,
  on_next        TEXT NOT NULL DEFAULT 'none' CHECK (on_next IN ('none','click')),
  on_target_gone TEXT NOT NULL DEFAULT 'stop' CHECK (on_target_gone IN ('stop','next')),
  advance_on     TEXT,
  placement      TEXT NOT NULL DEFAULT 'auto' CHECK (placement IN ('auto','top','bottom','left','right')),
  avatar_slug    TEXT NOT NULL REFERENCES lesson_avatars(avatar_slug),
  UNIQUE (lesson_id, position)
);

INSERT INTO lesson_steps_new (step_id, lesson_id, position, title, body, target, action, action_arg, on_next, on_target_gone, placement, avatar_slug)
  SELECT step_id, lesson_id, position, title, body, target, action, action_arg, on_next, on_target_gone, placement, avatar_slug
    FROM lesson_steps;

DROP TABLE lesson_steps;
ALTER TABLE lesson_steps_new RENAME TO lesson_steps;
