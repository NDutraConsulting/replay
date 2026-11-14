"""Locking a conversation, forking it (a copy with a new conversation id), and the replay auto-lock."""

import asyncio
import shutil
import sqlite3

import pytest

from db.migrate import MIGRATIONS_DIR, apply_migrations
from repositories import chat_api_log_repository, kb_choice_repository, message_repository
from tests.test_conversations import connect, current, new, send
from tests.test_replay import create, current_chat, play_all, run_of, step


def lock(client, conversation_id):
    return client.post(f"/api/conversations/{conversation_id}/lock")


def fork(client, conversation_id, through_message_id=None):
    body = {} if through_message_id is None else {"through_message_id": through_message_id}
    return client.post(f"/api/conversations/{conversation_id}/fork", json=body)


def view(client, conversation_id):
    response = client.get(f"/api/conversations/{conversation_id}")
    assert response.status_code == 200, response.text
    return response.json()


def chat_with_turns(client, *prompts, **settings):
    connect(client)
    cid = new(client, model="m1", **settings)
    for prompt in prompts:
        assert send(client, cid, prompt).status_code == 200
    return cid


def rows(path, sql, *args):
    with sqlite3.connect(path) as conn:
        conn.row_factory = sqlite3.Row
        return conn.execute(sql, args).fetchall()


# ---- lock
def test_a_new_conversation_is_not_locked(logged_in_client):
    cid = new(logged_in_client)
    body = view(logged_in_client, cid)
    assert body["locked"] is False and body["lock_reason"] is None


def test_lock_locks_it_and_is_idempotent(logged_in_client, llm_stub):
    cid = chat_with_turns(logged_in_client, "one")
    first = lock(logged_in_client, cid)
    assert first.status_code == 200
    assert first.json()["locked"] is True and first.json()["lock_reason"] == "user"
    again = lock(logged_in_client, cid)
    assert again.status_code == 200 and again.json()["locked"] is True


def test_a_locked_conversation_refuses_new_prompts_and_stores_nothing(logged_in_client, llm_stub):
    cid = chat_with_turns(logged_in_client, "one")
    lock(logged_in_client, cid)
    calls_before = len(llm_stub.calls)
    refused = send(logged_in_client, cid, "two")
    assert refused.status_code == 409 and refused.json()["error"]["code"] == "conversation_locked"
    body = view(logged_in_client, cid)
    assert [m["content"] for m in body["messages"] if m["role"] == "user"] == ["one"]
    assert len(llm_stub.calls) == calls_before  # the model was never asked


def test_there_is_no_rewind_route_any_more_and_no_route_deletes_a_message(logged_in_client, llm_stub):
    """Rewind is a view on the page; a fork copies. Nothing in the API removes a prompt."""
    cid = chat_with_turns(logged_in_client, "one", "two")
    assert logged_in_client.post(f"/api/conversations/{cid}/rewind").status_code in (404, 405)
    assert len(view(logged_in_client, cid)["messages"]) == 4


def test_a_locked_conversation_can_still_be_renamed_and_compacted(logged_in_client, llm_stub):
    cid = chat_with_turns(logged_in_client, "one")
    lock(logged_in_client, cid)
    assert logged_in_client.patch(f"/api/conversations/{cid}", json={"name": "Kept"}).json()["name"] == "Kept"
    compacted = logged_in_client.post(f"/api/conversations/{cid}/compact")
    assert compacted.status_code == 201 and compacted.json()["locked"] is False


def test_locking_does_not_change_which_conversation_is_current(logged_in_client):
    first = new(logged_in_client, name="First")
    second = new(logged_in_client, name="Second")
    assert current(logged_in_client)["conversation_id"] == second
    lock(logged_in_client, first)
    assert current(logged_in_client)["conversation_id"] == second  # a lock leaves updated_at alone


