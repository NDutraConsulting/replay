"""The raw REST-call log of the Chat page (Log.db): what was sent to the model provider to answer each prompt."""

import sqlite3
from datetime import UTC, datetime

from db.connection import run_in_db
from repositories.api_log_repository import call_from_row, call_values


def _now() -> str:
    return datetime.now(UTC).isoformat()


async def record_request(db_path: str, user_id: str, conversation_id: str, request_id: str, calls: list[dict]) -> None:
    """Keep the calls made for one prompt, in order, in ONE transaction. The prompt is marked as logged even when `calls`
    is empty (demo mode makes none). Logging the same request id again replaces what was kept."""

    def _run(conn: sqlite3.Connection) -> None:
        conn.execute("DELETE FROM chat_api_calls WHERE request_id = ?", (request_id,))
        conn.execute(
            "INSERT OR REPLACE INTO chat_api_requests (request_id, conversation_id, user_id, logged_at) "
            "VALUES (?, ?, ?, ?)",
            (request_id, conversation_id, user_id, _now()),
        )
        for seq, call in enumerate(calls):
            conn.execute(
                "INSERT INTO chat_api_calls (request_id, conversation_id, seq, user_id, purpose, method, url, "
                "request_headers_json, request_body_json, response_status, response_body, response_truncated, error, "
                "duration_ms, called_at, settings_json, logprobs_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (request_id, conversation_id, seq, user_id, *call_values(call)),
            )

    await run_in_db(db_path, _run)


async def for_conversation(db_path: str, user_id: str, conversation_id: str) -> dict[str, list[dict]]:
    """The logged calls of a conversation: {request_id: [call, ...]} in call order. A prompt that was never logged is
    absent."""

    def _run(conn: sqlite3.Connection) -> dict[str, list[dict]]:
        logged: dict[str, list[dict]] = {
            r["request_id"]: []
            for r in conn.execute(
                "SELECT request_id FROM chat_api_requests WHERE conversation_id = ? AND user_id = ?",
                (conversation_id, user_id),
            )
        }
        rows = conn.execute(
            "SELECT * FROM chat_api_calls WHERE conversation_id = ? AND user_id = ? ORDER BY request_id, seq",
            (conversation_id, user_id),
        ).fetchall()
        for r in rows:
            logged.setdefault(r["request_id"], []).append(call_from_row(r))
        return logged

    return await run_in_db(db_path, _run)


async def delete_requests(db_path: str, user_id: str, request_ids: list[str]) -> None:
    """Forget the calls of prompts that were rewound (Log.db has no foreign keys to cascade from app.db)."""
    if not request_ids:
        return

    def _run(conn: sqlite3.Connection) -> None:
        marks = ", ".join("?" * len(request_ids))
        for table in ("chat_api_calls", "chat_api_requests"):
            conn.execute(f"DELETE FROM {table} WHERE user_id = ? AND request_id IN ({marks})", (user_id, *request_ids))

    await run_in_db(db_path, _run)
