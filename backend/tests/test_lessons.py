"""Guided lessons: lessons.db (migration, seeding, progress) and /api/lessons."""

import asyncio
import re
import sqlite3
from pathlib import Path

import pytest

from db.connection import init_db
from db.lesson_seeds import AVATARS, LESSONS
from db.migrate import LESSON_MIGRATIONS_DIR
from services import lesson_service

SLUG = "chat-start-conversation"
AVATAR_DIR = Path(__file__).parent.parent.parent / "replay-chat-vite" / "public" / "lessons" / "avatars"


def rows(path, sql, *args):
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    try:
        return [dict(r) for r in conn.execute(sql, args).fetchall()]
    finally:
        conn.close()


# ---- database and seed
def test_the_migration_creates_the_tables_and_is_applied_once(tmp_path):
    path = str(tmp_path / "lessons.db")
    init_db(str(tmp_path / "a.db"), str(tmp_path / "k.db"), None, path)
    names = {r["name"] for r in rows(path, "SELECT name FROM sqlite_master WHERE type = 'table'")}
    assert {"lessons", "lesson_steps", "lesson_avatars", "lesson_progress", "schema_migrations"} <= names
    init_db(str(tmp_path / "a.db"), str(tmp_path / "k.db"), None, path)  # a second start applies nothing new
    assert len(rows(path, "SELECT * FROM schema_migrations")) == len(list(LESSON_MIGRATIONS_DIR.glob("*.sql")))


def test_seeding_is_idempotent_and_fills_the_chat_lesson(db, test_settings):
    path = test_settings.LESSONS_DB_PATH
    asyncio.run(lesson_service.seed(test_settings))
    asyncio.run(lesson_service.seed(test_settings))
    assert [r["slug"] for r in rows(path, "SELECT slug FROM lessons")] == [SLUG]
    assert len(rows(path, "SELECT * FROM lesson_avatars")) == len(AVATARS)
    assert [r["position"] for r in rows(path, "SELECT position FROM lesson_steps ORDER BY position")] == list(range(12))


def test_seeding_updates_changed_copy(db, test_settings, monkeypatch):
    changed = [{**LESSONS[0], "title": "Changed title"}]
    monkeypatch.setattr("services.lesson_service.LESSONS", changed)
    asyncio.run(lesson_service.seed(test_settings))
    assert rows(test_settings.LESSONS_DB_PATH, "SELECT title FROM lessons")[0]["title"] == "Changed title"


def test_the_seed_is_consistent():
    slugs = {a["avatar_slug"] for a in AVATARS}
    assert len(slugs) == len(AVATARS)
    for lesson in LESSONS:
        positions = [s["position"] for s in lesson["steps"]]
        assert positions == list(range(len(positions)))  # contiguous from 0
        assert all(s["avatar_slug"] in slugs for s in lesson["steps"])
        assert re.fullmatch(r"[a-z0-9-]+", lesson["slug"])


def test_every_avatar_file_exists_and_is_small():
    for a in AVATARS:
        f = AVATAR_DIR / a["file"]
        assert f.exists(), f"{f} is missing: run replay-chat-vite/scripts/make-lesson-avatars.sh"
        assert f.stat().st_size < 150_000


def test_the_lesson_covers_the_ten_requested_steps_in_order():
    targets = [s["target"] for s in LESSONS[0]["steps"]]
    assert targets[1:11] == [
        "#file-new",
        "#new-chat-name",
        "#new-chat-agent",
        "#new-chat-provider",
        "#new-chat-model",
        "#new-chat-reasoning",
        "#new-chat-temperature",
        "#new-chat-kbsummary",
        "#new-chat-brief",
        ".modal-actions button[type=submit]",
    ]
    assert [s["action"] for s in LESSONS[0]["steps"][3:7]] == ["open-select"] * 4


# ---- API
def test_lessons_need_a_login(client):
    assert client.get("/api/lessons").status_code == 401
    assert client.get(f"/api/lessons/{SLUG}").status_code == 401
    assert client.put(f"/api/lessons/{SLUG}/progress", json={"step": 1}).status_code == 401


def test_the_list_reports_not_started(logged_in_client):
    body = logged_in_client.get("/api/lessons").json()
    assert body[0]["slug"] == SLUG and body[0]["step_count"] == 12
    assert body[0]["progress"] == {"status": "not_started", "current_step": 0}