def test_locking_is_refused_while_a_prompt_waits_for_its_reply(logged_in_client, test_settings):
    cid = new(logged_in_client)
    asyncio.run(message_repository.begin_turn(test_settings.DATABASE_PATH, cid, "still waiting", "req-pending-1"))
    refused = lock(logged_in_client, cid)
    assert refused.status_code == 409 and refused.json()["error"]["code"] == "prompt_in_progress"
    assert view(logged_in_client, cid)["locked"] is False


def test_nobody_else_can_lock_or_fork_a_conversation(logged_in_client, other_client):
    cid = new(logged_in_client)
    assert lock(other_client, cid).status_code == 404
    assert fork(other_client, cid).status_code == 404


def test_the_list_says_which_conversations_are_locked(logged_in_client):
    open_one = new(logged_in_client, name="Open")
    locked_one = new(logged_in_client, name="Locked")
    lock(logged_in_client, locked_one)
    listed = {c["conversation_id"]: c for c in logged_in_client.get("/api/conversations").json()}
    assert listed[locked_one]["locked"] is True and listed[open_one]["locked"] is False


# ---- fork
def test_a_fork_is_a_new_conversation_with_the_same_settings_and_copied_messages(logged_in_client, llm_stub):
    cid = chat_with_turns(logged_in_client, "one", "two", reasoning_level="low")
    source = view(logged_in_client, cid)
    forked = fork(logged_in_client, cid)
    assert forked.status_code == 201, forked.text
    body = forked.json()
    assert body["conversation_id"] != cid
    assert body["name"] == "Test chat (fork)" and body["locked"] is False
    assert (body["agent_id"], body["model"], body["reasoning_level"]) == (
        source["agent_id"], source["model"], source["reasoning_level"]
    )  # fmt: skip
    assert [(m["role"], m["content"], m["request_id"]) for m in body["messages"]] == [
        (m["role"], m["content"], m["request_id"]) for m in source["messages"]
    ]
    assert not {m["message_id"] for m in body["messages"]} & {m["message_id"] for m in source["messages"]}
    assert view(logged_in_client, cid) == source  # the source is untouched
    assert current(logged_in_client)["conversation_id"] == body["conversation_id"]  # the fork is now current


def test_a_fork_can_stop_at_a_message_and_makes_no_model_call(logged_in_client, llm_stub):
    cid = chat_with_turns(logged_in_client, "one", "two", "three")
    messages = view(logged_in_client, cid)["messages"]
    calls_before = len(llm_stub.calls)
    forked = fork(logged_in_client, cid, through_message_id=messages[3]["message_id"])  # the reply to "two"
    assert forked.status_code == 201
    assert [m["content"] for m in forked.json()["messages"] if m["role"] == "user"] == ["one", "two"]
    assert len(forked.json()["messages"]) == 4
    assert len(llm_stub.calls) == calls_before  # forking sends nothing to a model


def test_a_fork_knows_where_it_came_from(logged_in_client, llm_stub):
    cid = chat_with_turns(logged_in_client, "one")
    body = fork(logged_in_client, cid).json()
    assert body["forked_from_conversation_id"] == cid and body["forked_from_name"] == "Test chat"
    assert view(logged_in_client, cid)["forked_from_conversation_id"] is None
    listed = {c["conversation_id"]: c for c in logged_in_client.get("/api/conversations").json()}
    assert listed[body["conversation_id"]]["forked_from_conversation_id"] == cid
    assert listed[cid]["forked_from_conversation_id"] is None


def test_a_locked_conversation_can_be_forked_and_the_fork_takes_prompts(logged_in_client, llm_stub):
    cid = chat_with_turns(logged_in_client, "one")
    lock(logged_in_client, cid)
    body = fork(logged_in_client, cid).json()
    assert body["locked"] is False
    assert send(logged_in_client, body["conversation_id"], "two").status_code == 200
    assert [m["content"] for m in view(logged_in_client, cid)["messages"] if m["role"] == "user"] == ["one"]


def test_a_message_from_another_conversation_or_a_missing_one_is_not_found(logged_in_client, llm_stub):
    cid = chat_with_turns(logged_in_client, "one")
    other = chat_with_turns(logged_in_client, "elsewhere")
    foreign = view(logged_in_client, other)["messages"][0]["message_id"]
    assert fork(logged_in_client, cid, through_message_id=foreign).status_code == 404
    assert fork(logged_in_client, cid, through_message_id="nope").status_code == 404


