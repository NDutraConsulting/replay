-- lessons.db: guided lessons (content) and each user's progress. Content is seeded from db/lesson_seeds on every start
-- (upsert by slug / position); progress is read/write. user_id points at app.db users (a different file, so no foreign key).

CREATE TABLE lessons (
  lesson_id   INTEGER PRIMARY KEY AUTOINCREMENT,
  slug        TEXT NOT NULL UNIQUE,
  page        TEXT NOT NULL,
  title       TEXT NOT NULL,
  summary     TEXT NOT NULL,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  version     INTEGER NOT NULL DEFAULT 1,
  updated_at  TEXT NOT NULL
);

CREATE TABLE lesson_avatars (
  avatar_slug TEXT PRIMARY KEY,
  file        TEXT NOT NULL,
  alt         TEXT NOT NULL,
  facing      TEXT NOT NULL CHECK (facing IN ('front','left','right','up','down','up-left','up-right','down-left','down-right'))
);

CREATE TABLE lesson_steps (
  step_id        INTEGER PRIMARY KEY AUTOINCREMENT,
  lesson_id      INTEGER NOT NULL REFERENCES lessons(lesson_id) ON DELETE CASCADE,
  position       INTEGER NOT NULL,
  title          TEXT NOT NULL,
  body           TEXT NOT NULL,
  target         TEXT,
  action         TEXT NOT NULL DEFAULT 'none' CHECK (action IN ('none','open-menu','open-select','fill','focus')),
  action_arg     TEXT,
  on_next        TEXT NOT NULL DEFAULT 'none' CHECK (on_next IN ('none','click')),
  on_target_gone TEXT NOT NULL DEFAULT 'stop' CHECK (on_target_gone IN ('stop','next')),
  placement      TEXT NOT NULL DEFAULT 'auto' CHECK (placement IN ('auto','top','bottom','left','right')),
  avatar_slug    TEXT NOT NULL REFERENCES lesson_avatars(avatar_slug),
  UNIQUE (lesson_id, position)
);

CREATE TABLE lesson_progress (
  user_id        TEXT NOT NULL,
  lesson_id      INTEGER NOT NULL REFERENCES lessons(lesson_id) ON DELETE CASCADE,
  lesson_version INTEGER NOT NULL,
  current_step   INTEGER NOT NULL DEFAULT 0,
  status         TEXT NOT NULL CHECK (status IN ('in_progress','completed','skipped')),
  started_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  completed_at   TEXT,
  PRIMARY KEY (user_id, lesson_id)
);
