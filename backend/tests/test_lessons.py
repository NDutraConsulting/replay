"""Guided lessons: lessons.db (migration, seeding, progress) and /api/lessons."""

import asyncio
import re
import sqlite3
from pathlib import Path

import pytest

from db.connection import init_db
from db.lesson_seeds import AVATARS, LESSONS
from db.lesson_seeds.replay_compare_models import SAMPLE_CONVERSATION
from db.migrate import LESSON_MIGRATIONS_DIR
from services import lesson_service

SLUG = "chat-start-conversation"
REPLAY_SLUG = "replay-compare-models"
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
    assert [r["slug"] for r in rows(path, "SELECT slug FROM lessons")] == [SLUG, REPLAY_SLUG]
    assert len(rows(path, "SELECT * FROM lesson_avatars")) == len(AVATARS)
    assert [
        r["position"] for r in rows(path, "SELECT position FROM lesson_steps WHERE lesson_id = 1 ORDER BY position")
    ] == list(range(12))


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


# ---- the lessons point at ids in the frontend: a rename there must fail here, not silently break a lesson
SRC = Path(__file__).parent.parent.parent / "replay-chat-vite" / "src"
FRONTEND_FILES = [
    SRC / "features" / "chat" / "chat-ui.js",
    SRC / "features" / "chat" / "chat-file-menu.js",
    SRC / "features" / "replay" / "replay-ui.js",
    SRC / "features" / "replay" / "replay-file-menu.js",
    SRC / "shared" / "chat-picker-ui.js",
    SRC / "shared" / "modal-ui.js",
    SRC / "shared" / "decision-tree-ui.js",
]
DYNAMIC_IDS = {  # ids the Replay page builds from a template
    "model-a": 'id="model-${slot}"',
    "model-b": 'id="model-${slot}"',
    "tab-replay": 'id="tab-${id}"',
    "tab-history": 'id="tab-${id}"',
    "diff-view-chat": 'id="diff-view-${id}"',
    "diff-view-api": 'id="diff-view-${id}"',
}


def test_every_lesson_target_exists_in_the_frontend_source():
    source = "\n".join(f.read_text() for f in FRONTEND_FILES)
    for lesson in LESSONS:
        for step in lesson["steps"]:
            for selector in (step["target"], step.get("advance_on")):
                if not selector:
                    continue
                for ident in re.findall(r"#([\w-]+)", selector):
                    found = (
                        f'id="{ident}"' in source
                        or f"id: '{ident}'" in source
                        or DYNAMIC_IDS.get(ident, "\0") in source
                    )
                    assert found, f"{lesson['slug']} step {step['position']}: #{ident} is no longer on the page"
                for name in re.findall(r"\.([\w-]+)", selector):
                    assert name in source, f"{lesson['slug']} step {step['position']}: .{name} is no longer on the page"
                if "type=submit" in selector:
                    assert 'type="submit"' in source


# ---- lesson 2: replay, with a sample chat seeded into the user's history
REPLAY = LESSONS[1]


def sample_id(user_id):
    return f"lesson-{REPLAY_SLUG}-{user_id}"


def my_id(client):
    return client.get("/api/me").json()["user_id"]


def test_the_replay_lesson_is_seeded_with_a_page_and_the_flow_in_order():
    assert REPLAY["page"] == "replay" and REPLAY["slug"] == REPLAY_SLUG
    titles = [s["title"] for s in REPLAY["steps"]]
    assert titles[1] == "Open a chat" and titles[16] == "Play all" and titles[22] == "Model Diff"
    assert [s["position"] for s in REPLAY["steps"]] == list(range(24))
    waiting = [s for s in REPLAY["steps"] if s.get("advance_on")]
    assert [s["position"] for s in waiting] == [17]  # it waits for the Replay complete popup, then moves on by itself


def test_the_sample_prompts_are_the_five_lesson_prompts_in_order():
    prompts = [m["content"] for m in SAMPLE_CONVERSATION["messages"] if m["role"] == "user"]
    assert prompts == [
        "List the 10 best books about happiness",
        "What about Yojokun and Nicomachean ethics?",
        "What about the Tao te ching",
        "How do the tao te ching, Yojokun, and Nicomachean ethics overlap?",
        "How do the tao te ching, Yojokun, and Nicomachean ethics overlap with Shakespear",
    ]
    roles = [m["role"] for m in SAMPLE_CONVERSATION["messages"]]
    assert roles == ["user", "assistant"] * 5


def test_opening_the_lesson_seeds_the_sample_chat_into_the_chat_history(logged_in_client):
    logged_in_client.get(f"/api/lessons/{REPLAY_SLUG}")
    chats = logged_in_client.get("/api/conversations").json()
    sample = next(c for c in chats if c["conversation_id"] == sample_id(my_id(logged_in_client)))
    assert sample["name"] == "Lesson: Happiness books" and sample["prompt_count"] == 5
    assert sample["temperature"] == 0 and sample["brief_replies"] is True and sample["locked"] is False
    full = logged_in_client.get(f"/api/conversations/{sample['conversation_id']}").json()
    assert [m["role"] for m in full["messages"]] == ["user", "assistant"] * 5
    assert all(m["demo"] for m in full["messages"] if m["role"] == "assistant")  # canned text, labelled as such