def test_a_fork_keeps_the_knowledge_base_fields_and_leaves_out_ignored_messages(
    logged_in_client, llm_stub, test_settings
):
    cid = chat_with_turns(logged_in_client, "one", "two")
    path = test_settings.DATABASE_PATH
    with sqlite3.connect(path) as conn:
        conn.execute(
            "UPDATE messages SET kb_version_id = 'v-1', kb_label = 'A / B / c.md' WHERE conversation_id = ? AND role = 'user'",
            (cid,),
        )
        conn.execute(
            "INSERT INTO messages (message_id, conversation_id, sequence_number, role, content, status, created_at) "
            "VALUES ('late-reply', ?, 99, 'assistant', 'late', 'ignored', '2026-01-01T00:00:00+00:00')",
            (cid,),
        )
    forked = fork(logged_in_client, cid).json()["conversation_id"]
    copied = rows(path, "SELECT * FROM messages WHERE conversation_id = ? ORDER BY sequence_number", forked)
    assert [r["content"] for r in copied if r["role"] == "user"] == ["one", "two"]
    assert all(r["status"] != "ignored" for r in copied)
    assert {r["kb_version_id"] for r in copied if r["role"] == "user"} == {"v-1"}
    assert {r["kb_label"] for r in copied if r["role"] == "user"} == {"A / B / c.md"}


def test_a_fork_is_refused_while_a_copied_prompt_waits_for_its_reply(logged_in_client, test_settings):
    cid = new(logged_in_client)
    asyncio.run(message_repository.begin_turn(test_settings.DATABASE_PATH, cid, "waiting", "req-pending-2"))
    refused = fork(logged_in_client, cid)
    assert refused.status_code == 409 and refused.json()["error"]["code"] == "prompt_in_progress"
    assert len(logged_in_client.get("/api/conversations").json()) == 1  # nothing half-made is left


def test_a_fork_copies_the_knowledge_base_choices_of_the_copied_prompts(logged_in_client, llm_stub, test_settings):
    cid = chat_with_turns(logged_in_client, "one", "two")
    source = view(logged_in_client, cid)
    first, second = [m["request_id"] for m in source["messages"] if m["role"] == "user"]
    step_ = {
        "step": "category", "model": "m1", "outcome": "chosen", "reason": "fits",
        "options": [{"id": "c1", "name": "Cat"}], "chosen": {"id": "c1", "name": "Cat"},
    }  # fmt: skip
    for ref in (first, second):
        asyncio.run(
            kb_choice_repository.record_path(
                test_settings.KNOWLEDGE_DB_PATH, "demo-user", "assistant", "chat", cid, ref, [step_]
            )
        )
    user_id = rows(test_settings.DATABASE_PATH, "SELECT user_id FROM conversations WHERE conversation_id = ?", cid)[0][
        0
    ]
    with sqlite3.connect(test_settings.KNOWLEDGE_DB_PATH) as conn:
        conn.execute("UPDATE knowledge_base_choice SET user_id = ? WHERE scope_id = ?", (user_id, cid))
    through = source["messages"][1]["message_id"]  # the reply to "one"
    forked = fork(logged_in_client, cid, through_message_id=through).json()["conversation_id"]
    copied = rows(
        test_settings.KNOWLEDGE_DB_PATH,
        "SELECT ref FROM knowledge_base_choice WHERE scope = 'chat' AND scope_id = ?",
        forked,
    )
    assert [r["ref"] for r in copied] == [first]  # only the kept prompt's choice
    assert (
        len(rows(test_settings.KNOWLEDGE_DB_PATH, "SELECT 1 FROM knowledge_base_choice WHERE scope_id = ?", cid)) == 2
    )


