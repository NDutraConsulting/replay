"""The raw API log lives in its own database file, Log.db."""

import sqlite3

import pytest

from db.connection import init_db
from repositories import api_log_repository
from tests.test_replay import connect, create, current_chat, play_all, run_of


def call(purpose="answer", status=200, **extra):
    return {
        "at": "2026-01-01T00:00:00+00:00", "purpose": purpose, "method": "POST",
        "url": "https://api.example.com/v1/chat/completions", "duration_ms": 25,
        "request": {"headers": {"Authorization": "Bearer <redacted>"}, "body": {"model": "m1", "messages": []}},
        "response": {"status": status, "body": '{"ok":true}', "truncated": False}, "error": None, **extra,
    }  # fmt: skip


def tables(path):
    with sqlite3.connect(path) as conn:
        return {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}


def columns(path, table):
    with sqlite3.connect(path) as conn:
        return {r[1] for r in conn.execute(f"PRAGMA table_info({table})")}


def test_init_creates_log_db_with_its_own_migrations(tmp_path):
    app, kb, log = (str(tmp_path / n) for n in ("app.db", "kb.db", "Log.db"))
    init_db(app, kb, log)
    assert {
        "api_calls",
        "api_log_turns",
        "chat_api_calls",
        "chat_api_conversation_requests",
        "conversation_fork_log",
        "schema_migrations",
    } <= tables(log)
    assert "chat_api_requests" not in tables(log)  # the old chat log table was discarded by migration 0005
    assert "api_calls" not in tables(app) and "api_calls" not in tables(kb)  # not in the other files
    assert init_db(app, kb, log) == []  # a second start applies nothing new
    with sqlite3.connect(log) as conn:
        assert [r[0] for r in conn.execute("SELECT version FROM schema_migrations")] == [1, 2, 3, 4, 5]


def test_the_log_is_not_stored_in_app_db(db, test_settings):
    assert "api_calls_json" not in columns(test_settings.DATABASE_PATH, "replay_results")
    assert "api_calls" in tables(test_settings.LOG_DB_PATH)


async def test_record_and_read_back_in_call_order(db, test_settings):
    path = test_settings.LOG_DB_PATH
    await api_log_repository.record_turn(path, "u1", "run1", "a", 0, [call("kb_route:category"), call("answer")])
    await api_log_repository.record_turn(path, "u1", "run1", "a", 1, [])
    log = await api_log_repository.turns_for(path, "u1", "run1", "a")
    assert sorted(log) == [0, 1]
    assert [c["purpose"] for c in log[0]] == ["kb_route:category", "answer"]
    assert log[1] == []  # logged, no calls (demo mode)
    first = log[0][0]
    assert first["request"]["headers"] == {"Authorization": "Bearer <redacted>"} and first["response"]["status"] == 200
    assert first["method"] == "POST" and first["duration_ms"] == 25


async def test_a_call_without_a_response_keeps_its_error(db, test_settings):
    path = test_settings.LOG_DB_PATH
    await api_log_repository.record_turn(path, "u1", "run1", "a", 0, [call(response=None, error="timed out")])
    only = (await api_log_repository.turns_for(path, "u1", "run1", "a"))[0][0]
    assert only["response"] is None and only["error"] == "timed out"


async def test_logging_a_turn_again_replaces_it(db, test_settings):
    path = test_settings.LOG_DB_PATH
    await api_log_repository.record_turn(path, "u1", "run1", "a", 0, [call(), call()])
    await api_log_repository.record_turn(path, "u1", "run1", "a", 0, [call("kb_summary")])
    assert [c["purpose"] for c in (await api_log_repository.turns_for(path, "u1", "run1", "a"))[0]] == ["kb_summary"]


