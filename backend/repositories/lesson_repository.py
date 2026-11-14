"""lessons.db: lesson content (seeded from code) and each user's progress. Plain read/write (not append-only)."""

import json
import sqlite3
from datetime import UTC, datetime

from db.connection import run_in_lessons_db
from models.lesson import LessonAvatar, LessonProgress, LessonStep


def _now() -> str:
    return datetime.now(UTC).isoformat()


async def seed(db_path: str, avatars: list[dict], lessons: list[dict]) -> None:
    """Upsert avatars, lessons and steps in one transaction. Steps are replaced as a whole, so editing the seed edits the
    lesson; a lesson's progress rows are kept (they carry the lesson version, so a changed version restarts them)."""

    def _run(conn: sqlite3.Connection) -> None:
        for a in avatars:
            conn.execute(
                "INSERT INTO lesson_avatars (avatar_slug, file, alt, facing) VALUES (:avatar_slug, :file, :alt, :facing) "
                "ON CONFLICT(avatar_slug) DO UPDATE SET file = excluded.file, alt = excluded.alt, facing = excluded.facing",
                a,
            )
        for lesson in lessons:
            conn.execute(
                "INSERT INTO lessons (slug, page, title, summary, sort_order, version, updated_at, sample_json) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(slug) DO UPDATE SET page = excluded.page, title = excluded.title, "
                "summary = excluded.summary, sort_order = excluded.sort_order, version = excluded.version, "
                "updated_at = excluded.updated_at, sample_json = excluded.sample_json",
                (
                    lesson["slug"],
                    lesson["page"],
                    lesson["title"],
                    lesson["summary"],
                    lesson["sort_order"],
                    lesson["version"],
                    _now(),
                    json.dumps(lesson["sample_conversation"]) if lesson.get("sample_conversation") else None,
                ),
            )
            lesson_id = conn.execute("SELECT lesson_id FROM lessons WHERE slug = ?", (lesson["slug"],)).fetchone()[0]
            conn.execute("DELETE FROM lesson_steps WHERE lesson_id = ?", (lesson_id,))
            for s in lesson["steps"]:
                conn.execute(
                    "INSERT INTO lesson_steps (lesson_id, position, title, body, target, action, action_arg, on_next, "
                    "on_target_gone, advance_on, placement, avatar_slug) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (
                        lesson_id,
                        s["position"],
                        s["title"],
                        s["body"],
                        s.get("target"),
                        s.get("action", "none"),
                        s.get("action_arg"),
                        s.get("on_next", "none"),
                        s.get("on_target_gone", "stop"),
                        s.get("advance_on"),
                        s.get("placement", "auto"),
                        s["avatar_slug"],
                    ),
                )

    await run_in_lessons_db(db_path, _run)


async def list_lessons(db_path: str, user_id: str) -> list[dict]:
    """Every lesson with its step count and this user's progress (None when not started or on an older version)."""

    def _run(conn: sqlite3.Connection) -> list[dict]:
        rows = conn.execute(
            "SELECT l.slug, l.page, l.title, l.summary, l.version, l.sample_json, "
            "(SELECT COUNT(*) FROM lesson_steps s WHERE s.lesson_id = l.lesson_id) AS step_count, "
            "p.status, p.current_step, p.lesson_version "
            "FROM lessons l LEFT JOIN lesson_progress p ON p.lesson_id = l.lesson_id AND p.user_id = ? "
            "ORDER BY l.sort_order, l.lesson_id",
            (user_id,),
        ).fetchall()
        return [dict(r) for r in rows]

    return await run_in_lessons_db(db_path, _run)


async def get_lesson(db_path: str, user_id: str, slug: str) -> dict | None:
    def _run(conn: sqlite3.Connection) -> dict | None:
        lesson = conn.execute("SELECT * FROM lessons WHERE slug = ?", (slug,)).fetchone()
        if lesson is None:
            return None
        steps = conn.execute(
            "SELECT s.*, a.file, a.alt, a.facing FROM lesson_steps s JOIN lesson_avatars a USING (avatar_slug) "
            "WHERE s.lesson_id = ? ORDER BY s.position",
            (lesson["lesson_id"],),
        ).fetchall()
        progress = conn.execute(
            "SELECT status, current_step, lesson_version FROM lesson_progress WHERE lesson_id = ? AND user_id = ?",
            (lesson["lesson_id"], user_id),
        ).fetchone()
        return {
            "lesson": dict(lesson),
            "steps": [
                LessonStep(
                    position=s["position"],
                    title=s["title"],
                    body=s["body"],
                    target=s["target"],
                    action=s["action"],
                    action_arg=s["action_arg"],
                    on_next=s["on_next"],
                    on_target_gone=s["on_target_gone"],
                    advance_on=s["advance_on"],
                    placement=s["placement"],
                    avatar=LessonAvatar(avatar_slug=s["avatar_slug"], file=s["file"], alt=s["alt"], facing=s["facing"]),
                )
                for s in steps
            ],
            "progress": dict(progress) if progress else None,
        }

    return await run_in_lessons_db(db_path, _run)


def progress_view(row: dict | None, version: int) -> LessonProgress:
    """A stored row on an older lesson version counts as not started."""
    if row is None or row["lesson_version"] != version:
        return LessonProgress()
    return LessonProgress(status=row["status"], current_step=row["current_step"])


async def put_progress(db_path: str, user_id: str, slug: str, version: int, step: int, status: str) -> bool:
    """Create or update the user's progress. False when the lesson does not exist."""

    def _run(conn: sqlite3.Connection) -> bool:
        row = conn.execute("SELECT lesson_id FROM lessons WHERE slug = ?", (slug,)).fetchone()
        if row is None:
            return False
        now = _now()
        conn.execute(
            "INSERT INTO lesson_progress (user_id, lesson_id, lesson_version, current_step, status, started_at, updated_at, "
            "completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) "
            "ON CONFLICT(user_id, lesson_id) DO UPDATE SET lesson_version = excluded.lesson_version, "
            "current_step = excluded.current_step, status = excluded.status, updated_at = excluded.updated_at, "
            "completed_at = excluded.completed_at, "
            "started_at = CASE WHEN lesson_progress.lesson_version = excluded.lesson_version "
            "THEN lesson_progress.started_at ELSE excluded.started_at END",
            (user_id, row["lesson_id"], version, step, status, now, now, now if status == "completed" else None),
        )
        return True

    return await run_in_lessons_db(db_path, _run)


async def delete_progress(db_path: str, user_id: str, slug: str) -> None:
    def _run(conn: sqlite3.Connection) -> None:
        conn.execute(
            "DELETE FROM lesson_progress WHERE user_id = ? AND lesson_id = (SELECT lesson_id FROM lessons WHERE slug = ?)",
            (user_id, slug),
        )

    await run_in_lessons_db(db_path, _run)
