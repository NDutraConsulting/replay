"""The raw REST-call log of the Chat page (Log.db): what was sent to the model provider to answer each prompt.

Log.db is append-only. Nothing here updates or deletes a row (the tables carry triggers that refuse it), and a
write is a plain INSERT: it never replaces what was kept.

  chat_api_calls                    one row per attempt, written once, shared by a conversation and its forks
  chat_api_conversation_requests    one row per prompt of a conversation, pointing at its request id; a fork copies these
  conversation_fork_log             who forked which conversation from which
"""

import sqlite3
from datetime import UTC, datetime

from db.connection import run_in_log_db
from repositories.api_log_repository import call_from_row, call_values

OUTCOMES = ("failed", "timeout", "success", "error")


def _now() -> str:
    return datetime.now(UTC).isoformat()


def outcome_of(call: dict) -> str:
    """How an attempt ended: success, failed (the provider answered with an error status), timeout (no answer in time)
    or error (unreachable, or an answer that could not be used). `llm_service` sets it on the entry; an entry without
    one (a test stub) is judged from its response."""
    explicit = call.get("outcome")
    if explicit in OUTCOMES:
        return explicit
    response = call.get("response")
    if response is None:
        return "timeout" if "in time" in (call.get("error") or "") else "error"
    return "success" if 200 <= response["status"] < 300 else "failed"


def _call_row(request_id: str, conversation_id: str, seq: int, user_id: str, call: dict, retry: int) -> tuple:
    purpose, method, url, headers, body, status, response_body, truncated, error, duration, at, settings, logprobs = (
        call_values(call)
    )
    return (
        request_id, conversation_id, seq, user_id, purpose, method, url, headers, body, status, response_body,
        truncated, error, duration, at, settings, logprobs, retry, call.get("api_response_code"), outcome_of(call),
    )  # fmt: skip


async def record_request(
    db_path: str, user_id: str, conversation_id: str, request_id: str, message_id: str, calls: list[dict]
) -> None:
    """Keep the calls made for one prompt, in order, in ONE transaction, and list the prompt in its conversation. The
    prompt is listed even when `calls` is empty (demo mode makes none). A repeated retry counter is worked out here: how
    many calls of the same purpose came before this one (0 for the first attempt).

    Append-only: if this request id was already logged for the conversation, nothing is changed and the first
    record stands (the error is raised and the caller logs it; a missing log never fails a prompt)."""

    def _run(conn: sqlite3.Connection) -> None:
        conn.execute(
            "INSERT INTO chat_api_conversation_requests (conversation_id, request_id, message_id, user_id, logged_at) "
            "VALUES (?, ?, ?, ?, ?)",
            (conversation_id, request_id, message_id, user_id, _now()),
        )
        seen: dict[str, int] = {}
        for seq, call in enumerate(calls):
            retry = seen.get(call["purpose"], 0)
            seen[call["purpose"]] = retry + 1
            conn.execute(
                "INSERT INTO chat_api_calls (request_id, conversation_id, seq, user_id, purpose, method, url, "
                "request_headers_json, request_body_json, http_status, response_body, response_truncated, error, "
                "duration_ms, called_at, settings_json, logprobs_json, request_retry_counter, api_response_code, "
                "response_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                _call_row(request_id, conversation_id, seq, user_id, call, retry),
            )

    await run_in_log_db(db_path, _run)


def _call(r: sqlite3.Row) -> dict:
    call = call_from_row(r, "http_status")
    call["request_retry_counter"] = r["request_retry_counter"]
    call["api_response_code"] = r["api_response_code"]
    call["response_status"] = r["response_status"]
    call["conversation_id"] = r[
        "conversation_id"
    ]  # the conversation that made the call (internal: the service uses it)
    return call


async def for_conversation(db_path: str, user_id: str, conversation_id: str) -> dict[str, list[dict]]:
    """The logged calls of a conversation's prompts: {message_id: [call, ...]} in call order. The prompts are found
    through the conversation's own rows in `chat_api_conversation_requests`, so a fork sees the calls of the prompts
    it copied. The join also matches the user: a request id is chosen by the client, and one user must never see
    another's calls. A prompt that was never logged is absent; a prompt that made no calls maps to []."""

    def _run(conn: sqlite3.Connection) -> dict[str, list[dict]]:
        logged: dict[str, list[dict]] = {}
        requests = conn.execute(
            "SELECT request_id, message_id FROM chat_api_conversation_requests WHERE conversation_id = ? AND user_id = ?",
            (conversation_id, user_id),
        ).fetchall()
        by_request = {r["request_id"]: r["message_id"] for r in requests}
        for r in requests:
            logged[r["message_id"]] = []
        rows = conn.execute(
            "SELECT c.* FROM chat_api_calls c JOIN chat_api_conversation_requests m "
            "ON m.request_id = c.request_id AND m.user_id = c.user_id "
            "WHERE m.conversation_id = ? AND m.user_id = ? ORDER BY c.request_id, c.seq",
            (conversation_id, user_id),
        ).fetchall()
        for r in rows:
            logged[by_request[r["request_id"]]].append(_call(r))
        return logged

    return await run_in_log_db(db_path, _run)


async def copy_for_fork(
    db_path: str,
    user_id: str,
    from_conversation_id: str,
    to_conversation_id: str,
    message_id_map: dict[str, str],
    fork_id: str,
) -> None:
    """A conversation was forked: in ONE transaction, record the fork (the append-only audit copy of the row the app keeps
    in app.db's `conversation_forks`, under the same `fork_id`) and give the fork a row for each copied prompt
    that was logged (new conversation id, new message id, the SAME request id). The calls themselves are not copied
    or touched: the fork shows the source's calls through its own rows. `message_id_map` is {source message id: fork
    message id} for the prompts that were copied."""

    def _run(conn: sqlite3.Connection) -> None:
        conn.execute(
            "INSERT INTO conversation_fork_log (fork_id, conversation_id, origin_conversation_id, created_at, created_by) "
            "VALUES (?, ?, ?, ?, ?)",
            (fork_id, to_conversation_id, from_conversation_id, _now(), user_id),
        )
        rows = conn.execute(
            "SELECT request_id, message_id FROM chat_api_conversation_requests WHERE conversation_id = ? AND user_id = ?",
            (from_conversation_id, user_id),
        ).fetchall()
        for r in rows:
            new_message_id = message_id_map.get(r["message_id"])
            if new_message_id is None:
                continue  # a prompt that was not copied (it is past the fork point)
            conn.execute(
                "INSERT INTO chat_api_conversation_requests (conversation_id, request_id, message_id, user_id, logged_at) "
                "VALUES (?, ?, ?, ?, ?)",
                (to_conversation_id, r["request_id"], new_message_id, user_id, _now()),
            )

    await run_in_log_db(db_path, _run)