def test_listing_the_lessons_seeds_it_too_and_never_twice(logged_in_client):
    logged_in_client.get("/api/lessons")
    logged_in_client.get("/api/lessons")
    logged_in_client.get(f"/api/lessons/{REPLAY_SLUG}")
    names = [c["name"] for c in logged_in_client.get("/api/conversations").json()]
    assert names.count("Lesson: Happiness books") == 1


def test_the_sample_chat_never_becomes_the_current_chat(logged_in_client):
    mine = logged_in_client.get("/api/conversations/current").json()["conversation_id"]
    logged_in_client.get("/api/lessons")  # seeds the sample chat after the user's own chat exists
    assert logged_in_client.get("/api/conversations/current").json()["conversation_id"] == mine


def test_the_sample_chat_is_the_users_own_and_in_their_model(logged_in_client, other_client):
    logged_in_client.get("/api/lessons")
    other_client.get("/api/lessons")
    mine = {c["conversation_id"] for c in logged_in_client.get("/api/conversations").json()}
    theirs = {c["conversation_id"] for c in other_client.get("/api/conversations").json()}
    assert sample_id(my_id(logged_in_client)) in mine and sample_id(my_id(other_client)) in theirs
    assert not mine & theirs
    assert logged_in_client.get(f"/api/conversations/{sample_id(my_id(other_client))}").status_code == 404


def test_a_deleted_sample_chat_comes_back_the_next_time_the_lesson_opens(logged_in_client):
    logged_in_client.get(f"/api/lessons/{REPLAY_SLUG}")
    cid = sample_id(my_id(logged_in_client))
    assert logged_in_client.delete(f"/api/conversations/{cid}").status_code in (200, 204)
    logged_in_client.get(f"/api/lessons/{REPLAY_SLUG}")
    assert cid in {c["conversation_id"] for c in logged_in_client.get("/api/conversations").json()}


def test_the_api_returns_the_wait_and_the_new_actions(logged_in_client):
    steps = logged_in_client.get(f"/api/lessons/{REPLAY_SLUG}").json()["steps"]
    assert steps[17]["advance_on"] == "#play-all-popup .play-check"
    assert steps[2]["action"] == "check-radio" and steps[22]["action"] == "open-details"
    assert steps[1]["advance_on"] is None


def test_migration_0002_keeps_the_steps_of_an_older_lessons_db(tmp_path):
    import sqlite3 as sq

    from db.migrate import apply_migrations

    path = str(tmp_path / "old.db")
    only_first = tmp_path / "m"
    only_first.mkdir()
    (only_first / "0001_lessons.sql").write_text((LESSON_MIGRATIONS_DIR / "0001_lessons.sql").read_text())
    apply_migrations(path, only_first)
    conn = sq.connect(path)
    conn.execute("INSERT INTO lesson_avatars VALUES ('a', 'a.webp', 'A', 'front')")
    conn.execute("INSERT INTO lessons (slug, page, title, summary, updated_at) VALUES ('s', 'chat', 't', 's', 'now')")
    conn.execute(
        "INSERT INTO lesson_steps (lesson_id, position, title, body, avatar_slug) VALUES (1, 0, 'T', 'B', 'a')"
    )
    conn.commit()
    conn.close()
    apply_migrations(path, LESSON_MIGRATIONS_DIR)  # the real folder: applies 0002 on top
    assert rows(path, "SELECT title, advance_on FROM lesson_steps") == [{"title": "T", "advance_on": None}]
    assert "sample_json" in rows(path, "SELECT * FROM lessons")[0]


def test_replay_lesson_open_step_is_clicked_by_next_and_waits_for_the_popup_to_close():
    open_step = REPLAY["steps"][12]
    assert open_step["title"] == "Open the replay"
    assert open_step["on_next"] == "click" and open_step["on_target_gone"] == "next"


def _step_by_title(lesson, title):
    return next(s for s in lesson["steps"] if s["title"].startswith(title))


def test_both_lessons_tell_the_user_to_use_gpt_5_5_with_reasoning_none_so_temperature_can_be_zero():
    chat = LESSONS[0]
    assert "OpenAI" in _step_by_title(chat, "Pick an API provider")["body"]
    assert "gpt-5.5" in _step_by_title(chat, "Pick a model")["body"]
    assert "**None**" in _step_by_title(chat, "Pick a reasoning level")["body"]
    assert (
        "None" in _step_by_title(chat, "Temperature")["body"] and "**0**" in _step_by_title(chat, "Temperature")["body"]
    )
    assert "gpt-5.5" in _step_by_title(REPLAY, "Model A")["body"]
    assert "gpt-5.4" in _step_by_title(REPLAY, "Model B")["body"]  # a different model, so there is something to compare
    assert "**None**" in _step_by_title(REPLAY, "Reasoning level")["body"]
    assert (
        "None" in _step_by_title(REPLAY, "Temperature")["body"]
        and "**0**" in _step_by_title(REPLAY, "Temperature")["body"]
    )


def test_the_chat_diff_step_highlights_the_line_by_line_comparison_with_the_card_on_the_b_side():
    step = _step_by_title(REPLAY, "Chat diff")
    assert step["target"] == ".diff-turn .diff-lines"  # the line-by-line comparison of A and B
    assert step["placement"] == "top-end"  # the card's right end lines up with the diff's: the B side (right column)