@pytest.mark.parametrize("failing", ["kb", "log"])
def test_a_failed_copy_leaves_no_half_made_fork(logged_in_client, llm_stub, test_settings, monkeypatch, failing):
    cid = chat_with_turns(logged_in_client, "one")
    before = len(logged_in_client.get("/api/conversations").json())

    async def boom(*args, **kwargs):
        raise RuntimeError("disk full")

    target = kb_choice_repository if failing == "kb" else chat_api_log_repository
    monkeypatch.setattr(target, "copy_chat" if failing == "kb" else "copy_for_fork", boom)
    with pytest.raises(RuntimeError):
        fork(logged_in_client, cid)
    assert len(logged_in_client.get("/api/conversations").json()) == before
    assert rows(test_settings.LOG_DB_PATH, "SELECT 1 FROM conversation_fork_log") == []
    assert rows(test_settings.DATABASE_PATH, "SELECT 1 FROM conversation_forks") == []  # the fork row is taken back too
    assert rows(test_settings.KNOWLEDGE_DB_PATH, "SELECT 1 FROM knowledge_base_choice WHERE scope_id != ?", cid) == []


# ---- the API log follows a fork
def test_a_fork_shows_the_calls_of_its_copied_prompts_and_says_where_they_came_from(logged_in_client, llm_stub):
    cid = chat_with_turns(logged_in_client, "one", "two")
    forked = fork(logged_in_client, cid).json()["conversation_id"]
    assert send(logged_in_client, forked, "three").status_code == 200
    log = logged_in_client.get(f"/api/conversations/{forked}/api-log").json()
    assert [t["prompt"] for t in log["turns"]] == ["one", "two", "three"]
    assert [len(t["calls"]) for t in log["turns"]] == [1, 1, 1]
    assert [t["source_conversation_id"] for t in log["turns"]] == [cid, cid, None]
    assert [t["source_conversation_name"] for t in log["turns"]] == ["Test chat", "Test chat", None]
    source_log = logged_in_client.get(f"/api/conversations/{cid}/api-log").json()
    assert [t["source_conversation_id"] for t in source_log["turns"]] == [None, None]


def test_the_calls_are_shared_not_copied_and_a_fork_of_a_fork_points_at_the_original(
    logged_in_client, llm_stub, test_settings
):
    cid = chat_with_turns(logged_in_client, "one")
    calls_before = len(rows(test_settings.LOG_DB_PATH, "SELECT 1 FROM chat_api_calls"))
    second = fork(logged_in_client, cid).json()["conversation_id"]
    third = fork(logged_in_client, second).json()["conversation_id"]
    assert len(rows(test_settings.LOG_DB_PATH, "SELECT 1 FROM chat_api_calls")) == calls_before
    log = logged_in_client.get(f"/api/conversations/{third}/api-log").json()
    assert log["turns"][0]["source_conversation_id"] == cid  # the conversation that really made the call
    forks = rows(test_settings.LOG_DB_PATH, "SELECT conversation_id, origin_conversation_id FROM conversation_fork_log")
    assert {(r[0], r[1]) for r in forks} == {(second, cid), (third, second)}  # the direct parent is recorded


def test_deleting_the_source_leaves_the_forks_log_and_the_name_becomes_unknown(
    logged_in_client, llm_stub, test_settings
):
    cid = chat_with_turns(logged_in_client, "one")
    forked = fork(logged_in_client, cid).json()["conversation_id"]
    with sqlite3.connect(test_settings.DATABASE_PATH) as conn:
        conn.execute("DELETE FROM conversations WHERE conversation_id = ?", (cid,))
    log = logged_in_client.get(f"/api/conversations/{forked}/api-log").json()
    assert len(log["turns"][0]["calls"]) == 1  # the immutable record is still there
    assert log["turns"][0]["source_conversation_id"] == cid and log["turns"][0]["source_conversation_name"] is None
    again = view(logged_in_client, forked)
    assert again["forked_from_conversation_id"] == cid and again["forked_from_name"] is None


# ---- the replay locks its source at the first step
def test_loading_a_conversation_into_a_replay_does_not_lock_it(logged_in_client):
    cid = current_chat(logged_in_client, "one", "two")
    run_of(create(logged_in_client, conversation_id=cid))
    assert view(logged_in_client, cid)["locked"] is False


