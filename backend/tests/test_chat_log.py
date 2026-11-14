"""The chat log in Log.db: append-only, one row per attempt, retries tracked, and forks sharing the calls."""

import json
import shutil
import sqlite3

import httpx
import pytest

from db.migrate import LOG_MIGRATIONS_DIR, apply_migrations
from repositories import chat_api_log_repository as log
from services import llm_service
from tests.test_conversations import connect, new, send
from tests.test_llm_service import call, with_transport

USER = "user-1"


def entry(purpose="answer", status=200, **extra):
    return {
        "at": "2026-01-01T00:00:00+00:00", "purpose": purpose, "method": "POST",
        "url": "https://api.example.com/v1/chat/completions", "duration_ms": 25,
        "request": {"headers": {"Authorization": "Bearer <redacted>"}, "body": {"model": "m1", "messages": []}},
        "response": {"status": status, "body": '{"ok":true}', "truncated": False}, "error": None, **extra,
    }  # fmt: skip


def rows(path, sql, *args):
    with sqlite3.connect(path) as conn:
        conn.row_factory = sqlite3.Row
        return conn.execute(sql, args).fetchall()


@pytest.fixture(autouse=True)
def forget_refusals():
    llm_service._NO_TEMPERATURE.clear()
    yield
    llm_service._NO_TEMPERATURE.clear()


# ---- how an attempt is recorded by llm_service
async def attempts(monkeypatch, handler, **overrides):
    """Run one `complete` call and return (result or the error, the entries it logged)."""
    with_transport(monkeypatch, handler)
    with llm_service.collect_calls() as collected:
        try:
            result = await call(**overrides)
        except llm_service.LLMError as error:
            result = error
    return result, collected


async def test_a_clean_answer_is_a_success_with_no_provider_code(monkeypatch):
    result, calls = await attempts(
        monkeypatch, lambda r: httpx.Response(200, json={"choices": [{"message": {"content": "hi"}}]})
    )
    assert result == "hi" and [(c["outcome"], c["api_response_code"]) for c in calls] == [("success", None)]


async def test_an_error_status_is_failed_and_keeps_the_providers_code(monkeypatch):
    body = {"error": {"message": "slow down", "code": "rate_limit_exceeded", "type": "requests"}}
    result, calls = await attempts(monkeypatch, lambda r: httpx.Response(429, json=body))
    assert isinstance(result, llm_service.LLMError) and result.code == "llm_http_error"
    assert [(c["outcome"], c["api_response_code"], c["response"]["status"]) for c in calls] == [
        ("failed", "rate_limit_exceeded", 429)
    ]


async def test_the_providers_type_is_used_when_it_gives_no_code(monkeypatch):
    body = {"error": {"message": "bad", "code": None, "type": "invalid_request_error"}}
    _, calls = await attempts(monkeypatch, lambda r: httpx.Response(400, json=body))
    assert calls[0]["api_response_code"] == "invalid_request_error"


async def test_a_body_that_is_not_json_has_no_code(monkeypatch):
    _, calls = await attempts(monkeypatch, lambda r: httpx.Response(502, text="<html>bad gateway</html>"))
    assert [(c["outcome"], c["api_response_code"]) for c in calls] == [("failed", None)]


async def test_no_answer_in_time_is_a_timeout(monkeypatch):
    def handler(request):
        raise httpx.ReadTimeout("slow", request=request)

    result, calls = await attempts(monkeypatch, handler)
    assert result.code == "llm_timeout"
    assert [(c["outcome"], c["response"], c["api_response_code"]) for c in calls] == [("timeout", None, None)]


async def test_an_unreachable_provider_is_an_error(monkeypatch):
    def handler(request):
        raise httpx.ConnectError("refused", request=request)

    result, calls = await attempts(monkeypatch, handler)
    assert result.code == "llm_unreachable" and [c["outcome"] for c in calls] == ["error"]


@pytest.mark.parametrize(
    ("response", "code"),
    [
        (httpx.Response(200, text="not json"), "llm_invalid_response"),
        (httpx.Response(200, json={"choices": [{"message": {"content": "  "}}]}), "llm_empty_response"),
    ],
)
async def test_a_200_whose_body_cannot_be_used_is_an_error_not_a_success(monkeypatch, response, code):
    result, calls = await attempts(monkeypatch, lambda r: response)
    assert result.code == code
    assert [(c["outcome"], c["response"]["status"]) for c in calls] == [("error", 200)]