def test_a_lesson_comes_with_its_steps_and_avatars(logged_in_client):
    body = logged_in_client.get(f"/api/lessons/{SLUG}").json()
    assert [s["position"] for s in body["steps"]] == list(range(12))
    first = body["steps"][0]
    assert first["avatar"]["file"] == "guide.webp" and first["avatar"]["alt"]
    assert body["steps"][4]["target"] == "#new-chat-provider"


def test_an_unknown_lesson_is_404(logged_in_client):
    assert logged_in_client.get("/api/lessons/nope").status_code == 404
    assert logged_in_client.put("/api/lessons/nope/progress", json={"step": 0}).status_code == 404


def test_progress_is_saved_and_listed(logged_in_client):
    r = logged_in_client.put(f"/api/lessons/{SLUG}/progress", json={"step": 4})
    assert r.json() == {"status": "in_progress", "current_step": 4}
    assert logged_in_client.get(f"/api/lessons/{SLUG}").json()["progress"] == {
        "status": "in_progress",
        "current_step": 4,
    }
    assert logged_in_client.get("/api/lessons").json()[0]["progress"]["current_step"] == 4


@pytest.mark.parametrize("body", [{"step": -1}, {"step": 12}, {"step": 1, "status": "nope"}, {"status": "completed"}])
def test_progress_is_validated(logged_in_client, body):
    assert logged_in_client.put(f"/api/lessons/{SLUG}/progress", json=body).status_code == 422


def test_completed_is_sticky_until_restart(logged_in_client):
    put = lambda body: logged_in_client.put(f"/api/lessons/{SLUG}/progress", json=body).json()  # noqa: E731
    assert put({"step": 11, "status": "completed"})["status"] == "completed"
    assert put({"step": 3})["status"] == "completed"  # a late save from a skipped replay of the lesson does not undo it
    assert logged_in_client.post(f"/api/lessons/{SLUG}/restart").json() == {"status": "not_started", "current_step": 0}
    assert put({"step": 3})["status"] == "in_progress"


def test_skipping_is_recorded(logged_in_client):
    logged_in_client.put(f"/api/lessons/{SLUG}/progress", json={"step": 2, "status": "skipped"})
    assert logged_in_client.get("/api/lessons").json()[0]["progress"] == {"status": "skipped", "current_step": 2}


def test_progress_is_per_user(logged_in_client, other_client):
    logged_in_client.put(f"/api/lessons/{SLUG}/progress", json={"step": 5})
    assert other_client.get("/api/lessons").json()[0]["progress"]["status"] == "not_started"


def test_a_new_lesson_version_restarts_progress(logged_in_client, test_settings, monkeypatch):
    logged_in_client.put(f"/api/lessons/{SLUG}/progress", json={"step": 5})
    bumped = [{**LESSONS[0], "version": 2}]
    monkeypatch.setattr("services.lesson_service.LESSONS", bumped)
    asyncio.run(lesson_service.seed(test_settings))
    assert logged_in_client.get(f"/api/lessons/{SLUG}").json()["progress"] == {
        "status": "not_started",
        "current_step": 0,
    }


def test_a_deleted_lessons_db_heals_and_is_reseeded(logged_in_client, test_settings):
    for suffix in ("", "-wal", "-shm"):
        Path(f"{test_settings.LESSONS_DB_PATH}{suffix}").unlink(missing_ok=True)
    assert logged_in_client.get("/api/lessons").json()[0]["slug"] == SLUG
    assert logged_in_client.get(f"/api/lessons/{SLUG}").status_code == 200
    assert logged_in_client.put(f"/api/lessons/{SLUG}/progress", json={"step": 1}).status_code == 200


# ---- the lesson points at ids in the frontend: a rename there must fail here, not silently break the lesson
FRONTEND = Path(__file__).parent.parent.parent / "replay-chat-vite" / "src" / "features" / "chat"


def test_every_lesson_target_exists_in_the_frontend_source():
    source = (FRONTEND / "chat-ui.js").read_text() + (FRONTEND / "chat-file-menu.js").read_text()
    for step in LESSONS[0]["steps"]:
        target = step["target"]
        if target is None:
            continue
        if target.startswith("#"):
            ident = target[1:]
            assert f'id="{ident}"' in source or f"id: '{ident}'" in source, f"{target} is no longer in the Chat page"
        else:
            assert 'class="modal-actions"' in (FRONTEND.parent.parent / "shared" / "modal-ui.js").read_text()
            assert "type=submit" in target