def test_the_first_step_of_a_replay_locks_its_source_conversation(logged_in_client):
    cid = current_chat(logged_in_client, "one", "two")
    run = run_of(create(logged_in_client, conversation_id=cid))
    run = run_of(step(logged_in_client, run))
    body = view(logged_in_client, cid)
    assert body["locked"] is True and body["lock_reason"] == "replay"
    assert send(logged_in_client, cid, "more").status_code == 409
    play_all(logged_in_client, run)  # the rest of the replay still runs


def test_a_replay_of_prompts_or_a_chat_record_locks_nothing(logged_in_client):
    cid = current_chat(logged_in_client, "one")
    run = run_of(create(logged_in_client, prompts=["a", "b"]))
    run_of(step(logged_in_client, run))
    record = logged_in_client.post("/api/chat-records", json={"conversation_id": cid}).json()
    run = run_of(create(logged_in_client, chat_record_id=record["chat_record_id"]))
    run_of(step(logged_in_client, run))
    assert view(logged_in_client, cid)["locked"] is False


def test_a_conversation_the_user_locked_keeps_its_reason_when_a_replay_starts(logged_in_client):
    cid = current_chat(logged_in_client, "one")
    lock(logged_in_client, cid)
    run = run_of(create(logged_in_client, conversation_id=cid))
    run_of(step(logged_in_client, run))
    assert view(logged_in_client, cid)["lock_reason"] == "user"


def test_replaying_a_fork_locks_the_fork_and_not_its_source(logged_in_client, llm_stub):
    cid = chat_with_turns(logged_in_client, "one")
    forked = fork(logged_in_client, cid).json()["conversation_id"]
    run = run_of(create(logged_in_client, conversation_id=forked))
    run_of(step(logged_in_client, run))
    assert view(logged_in_client, forked)["locked"] is True
    assert view(logged_in_client, cid)["locked"] is False


def test_a_failed_lock_fails_the_step_and_the_replay_does_not_move(logged_in_client, monkeypatch):
    cid = current_chat(logged_in_client, "one", "two")
    run = run_of(create(logged_in_client, conversation_id=cid))

    async def boom(*args, **kwargs):
        raise RuntimeError("database is locked")

    monkeypatch.setattr("services.conversation_service.lock_for_replay", boom)
    with pytest.raises(RuntimeError):
        step(logged_in_client, run)
    monkeypatch.undo()
    again = run_of(logged_in_client.get("/api/replay-runs/current"))
    assert again["cursor"] == 0 and again["step_running"] is False  # the claim was released
    assert run_of(step(logged_in_client, again))["cursor"] == 1


# ---- the migration
def test_existing_conversations_with_a_started_replay_are_locked_by_the_migration(tmp_path):
    before = tmp_path / "before"
    before.mkdir()
    for path in sorted(MIGRATIONS_DIR.glob("*.sql")):
        if int(path.name[:4]) <= 15:
            shutil.copy(path, before / path.name)
    db = str(tmp_path / "app.db")
    assert apply_migrations(db, before)[-1] == 15
    stamp = "2026-01-01T00:00:00+00:00"
    with sqlite3.connect(db) as conn:
        conn.execute(
            "INSERT INTO users (user_id, username, password_hash, created_at) VALUES ('u', 'u', 'x', ?)", (stamp,)
        )
        for cid in ("started", "not-started", "unreplayed"):
            conn.execute(
                "INSERT INTO conversations (conversation_id, user_id, is_sample, created_at, updated_at) "
                "VALUES (?, 'u', 0, ?, ?)",
                (cid, stamp, stamp),
            )
        for run_id, source, cursor in (("r1", "started", 2), ("r2", "not-started", 0)):
            conn.execute(
                "INSERT INTO replay_runs (replay_run_id, user_id, agent_id, prompts_json, model_a, model_b, cursor, "
                "created_at, updated_at, source_conversation_id) VALUES (?, 'u', 'assistant', '[]', 'a', 'b', ?, ?, ?, ?)",
                (run_id, cursor, stamp, stamp, source),
            )
    assert apply_migrations(db)[:2] == [16, 17]  # (later migrations may follow)
    state = {
        r[0]: (r[1], r[2])
        for r in sqlite3.connect(db).execute("SELECT conversation_id, locked_at, lock_reason FROM conversations")
    }
    assert state["started"][0] is not None and state["started"][1] == "replay"
    assert state["not-started"] == (None, None) and state["unreplayed"] == (None, None)


