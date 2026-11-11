"""The raw REST-call log (Log.db): what was sent to the model provider while a replay result was produced."""

import json
import sqlite3
from datetime import UTC, datetime

from db.connection import run_in_db


def _now() -> str:
    return datetime.now(UTC).isoformat()


async def record_turn(db_path: str, user_id: str, run_id: str, slot: str, turn_index: int, calls: list[dict]) -> None:
    """Keep one turn's calls, in order, in ONE transaction. The turn is marked as logged even when `calls` is empty
    (demo mode makes none). Logging the same turn again replaces what was kept."""

    def _run(conn: sqlite3.Connection) -> None:
        conn.execute(
            "DELETE FROM api_calls WHERE replay_run_id = ? AND slot = ? AND turn_index = ?", (run_id, slot, turn_index)
        )
        conn.execute(
            "INSERT OR REPLACE INTO api_log_turns (replay_run_id, slot, turn_index, user_id, logged_at) "
            "VALUES (?, ?, ?, ?, ?)",
            (run_id, slot, turn_index, user_id, _now()),
        )
        for seq, call in enumerate(calls):
            response = call.get("response")
            conn.execute(
                "INSERT INTO api_calls (replay_run_id, slot, turn_index, seq, user_id, purpose, method, url, "
                "request_headers_json, request_body_json, response_status, response_body, response_truncated, error, "
                "duration_ms, called_at, settings_json, logprobs_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    run_id,
                    slot,
                    turn_index,
                    seq,
                    user_id,
                    call["purpose"],
                    call["method"],
                    call["url"],
                    json.dumps(call["request"]["headers"]),
                    json.dumps(call["request"]["body"]),
                    response["status"] if response else None,
                    response["body"] if response else None,
                    int(bool(response and response.get("truncated"))),
                    call.get("error"),
                    int(call.get("duration_ms") or 0),
                    call["at"],
                    json.dumps(call["settings"]) if call.get("settings") is not None else None,
                    json.dumps(call["logprobs"]) if call.get("logprobs") else None,
                ),
            )

    await run_in_db(db_path, _run)


async def turns_for(db_path: str, user_id: str, run_id: str, slot: str) -> dict[int, list[dict]]:
    """The logged turns of one slot: {turn_index: [call, ...]} in call order. A turn that was never logged is absent."""

    def _run(conn: sqlite3.Connection) -> dict[int, list[dict]]:
        turns: dict[int, list[dict]] = {
            r["turn_index"]: []
            for r in conn.execute(
                "SELECT turn_index FROM api_log_turns WHERE replay_run_id = ? AND slot = ? AND user_id = ? "
                "ORDER BY turn_index",
                (run_id, slot, user_id),
            )
        }
        rows = conn.execute(
            "SELECT * FROM api_calls WHERE replay_run_id = ? AND slot = ? AND user_id = ? ORDER BY turn_index, seq",
            (run_id, slot, user_id),
        ).fetchall()
        for r in rows:
            turns.setdefault(r["turn_index"], []).append(
                {
                    "at": r["called_at"],
                    "purpose": r["purpose"],
                    "method": r["method"],
                    "url": r["url"],
                    "duration_ms": r["duration_ms"],
                    "request": {
                        "headers": json.loads(r["request_headers_json"]),
                        "body": json.loads(r["request_body_json"]),
                    },
                    "response": None
                    if r["response_status"] is None
                    else {
                        "status": r["response_status"],
                        "body": r["response_body"] or "",
                        "truncated": bool(r["response_truncated"]),
                    },
                    "error": r["error"],
                    "settings": json.loads(r["settings_json"]) if r["settings_json"] else None,
                }
            )
        return turns

    return await run_in_db(db_path, _run)


async def answer_logprobs(db_path: str, user_id: str, run_id: str, slot: str) -> dict[int, list[dict] | None]:
    """Each logged turn's answer tokens with their log probabilities: {turn_index: [{token, logprob}, ...]}. None for a
    turn whose answer call did not return them. A turn that was never logged is absent."""

    def _run(conn: sqlite3.Connection) -> dict[int, list[dict] | None]:
        turns: dict[int, list[dict] | None] = {
            r["turn_index"]: None
            for r in conn.execute(
                "SELECT turn_index FROM api_log_turns WHERE replay_run_id = ? AND slot = ? AND user_id = ?",
                (run_id, slot, user_id),
            )
        }
        rows = conn.execute(
            "SELECT turn_index, logprobs_json FROM api_calls WHERE replay_run_id = ? AND slot = ? AND user_id = ? "
            "AND purpose = 'answer' AND logprobs_json IS NOT NULL ORDER BY turn_index, seq",
            (run_id, slot, user_id),
        ).fetchall()
        for r in rows:  # the last answer call of a turn wins (an earlier one may have been a refused attempt)
            turns[r["turn_index"]] = json.loads(r["logprobs_json"])
        return turns

    return await run_in_db(db_path, _run)


async def delete_runs(db_path: str, user_id: str, run_ids: list[str]) -> None:
    """Forget the logs of replay runs that were deleted (Log.db has no foreign keys to cascade from app.db)."""
    if not run_ids:
        return

    def _run(conn: sqlite3.Connection) -> None:
        marks = ", ".join("?" * len(run_ids))
        for table in ("api_calls", "api_log_turns"):
            conn.execute(f"DELETE FROM {table} WHERE user_id = ? AND replay_run_id IN ({marks})", (user_id, *run_ids))

    await run_in_db(db_path, _run)