async def test_slots_users_and_runs_stay_apart_and_delete_follows_the_run(db, test_settings):
    path = test_settings.LOG_DB_PATH
    await api_log_repository.record_turn(path, "u1", "run1", "a", 0, [call()])
    await api_log_repository.record_turn(path, "u1", "run1", "b", 0, [call(), call()])
    await api_log_repository.record_turn(path, "u1", "run2", "a", 0, [call()])
    assert len((await api_log_repository.turns_for(path, "u1", "run1", "b"))[0]) == 2
    assert len((await api_log_repository.turns_for(path, "u1", "run1", "a"))[0]) == 1
    assert await api_log_repository.turns_for(path, "someone-else", "run1", "a") == {}  # another user sees nothing
    await api_log_repository.delete_runs(path, "someone-else", ["run1"])  # not theirs: nothing deleted
    assert await api_log_repository.turns_for(path, "u1", "run1", "a") != {}
    await api_log_repository.delete_runs(path, "u1", ["run1"])
    assert await api_log_repository.turns_for(path, "u1", "run1", "a") == {}
    assert await api_log_repository.turns_for(path, "u1", "run1", "b") == {}
    assert await api_log_repository.turns_for(path, "u1", "run2", "a") != {}
    await api_log_repository.delete_runs(path, "u1", [])  # nothing to do


def test_a_played_replay_writes_its_calls_to_log_db_only(logged_in_client, test_settings, llm_stub):
    connect(logged_in_client)
    cid = logged_in_client.post(
        "/api/conversations", json={"name": "L", "agent_id": "assistant", "model": "m1"}
    ).json()["conversation_id"]
    logged_in_client.post(f"/api/conversations/{cid}/messages", json={"content": "hello"})
    run = run_of(create(logged_in_client, conversation_id=cid))
    play_all(logged_in_client, run)
    with sqlite3.connect(test_settings.LOG_DB_PATH) as conn:
        rows = conn.execute(
            "SELECT slot, turn_index, purpose, url FROM api_calls WHERE replay_run_id = ? ORDER BY slot, seq",
            (run["replay_run_id"],),
        ).fetchall()
        marked = conn.execute(
            "SELECT COUNT(*) FROM api_log_turns WHERE replay_run_id = ?", (run["replay_run_id"],)
        ).fetchone()[0]
    assert [(r[0], r[1], r[2]) for r in rows] == [("a", 0, "answer"), ("b", 0, "answer")]
    assert all(r[3] == "https://api.example.com/v1/chat/completions" for r in rows)
    assert marked == 2
    body = logged_in_client.get(f"/api/saved-replays/{run['replay_run_id']}:a/api-log").json()
    assert body["recorded"] is True and len(body["turns"][0]["calls"]) == 1


def test_demo_replays_mark_their_turns_as_logged_with_no_calls(logged_in_client, test_settings):
    cid = current_chat(logged_in_client, "hello")
    run = run_of(create(logged_in_client, conversation_id=cid))
    play_all(logged_in_client, run)
    with sqlite3.connect(test_settings.LOG_DB_PATH) as conn:
        assert conn.execute("SELECT COUNT(*) FROM api_calls").fetchone()[0] == 0
        assert conn.execute("SELECT COUNT(*) FROM api_log_turns").fetchone()[0] == 2


def test_a_failing_log_write_does_not_fail_the_step(logged_in_client, monkeypatch):
    async def broken(*args, **kwargs):
        raise sqlite3.OperationalError("disk full")

    monkeypatch.setattr(api_log_repository, "record_turn", broken)
    cid = current_chat(logged_in_client, "hello")
    run = run_of(create(logged_in_client, conversation_id=cid))
    done = play_all(logged_in_client, run)
    assert done["cursor"] == 1  # the replay result is saved
    log = logged_in_client.get(f"/api/saved-replays/{run['replay_run_id']}:a/api-log").json()
    assert log["recorded"] is False  # nothing was logged, and the page says so


def test_a_missing_log_db_file_is_created_at_startup(tmp_path):
    log = tmp_path / "does-not-exist-yet.db"
    assert not log.exists()
    init_db(str(tmp_path / "a.db"), str(tmp_path / "k.db"), str(log))
    assert log.exists()