# ---- deleting conversations is safe because a fork owns its rows
def test_deleting_the_source_and_then_the_fork_removes_only_their_own_rows(logged_in_client, llm_stub, test_settings):
    from repositories import conversation_repository

    cid = chat_with_turns(logged_in_client, "one", "two")
    forked = fork(logged_in_client, cid).json()["conversation_id"]
    user_id = rows(test_settings.DATABASE_PATH, "SELECT user_id FROM conversations WHERE conversation_id = ?", cid)[0][
        0
    ]
    log_rows = len(rows(test_settings.LOG_DB_PATH, "SELECT 1 FROM chat_api_conversation_requests"))
    calls = len(rows(test_settings.LOG_DB_PATH, "SELECT 1 FROM chat_api_calls"))

    asyncio.run(conversation_repository.delete_many(test_settings.DATABASE_PATH, user_id, [cid]))
    body = view(logged_in_client, forked)
    assert [m["content"] for m in body["messages"] if m["role"] == "user"] == ["one", "two"]  # the fork is complete
    assert len(logged_in_client.get(f"/api/conversations/{forked}/api-log").json()["turns"][0]["calls"]) == 1
    assert rows(test_settings.DATABASE_PATH, "SELECT 1 FROM messages WHERE conversation_id = ?", cid) == []

    asyncio.run(conversation_repository.delete_many(test_settings.DATABASE_PATH, user_id, [forked]))
    assert rows(test_settings.DATABASE_PATH, "SELECT 1 FROM messages WHERE conversation_id = ?", forked) == []
    # deleting conversations never touches the append-only log
    assert len(rows(test_settings.LOG_DB_PATH, "SELECT 1 FROM chat_api_conversation_requests")) == log_rows
    assert len(rows(test_settings.LOG_DB_PATH, "SELECT 1 FROM chat_api_calls")) == calls
    assert len(rows(test_settings.LOG_DB_PATH, "SELECT 1 FROM conversation_fork_log")) == 1
    assert len(rows(test_settings.DATABASE_PATH, "SELECT 1 FROM conversation_forks")) == 1  # the lineage row stays too


# ---- conversation_forks (app.db): the lineage the app reads
def fork_rows(test_settings):
    return rows(
        test_settings.DATABASE_PATH,
        "SELECT fork_id, conversation_id, origin_conversation_id, created_by FROM conversation_forks",
    )


def test_every_fork_has_one_row_in_conversation_forks_and_a_matching_audit_copy(
    logged_in_client, llm_stub, test_settings
):
    cid = chat_with_turns(logged_in_client, "one")
    forked = fork(logged_in_client, cid).json()["conversation_id"]
    [row] = fork_rows(test_settings)
    assert (row["conversation_id"], row["origin_conversation_id"]) == (forked, cid)
    assert (
        row["created_by"]
        == rows(test_settings.DATABASE_PATH, "SELECT user_id FROM conversations WHERE conversation_id = ?", cid)[0][0]
    )
    [audit] = rows(
        test_settings.LOG_DB_PATH, "SELECT fork_id, conversation_id, origin_conversation_id FROM conversation_fork_log"
    )
    assert audit["fork_id"] == row["fork_id"]  # the same event, the same id, in the append-only copy
    assert (audit["conversation_id"], audit["origin_conversation_id"]) == (forked, cid)


def test_a_conversation_that_was_not_forked_has_no_row(logged_in_client, test_settings):
    new(logged_in_client)
    assert fork_rows(test_settings) == []