async def test_the_parameter_retry_is_two_attempts_with_the_reason_on_the_first(monkeypatch):
    def handler(request):
        if "temperature" in json.loads(request.content):
            return httpx.Response(
                400, json={"error": {"message": "'temperature' is not supported", "code": "unsupported_parameter"}}
            )
        return httpx.Response(200, json={"choices": [{"message": {"content": "ok"}}]})

    result, calls = await attempts(monkeypatch, handler, temperature=0)
    assert result == "ok"
    assert [(c["outcome"], c["api_response_code"]) for c in calls] == [
        ("failed", "unsupported_parameter"),
        ("success", None),
    ]


# ---- record_request: plain inserts, retry counter per purpose
async def test_each_attempt_is_a_row_and_the_retry_counter_counts_per_purpose(db, test_settings):
    path = test_settings.LOG_DB_PATH
    calls = [
        entry("kb_route:category"),
        entry("kb_route:category", 400, outcome="failed", api_response_code="unsupported_parameter"),
        entry("kb_route:category"),
        entry("answer"),
    ]
    await log.record_request(path, USER, "conv-1", "req-0001", "msg-1", calls)
    stored = rows(path, "SELECT * FROM chat_api_calls ORDER BY seq")
    assert [(r["purpose"], r["request_retry_counter"]) for r in stored] == [
        ("kb_route:category", 0), ("kb_route:category", 1), ("kb_route:category", 2), ("answer", 0)
    ]  # fmt: skip
    assert [r["response_status"] for r in stored] == ["success", "failed", "success", "success"]
    assert stored[1]["api_response_code"] == "unsupported_parameter" and stored[1]["http_status"] == 400
    assert stored[0]["api_response_code"] is None


@pytest.mark.parametrize(
    ("changes", "expected"),
    [
        ({}, "success"),
        ({"response": {"status": 500, "body": "", "truncated": False}}, "failed"),
        ({"response": None, "error": "The API did not respond in time."}, "timeout"),
        ({"response": None, "error": "Could not reach the API."}, "error"),
        ({"outcome": "error"}, "error"),
    ],
)
async def test_an_entry_without_an_outcome_is_judged_from_its_response(db, test_settings, changes, expected):
    assert log.outcome_of({**entry(), **changes}) == expected


async def test_a_prompt_with_no_calls_is_still_listed(db, test_settings):
    await log.record_request(test_settings.LOG_DB_PATH, USER, "conv-1", "req-0001", "msg-1", [])
    assert await log.for_conversation(test_settings.LOG_DB_PATH, USER, "conv-1") == {"msg-1": []}


async def test_logging_the_same_request_twice_never_replaces_the_first_record(db, test_settings):
    path = test_settings.LOG_DB_PATH
    await log.record_request(path, USER, "conv-1", "req-0001", "msg-1", [entry()])
    with pytest.raises(sqlite3.IntegrityError):
        await log.record_request(path, USER, "conv-1", "req-0001", "msg-2", [entry("kb_summary"), entry()])
    assert [r["message_id"] for r in rows(path, "SELECT message_id FROM chat_api_conversation_requests")] == ["msg-1"]
    assert len(rows(path, "SELECT 1 FROM chat_api_calls")) == 1  # the failed second write left nothing behind


async def test_one_user_never_sees_another_users_calls_for_the_same_request_id(db, test_settings):
    path = test_settings.LOG_DB_PATH
    await log.record_request(path, "user-a", "conv-a", "shared-request-id", "msg-a", [entry()])
    await log.record_request(path, "user-b", "conv-b", "shared-request-id", "msg-b", [])  # the same client-chosen id
    mine = await log.for_conversation(path, "user-b", "conv-b")
    assert mine == {"msg-b": []}  # user-a's call is not shown to user-b
    assert len((await log.for_conversation(path, "user-a", "conv-a"))["msg-a"]) == 1


# ---- append-only
@pytest.mark.parametrize(
    "sql",
    [
        "UPDATE chat_api_calls SET purpose = 'x'",
        "DELETE FROM chat_api_calls",
        "UPDATE chat_api_conversation_requests SET message_id = 'x'",
        "DELETE FROM chat_api_conversation_requests",
        "UPDATE conversation_fork_log SET created_by = 'x'",
        "DELETE FROM conversation_fork_log",
    ],
)
async def test_the_chat_log_tables_refuse_updates_and_deletes(db, test_settings, sql):
    path = test_settings.LOG_DB_PATH
    await log.record_request(path, USER, "conv-1", "req-0001", "msg-1", [entry()])
    await log.copy_for_fork(path, USER, "conv-1", "conv-2", {"msg-1": "msg-2"}, "fork-id-1")
    with sqlite3.connect(path) as conn, pytest.raises(sqlite3.IntegrityError, match="append-only"):
        conn.execute(sql)
    assert len(rows(path, "SELECT 1 FROM chat_api_calls")) == 1  # still all there


