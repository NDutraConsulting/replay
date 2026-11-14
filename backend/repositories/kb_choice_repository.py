"""knowledge_base_choice (in knowledgebase.db): what each agent was offered at every routing level and what it selected.

One row per level, up to three per answer. A chat answer is keyed by the send's request id; a replay result by
"{slot}:{turn_index}". The assembled list of steps is what the API returns as `decision_trace`.
"""

import json
import sqlite3
import uuid
from datetime import UTC, datetime

from db.connection import run_in_db

# A choice row, with the number of the file version it pointed at (NULL once that version has been deleted).
_SELECT = (
    "SELECT c.*, v.version_number AS version_number FROM knowledge_base_choice c "
    "LEFT JOIN kb_document_versions v ON v.version_id = c.document_version_id"
)


def _step(row: sqlite3.Row) -> dict:
    chosen = {"id": row["chosen_id"], "name": row["chosen_name"]} if row["outcome"] == "chosen" else None
    version_id = row["document_version_id"]
    return {
        "version_id": version_id,
        "version_number": row["version_number"],
        "kb_version_deleted": bool(version_id) and row["version_number"] is None,
        "step": row["level"],
        "options": json.loads(row["options_json"]),
        "chosen": chosen,
        "model": row["model"],
        "reason": row["reason"],
        "outcome": row["outcome"],
        "at": row["created_at"],
    }


async def record_path(
    db_path: str, user_id: str, agent_id: str, scope: str, scope_id: str, ref: str, steps: list[dict]
) -> None:
    """Store one answer's whole path. Anything recorded earlier for the same answer is replaced, so a retry can
    never leave steps of an older attempt behind."""

    def _run(conn: sqlite3.Connection) -> None:
        conn.execute("BEGIN IMMEDIATE")
        conn.execute(
            "DELETE FROM knowledge_base_choice WHERE scope = ? AND scope_id = ? AND ref = ?", (scope, scope_id, ref)
        )
        for number, step in enumerate(steps, start=1):
            chosen = step["chosen"] or {}
            conn.execute(
                "INSERT INTO knowledge_base_choice (choice_id, user_id, agent_id, scope, scope_id, ref, step_number, level, "
                "model, options_json, chosen_id, chosen_name, reason, outcome, created_at, document_version_id) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    str(uuid.uuid4()),
                    user_id,
                    agent_id,
                    scope,
                    scope_id,
                    ref,
                    number,
                    step["step"],
                    step.get("model"),
                    json.dumps(step["options"]),
                    chosen.get("id"),
                    chosen.get("name"),
                    step.get("reason"),
                    step["outcome"],
                    step.get("at") or datetime.now(UTC).isoformat(),
                    step.get("version_id"),
                ),
            )

    await run_in_db(db_path, _run)


async def trace_for_chat(
    db_path: str, user_id: str, conversation_id: str, request_ids: list[str]
) -> dict[str, list[dict]]:
    """{request_id: [steps]} for the given sends of a conversation."""
    if not request_ids:
        return {}

    def _run(conn: sqlite3.Connection) -> dict[str, list[dict]]:
        marks = ", ".join("?" * len(request_ids))
        rows = conn.execute(
            f"{_SELECT} WHERE c.user_id = ? AND c.scope = 'chat' AND c.scope_id = ? "
            f"AND c.ref IN ({marks}) ORDER BY c.ref, c.step_number",
            (user_id, conversation_id, *request_ids),
        ).fetchall()
        out: dict[str, list[dict]] = {}
        for row in rows:
            out.setdefault(row["ref"], []).append(_step(row))
        return out

    return await run_in_db(db_path, _run)


async def trace_for_replay(db_path: str, user_id: str, run_id: str) -> dict[tuple[str, int], list[dict]]:
    """{(slot, turn_index): [steps]} for a replay run."""

    def _run(conn: sqlite3.Connection) -> dict[tuple[str, int], list[dict]]:
        rows = conn.execute(
            f"{_SELECT} WHERE c.user_id = ? AND c.scope = 'replay' AND c.scope_id = ? ORDER BY c.ref, c.step_number",
            (user_id, run_id),
        ).fetchall()
        out: dict[tuple[str, int], list[dict]] = {}
        for row in rows:
            slot, _, turn = row["ref"].partition(":")
            out.setdefault((slot, int(turn)), []).append(_step(row))
        return out

    return await run_in_db(db_path, _run)