def test_the_fork_row_is_written_in_the_same_transaction_as_the_copy(logged_in_client, llm_stub, test_settings):
    """A fork that has no row cannot exist: if the row cannot be written, no conversation is made."""
    cid = chat_with_turns(logged_in_client, "one")
    with sqlite3.connect(test_settings.DATABASE_PATH) as conn:
        conn.execute(
            "CREATE TRIGGER refuse_fork_rows BEFORE INSERT ON conversation_forks BEGIN SELECT RAISE(ABORT, 'no'); END"
        )
    before = len(logged_in_client.get("/api/conversations").json())
    with pytest.raises(sqlite3.IntegrityError):
        fork(logged_in_client, cid)
    assert len(logged_in_client.get("/api/conversations").json()) == before


def test_deleting_the_source_keeps_the_fork_row_so_lineage_survives(logged_in_client, llm_stub, test_settings):
    from repositories import conversation_repository

    cid = chat_with_turns(logged_in_client, "one")
    forked = fork(logged_in_client, cid).json()["conversation_id"]
    user_id = rows(test_settings.DATABASE_PATH, "SELECT user_id FROM conversations WHERE conversation_id = ?", cid)[0][
        0
    ]
    asyncio.run(conversation_repository.delete_many(test_settings.DATABASE_PATH, user_id, [cid]))
    assert [(r["conversation_id"], r["origin_conversation_id"]) for r in fork_rows(test_settings)] == [(forked, cid)]
    body = view(logged_in_client, forked)
    assert body["forked_from_conversation_id"] == cid and body["forked_from_name"] is None  # "a deleted conversation"


def test_a_conversation_can_be_forked_into_existence_only_once(logged_in_client, llm_stub, test_settings):
    cid = chat_with_turns(logged_in_client, "one")
    forked = fork(logged_in_client, cid).json()["conversation_id"]
    with sqlite3.connect(test_settings.DATABASE_PATH) as conn, pytest.raises(sqlite3.IntegrityError):
        conn.execute(
            "INSERT INTO conversation_forks VALUES ('another', ?, ?, '2026-01-01T00:00:00+00:00', 'u')", (forked, cid)
        )


def test_forks_for_is_one_query_scoped_to_the_user(db, test_settings):
    from repositories import conversation_repository

    with sqlite3.connect(test_settings.DATABASE_PATH) as conn:
        conn.executemany(
            "INSERT INTO conversation_forks VALUES (?, ?, ?, '2026-01-01T00:00:00+00:00', ?)",
            [("f1", "fork-a", "conv-1", "user-a"), ("f2", "fork-b", "conv-5", "user-b")],
        )
    path = test_settings.DATABASE_PATH
    assert asyncio.run(conversation_repository.forks_for(path, "user-a", ["fork-a", "fork-b", "conv-1"])) == {
        "fork-a": "conv-1"
    }
    assert asyncio.run(conversation_repository.forks_for(path, "user-a", [])) == {}


def test_a_fork_of_a_fork_records_its_direct_parent(logged_in_client, llm_stub, test_settings):
    cid = chat_with_turns(logged_in_client, "one")
    second = fork(logged_in_client, cid).json()["conversation_id"]
    third = fork(logged_in_client, second).json()["conversation_id"]
    assert {(r["conversation_id"], r["origin_conversation_id"]) for r in fork_rows(test_settings)} == {
        (second, cid),
        (third, second),
    }


# ---- deleting a conversation (the trash can in the Chat page's sidebar)
def delete(client, conversation_id):
    return client.delete(f"/api/conversations/{conversation_id}")