async def test_inserts_still_work_after_the_triggers(db, test_settings):
    path = test_settings.LOG_DB_PATH
    await log.record_request(path, USER, "conv-1", "req-0001", "msg-1", [entry()])
    await log.record_request(path, USER, "conv-1", "req-0002", "msg-2", [entry()])
    assert len(rows(path, "SELECT 1 FROM chat_api_calls")) == 2


async def test_the_old_chat_log_is_discarded_once_by_the_migration(tmp_path):
    before = tmp_path / "before"
    before.mkdir()
    for p in sorted(LOG_MIGRATIONS_DIR.glob("*.sql")):
        if int(p.name[:4]) <= 4:
            shutil.copy(p, before / p.name)
    db = str(tmp_path / "Log.db")
    apply_migrations(db, before)
    with sqlite3.connect(db) as conn:
        conn.execute("INSERT INTO chat_api_requests VALUES ('old-req', 'c', 'u', '2026-01-01T00:00:00+00:00')")
    assert apply_migrations(db, LOG_MIGRATIONS_DIR) == [5]
    names = {r[0] for r in sqlite3.connect(db).execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
    assert "chat_api_requests" not in names
    assert (
        rows(db, "SELECT 1 FROM chat_api_calls") == []
        and rows(db, "SELECT 1 FROM chat_api_conversation_requests") == []
    )


# ---- forks
async def test_a_fork_gets_its_own_rows_for_the_copied_prompts_and_the_calls_are_not_copied(db, test_settings):
    path = test_settings.LOG_DB_PATH
    await log.record_request(path, USER, "conv-1", "req-0001", "msg-1", [entry(), entry("kb_summary")])
    await log.record_request(path, USER, "conv-1", "req-0002", "msg-3", [entry()])
    await log.copy_for_fork(
        path, USER, "conv-1", "conv-2", {"msg-1": "fork-msg-1", "internal-row": "fork-internal"}, "fork-id-1"
    )
    copied = rows(path, "SELECT * FROM chat_api_conversation_requests WHERE conversation_id = 'conv-2'")
    assert [(r["request_id"], r["message_id"], r["user_id"]) for r in copied] == [("req-0001", "fork-msg-1", USER)]
    assert len(rows(path, "SELECT 1 FROM chat_api_calls")) == 3  # nothing copied or changed
    fork_calls = (await log.for_conversation(path, USER, "conv-2"))["fork-msg-1"]
    assert [c["purpose"] for c in fork_calls] == ["answer", "kb_summary"]
    assert {c["conversation_id"] for c in fork_calls} == {"conv-1"}  # they say who made them
    log_rows = rows(path, "SELECT * FROM conversation_fork_log")
    assert [(r["fork_id"], r["conversation_id"], r["origin_conversation_id"], r["created_by"]) for r in log_rows] == [
        ("fork-id-1", "conv-2", "conv-1", USER)
    ]


async def test_a_conversation_can_be_forked_into_existence_only_once(db, test_settings):
    path = test_settings.LOG_DB_PATH
    await log.copy_for_fork(path, USER, "conv-1", "conv-2", {}, "fork-id-1")
    with pytest.raises(sqlite3.IntegrityError):
        await log.copy_for_fork(path, USER, "conv-9", "conv-2", {}, "fork-id-2")
    assert len(rows(path, "SELECT 1 FROM conversation_fork_log")) == 1


# ---- through the API
def test_the_api_log_carries_the_retry_fields_and_the_http_status(logged_in_client):
    connect(logged_in_client)
    cid = new(logged_in_client, model="m1")
    assert send(logged_in_client, cid, "hello").status_code == 200
    log_ = logged_in_client.get(f"/api/conversations/{cid}/api-log").json()
    first = log_["turns"][0]["calls"][0]
    assert first["request_retry_counter"] == 0 and first["response_status"] == "success"
    assert first["api_response_code"] is None and first["response"]["status"] == 200