def _latest_with_a_selection(by_ref: dict[str, list[dict]], order: list[str]) -> list[dict] | None:
    for ref in order:  # newest first
        steps = by_ref[ref]
        if any(s["outcome"] == "chosen" for s in steps):
            return steps
    return None


async def last_chat_path(
    db_path: str, user_id: str, conversation_id: str, answered_request_ids: list[str]
) -> list[dict] | None:
    """The newest recorded path (with at least one selection) among the conversation's ANSWERED sends. A prompt that
    was stopped or failed does not count: the agent never saw it through."""
    traces = await trace_for_chat(db_path, user_id, conversation_id, answered_request_ids)
    order = sorted(traces, key=lambda ref: traces[ref][0]["at"], reverse=True)
    return _latest_with_a_selection(traces, order)


async def last_replay_path(db_path: str, user_id: str, run_id: str, slot: str) -> list[dict] | None:
    """The newest recorded path for one slot of a replay run (only committed turns are ever recorded)."""
    traces = await trace_for_replay(db_path, user_id, run_id)
    turns = sorted((turn for (s, turn) in traces if s == slot), reverse=True)
    by_ref = {str(turn): traces[(slot, turn)] for turn in turns}
    return _latest_with_a_selection(by_ref, [str(t) for t in turns])


async def replay_runs_using(db_path: str, user_id: str, version_ids: list[str]) -> list[str]:
    """The user's replay runs that have an answer given with any of these file versions."""
    if not version_ids:
        return []

    def _run(conn: sqlite3.Connection) -> list[str]:
        marks = ", ".join("?" * len(version_ids))
        rows = conn.execute(
            f"SELECT DISTINCT scope_id FROM knowledge_base_choice WHERE user_id = ? AND scope = 'replay' "
            f"AND document_version_id IN ({marks})",
            (user_id, *version_ids),
        ).fetchall()
        return [r[0] for r in rows]

    return await run_in_db(db_path, _run)


async def delete_scope(db_path: str, user_id: str, scope: str, scope_ids: list[str]) -> None:
    """Forget every choice recorded for these conversations (scope 'chat') or replay runs (scope 'replay')."""
    if not scope_ids:
        return

    def _run(conn: sqlite3.Connection) -> None:
        marks = ", ".join("?" * len(scope_ids))
        conn.execute(
            f"DELETE FROM knowledge_base_choice WHERE user_id = ? AND scope = ? AND scope_id IN ({marks})",
            (user_id, scope, *scope_ids),
        )

    await run_in_db(db_path, _run)


async def copy_chat(
    db_path: str, user_id: str, from_conversation_id: str, to_conversation_id: str, request_ids: list[str]
) -> None:
    """A conversation was forked: give the fork its own copy of the choices recorded for the copied prompts (same request
    ids, new conversation id), so the decision trace of each copied answer shows in the fork. One transaction."""
    if not request_ids:
        return

    def _run(conn: sqlite3.Connection) -> None:
        marks = ", ".join("?" * len(request_ids))
        rows = conn.execute(
            f"SELECT * FROM knowledge_base_choice WHERE user_id = ? AND scope = 'chat' AND scope_id = ? AND ref IN ({marks})",
            (user_id, from_conversation_id, *request_ids),
        ).fetchall()
        for r in rows:
            conn.execute(
                "INSERT INTO knowledge_base_choice (choice_id, user_id, agent_id, scope, scope_id, ref, step_number, level, "
                "model, options_json, chosen_id, chosen_name, reason, outcome, created_at, document_version_id) "
                "VALUES (?, ?, ?, 'chat', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    str(uuid.uuid4()),
                    r["user_id"],
                    r["agent_id"],
                    to_conversation_id,
                    r["ref"],
                    r["step_number"],
                    r["level"],
                    r["model"],
                    r["options_json"],
                    r["chosen_id"],
                    r["chosen_name"],
                    r["reason"],
                    r["outcome"],
                    r["created_at"],
                    r["document_version_id"],
                ),
            )

    await run_in_db(db_path, _run)
