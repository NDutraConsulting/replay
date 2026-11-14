"""Log.db deleted or emptied while the server runs (for example by `run.sh --reset-log` in another terminal): the app rebuilds
the schema and carries on, and run.sh refuses to delete database files under a running server."""

import asyncio
import os
import sqlite3
import stat
import subprocess
from pathlib import Path

import pytest

from db.connection import init_db, run_in_log_db
from repositories import api_log_repository, chat_api_log_repository
from tests.test_conversations import connect, new, send
from tests.test_replay import create as create_run
from tests.test_replay import current_chat, play_all, run_of


def delete_log_db(path):
    for suffix in ("", "-wal", "-shm"):
        Path(f"{path}{suffix}").unlink(missing_ok=True)


def names(path, kind):
    with sqlite3.connect(path) as conn:
        return {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type = ?", (kind,))}


@pytest.fixture
def log_db(tmp_path):
    init_db(str(tmp_path / "app.db"), str(tmp_path / "kb.db"), str(tmp_path / "Log.db"))
    return str(tmp_path / "Log.db")


async def test_a_replay_log_write_after_the_file_was_deleted_rebuilds_the_schema(log_db):
    await api_log_repository.record_turn(log_db, "u", "run1", "a", 0, [])
    delete_log_db(log_db)
    await api_log_repository.record_turn(log_db, "u", "run1", "a", 1, [])  # used to raise: no such table: api_calls
    assert sorted(await api_log_repository.turns_for(log_db, "u", "run1", "a")) == [
        1
    ]  # the old file's rows are gone, as deleted


async def test_a_chat_log_write_and_read_after_the_file_was_deleted_work(log_db):
    delete_log_db(log_db)
    await chat_api_log_repository.record_request(log_db, "u", "c1", "req-00000001", "m1", [])
    assert await chat_api_log_repository.for_conversation(log_db, "u", "c1") == {"m1": []}


async def test_a_read_of_an_emptied_file_rebuilds_it_too(log_db):
    delete_log_db(log_db)
    sqlite3.connect(log_db).close()  # what the failed attempt of an older request leaves: an empty file
    assert (
        await api_log_repository.turns_for(log_db, "u", "run1", "a") == {}
    )  # used to raise: no such table: api_log_turns


async def test_the_rebuilt_log_is_append_only_again(log_db):
    delete_log_db(log_db)
    await chat_api_log_repository.record_request(log_db, "u", "c1", "req-00000001", "m1", [])
    assert {"schema_migrations", "chat_api_calls", "chat_api_conversation_requests", "conversation_fork_log"} <= names(
        log_db, "table"
    )
    assert {"chat_api_calls_no_update", "chat_api_calls_no_delete"} <= names(log_db, "trigger")
    with sqlite3.connect(log_db) as conn, pytest.raises(sqlite3.IntegrityError, match="append-only"):
        conn.execute("DELETE FROM chat_api_conversation_requests")


async def test_many_requests_at_once_after_a_deletion_all_succeed(log_db):
    delete_log_db(log_db)
    await asyncio.gather(
        *(chat_api_log_repository.record_request(log_db, "u", "c1", f"req-0000000{i}", f"m{i}", []) for i in range(8))
    )
    assert len(await chat_api_log_repository.for_conversation(log_db, "u", "c1")) == 8


async def test_only_a_missing_table_is_retried_and_only_once(log_db):
    calls = []

    def other_error(conn):
        calls.append(1)
        conn.execute("SELECT * FROM chat_api_calls WHERE")  # a syntax error: not a missing table

    with pytest.raises(sqlite3.OperationalError, match="incomplete input"):
        await run_in_log_db(log_db, other_error)
    assert len(calls) == 1  # not retried

    calls.clear()

    def unknown_table(conn):
        calls.append(1)
        conn.execute("SELECT * FROM a_table_no_migration_creates")

    with pytest.raises(sqlite3.OperationalError, match="no such table"):
        await run_in_log_db(log_db, unknown_table)
    assert len(calls) == 2  # tried, rebuilt, tried once more, then the error is raised as it was


# ---- through the API
def test_a_saved_replays_api_log_after_the_file_was_deleted_answers_not_recorded_instead_of_500(
    logged_in_client, test_settings
):
    current_chat(logged_in_client, "one")
    run = play_all(logged_in_client, run_of(create_run(logged_in_client)))
    delete_log_db(test_settings.LOG_DB_PATH)
    response = logged_in_client.get(f"/api/saved-replays/{run['replay_run_id']}:a/api-log")
    assert response.status_code == 200, response.text  # used to be a 500: no such table: api_log_turns
    assert response.json()["recorded"] is False


def test_a_chat_prompt_sent_after_the_file_was_deleted_is_logged(logged_in_client, test_settings):
    connect(logged_in_client)
    cid = new(logged_in_client, model="m1")
    delete_log_db(test_settings.LOG_DB_PATH)
    assert send(logged_in_client, cid, "hello").status_code == 200
    log = logged_in_client.get(f"/api/conversations/{cid}/api-log").json()
    assert log["recorded"] is True and len(log["turns"][0]["calls"]) == 1  # logged, not silently dropped


# ---- run.sh will not delete database files under a running server
RUN_SH = Path(__file__).parent.parent / "run.sh"


@pytest.mark.skipif(not RUN_SH.exists(), reason="run.sh not found")
@pytest.mark.parametrize("flag", ["--reset", "--reset-app", "--reset-knowledge", "--reset-log"])
def test_run_sh_refuses_a_reset_while_a_server_holds_the_port(tmp_path, flag):
    """A stand-in `lsof` says a server holds the port (it only prints a number, so nothing real can be touched)."""
    fake = tmp_path / "bin"
    fake.mkdir()
    (fake / "lsof").write_text('#!/bin/sh\ncase "$*" in *TCP:8795*) echo 4242; exit 0;; *) exit 1;; esac\n')
    (fake / "lsof").chmod((fake / "lsof").stat().st_mode | stat.S_IEXEC)
    files = {name: tmp_path / name for name in ("app.db", "kb.db", "Log.db")}
    for path in files.values():
        path.write_text("data")
    env = {
        **os.environ,
        "PATH": f"{fake}:{os.environ['PATH']}",
        "PORT": "8795",
        "DATABASE_PATH": str(files["app.db"]),
        "KNOWLEDGE_DB_PATH": str(files["kb.db"]),
        "LOG_DB_PATH": str(files["Log.db"]),
    }
    result = subprocess.run(["bash", str(RUN_SH), flag], env=env, capture_output=True, text=True, timeout=30)
    assert result.returncode == 1
    assert "already running on port 8795" in result.stderr and "NOT deleted" in result.stderr
    assert all(path.read_text() == "data" for path in files.values())  # nothing was deleted