def test_deleting_a_conversation_removes_it_and_its_messages_and_choices(logged_in_client, llm_stub, test_settings):
    cid = chat_with_turns(logged_in_client, "one", "two")
    keep = new(logged_in_client, name="Keep me", model="m1")
    user_id = rows(test_settings.DATABASE_PATH, "SELECT user_id FROM conversations WHERE conversation_id = ?", cid)[0][
        0
    ]
    with sqlite3.connect(test_settings.KNOWLEDGE_DB_PATH) as conn:
        conn.execute(
            "INSERT INTO knowledge_base_choice (choice_id, user_id, agent_id, scope, scope_id, ref, step_number, level, "
            "options_json, outcome, created_at) VALUES ('c-1', ?, 'assistant', 'chat', ?, 'req-00000001', 1, 'category', "
            "'[]', 'none', '2026-01-01T00:00:00+00:00')",
            (user_id, cid),
        )
    assert delete(logged_in_client, cid).status_code == 204
    assert logged_in_client.get(f"/api/conversations/{cid}").status_code == 404
    assert rows(test_settings.DATABASE_PATH, "SELECT 1 FROM messages WHERE conversation_id = ?", cid) == []
    assert rows(test_settings.KNOWLEDGE_DB_PATH, "SELECT 1 FROM knowledge_base_choice WHERE scope_id = ?", cid) == []
    assert [c["conversation_id"] for c in logged_in_client.get("/api/conversations").json()] == [keep]


def test_deleting_the_current_conversation_makes_another_current_or_starts_a_fresh_one(logged_in_client):
    first = new(logged_in_client, name="First")
    second = new(logged_in_client, name="Second")
    assert current(logged_in_client)["conversation_id"] == second
    delete(logged_in_client, second)
    assert current(logged_in_client)["conversation_id"] == first
    delete(logged_in_client, first)
    fresh = current(logged_in_client)  # nothing left: the page gets an empty one, as for a new user
    assert fresh["messages"] == [] and fresh["conversation_id"] not in (first, second)


def test_nobody_else_can_delete_a_conversation_and_a_missing_one_is_not_found(logged_in_client, other_client):
    cid = new(logged_in_client)
    assert delete(other_client, cid).status_code == 404
    assert delete(logged_in_client, "nope").status_code == 404
    assert logged_in_client.get(f"/api/conversations/{cid}").status_code == 200
    assert other_client.delete(f"/api/conversations/{cid}").status_code == 404
    assert delete(logged_in_client, cid).status_code == 204
    assert delete(logged_in_client, cid).status_code == 404  # already gone


def test_a_locked_conversation_can_be_deleted(logged_in_client, llm_stub):
    cid = chat_with_turns(logged_in_client, "one")
    lock(logged_in_client, cid)
    assert delete(logged_in_client, cid).status_code == 204


def test_deleting_keeps_the_log_the_fork_rows_and_the_replays_prompts(logged_in_client, llm_stub, test_settings):
    cid = current_chat(logged_in_client, "one", "two")
    forked = fork(logged_in_client, cid).json()["conversation_id"]
    run = run_of(create(logged_in_client, conversation_id=cid))
    logs = len(rows(test_settings.LOG_DB_PATH, "SELECT 1 FROM chat_api_conversation_requests"))
    assert delete(logged_in_client, cid).status_code == 204
    assert len(rows(test_settings.LOG_DB_PATH, "SELECT 1 FROM chat_api_conversation_requests")) == logs  # append-only
    assert len(rows(test_settings.DATABASE_PATH, "SELECT 1 FROM conversation_forks")) == 1  # lineage stays
    assert view(logged_in_client, forked)["forked_from_name"] is None
    again = run_of(logged_in_client.get("/api/replay-runs/current"))
    assert again["replay_run_id"] == run["replay_run_id"] and again["prompts"] == [
        "one",
        "two",
    ]  # the replay keeps its prompts


def test_deleting_clears_the_conversations_stop_markers(logged_in_client, test_settings):
    cid = new(logged_in_client)
    logged_in_client.post(f"/api/conversations/{cid}/stop", json={"request_id": "stop-before-send"})
    assert rows(test_settings.DATABASE_PATH, "SELECT 1 FROM stop_requests WHERE scope_id = ?", cid) != []
    delete(logged_in_client, cid)
    assert rows(test_settings.DATABASE_PATH, "SELECT 1 FROM stop_requests WHERE scope_id = ?", cid) == []


def test_requires_login_to_delete(client):
    assert client.delete("/api/conversations/anything").status_code == 401