@pytest.mark.parametrize("suffix", ["", "-wal", "-shm"])
def test_reset_script_removes_log_db_files(tmp_path, monkeypatch, suffix):
    import importlib.util
    from pathlib import Path

    spec = importlib.util.spec_from_file_location("reset_db", Path(__file__).parent.parent / "scripts" / "reset_db.py")
    reset = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(reset)
    monkeypatch.setattr(reset.settings, "LOG_DB_PATH", str(tmp_path / "Log.db"))
    monkeypatch.setattr(reset.settings, "DATABASE_PATH", str(tmp_path / "app.db"))
    monkeypatch.setattr(reset.settings, "KNOWLEDGE_DB_PATH", str(tmp_path / "kb.db"))
    for name in ("Log.db", "app.db", "kb.db"):
        (tmp_path / f"{name}{suffix}").write_text("x")
    assert reset.main(["--yes", "--only=log"]) == 0
    assert not (tmp_path / f"Log.db{suffix}").exists()
    assert (tmp_path / f"app.db{suffix}").exists() and (tmp_path / f"kb.db{suffix}").exists()
    assert reset.main(["--yes"]) == 0
    assert not (tmp_path / f"app.db{suffix}").exists()


async def test_the_settings_of_a_call_are_kept_with_it(db, test_settings):
    path = test_settings.LOG_DB_PATH
    settings = {"temperature": 0, "temperature_sent": False, "temperature_note": "refused", "reasoning_effort": None}
    await api_log_repository.record_turn(path, "u1", "run1", "a", 0, [call(settings=settings), call()])
    first, second = (await api_log_repository.turns_for(path, "u1", "run1", "a"))[0]
    assert first["settings"] == settings
    assert second["settings"] is None  # a call logged without settings (or before they were kept)


def test_the_api_log_names_the_replays_temperature_and_reasoning_and_each_calls_settings(logged_in_client, llm_stub):
    connect(logged_in_client)
    cid = logged_in_client.post(
        "/api/conversations",
        json={"name": "S", "agent_id": "assistant", "model": "m1", "temperature": 0.6, "reasoning_level": "high"},
    ).json()["conversation_id"]
    logged_in_client.post(f"/api/conversations/{cid}/messages", json={"content": "hello"})
    run = run_of(create(logged_in_client, conversation_id=cid, reasoning_level="high"))
    play_all(logged_in_client, run)
    body = logged_in_client.get(f"/api/saved-replays/{run['replay_run_id']}:a/api-log").json()
    assert body["temperature"] == 0.6 and body["reasoning_level"] == "high"
    settings = body["turns"][0]["calls"][0]["settings"]
    assert (
        settings["temperature"] == 0.6
        and settings["temperature_sent"] is True
        and settings["reasoning_effort"] == "high"
    )


async def test_answer_tokens_are_kept_and_read_back_per_turn(db, test_settings):
    path = test_settings.LOG_DB_PATH
    tokens = [{"token": "Hi", "logprob": -0.1}, {"token": " there", "logprob": -2.9}]
    await api_log_repository.record_turn(
        path,
        "u1",
        "run1",
        "a",
        0,
        [call("kb_route:file", logprobs=[{"token": "x", "logprob": -1}]), call(logprobs=tokens)],
    )
    await api_log_repository.record_turn(path, "u1", "run1", "a", 1, [call()])  # an answer with no tokens
    await api_log_repository.record_turn(path, "u1", "run1", "a", 2, [])  # a demo turn
    got = await api_log_repository.answer_logprobs(path, "u1", "run1", "a")
    assert got == {0: tokens, 1: None, 2: None}  # routing tokens are not the answer's
    assert await api_log_repository.answer_logprobs(path, "someone-else", "run1", "a") == {}
    assert await api_log_repository.answer_logprobs(path, "u1", "run1", "b") == {}


async def test_the_last_answer_call_of_a_turn_supplies_the_tokens(db, test_settings):
    path = test_settings.LOG_DB_PATH
    first, last = [{"token": "a", "logprob": -1}], [{"token": "b", "logprob": -2}]
    await api_log_repository.record_turn(path, "u1", "run1", "a", 0, [call(logprobs=first), call(logprobs=last)])
    assert (await api_log_repository.answer_logprobs(path, "u1", "run1", "a"))[0] == last
