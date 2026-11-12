import json
import sqlite3
import uuid
from datetime import UTC, datetime, timedelta

from db.connection import run_in_db
from models.replay_run import ReplayResult, ReplayRun


def _now() -> str:
    return datetime.now(UTC).isoformat()


def _run(row: sqlite3.Row) -> ReplayRun:
    return ReplayRun(
        replay_run_id=row["replay_run_id"],
        user_id=row["user_id"],
        agent_id=row["agent_id"],
        prompts=json.loads(row["prompts_json"]),
        model_a=row["model_a"],
        model_b=row["model_b"],
        kb_summary_tool=bool(row["kb_summary_tool"]),
        reasoning_level=row["reasoning_level"],
        temperature=row["temperature"],
        logprobs=bool(row["logprobs"]),
        brief_replies=bool(row["brief_replies"]),
        context_summary=row["context_summary"],
        source_conversation_id=row["source_conversation_id"],
        cursor=row["cursor"],
        stop_requested=bool(row["stop_requested"]),
        step_started_at=row["step_started_at"],
        saved_at=row["saved_at"],
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )


def _result(row: sqlite3.Row) -> ReplayResult:
    trace = row["decision_trace_json"]
    return ReplayResult(
        replay_result_id=row["replay_result_id"],
        replay_run_id=row["replay_run_id"],
        slot=row["slot"],
        turn_index=row["turn_index"],
        content=row["content"],
        model=row["model"],
        demo=bool(row["demo"]),
        error=bool(row["error"]),
        decision_trace=json.loads(trace) if trace else None,
        kb_summary=row["kb_summary"],
        created_at=row["created_at"],
    )


def stale_cutoff(seconds: float) -> str:
    """A step that started before this instant is considered dead (crashed server, lost request)."""
    return (datetime.now(UTC) - timedelta(seconds=seconds)).isoformat()


async def create(
    db_path: str,
    user_id: str,
    agent_id: str,
    prompts: list[str],
    model_a: str,
    model_b: str,
    kb_summary_tool: bool = False,
    reasoning_level: str = "default",
    context_summary: str | None = None,
    source_conversation_id: str | None = None,
    temperature: float = 0.0,
    logprobs: bool = False,
    brief_replies: bool = False,
) -> ReplayRun:
    """Create a run. If the user's previous run has results it is saved first, in the same transaction."""
    run_id = str(uuid.uuid4())

    def _create(conn: sqlite3.Connection) -> ReplayRun:
        conn.execute("BEGIN IMMEDIATE")
        stamp = _now()
        conn.execute(
            "UPDATE replay_runs SET saved_at = COALESCE(saved_at, ?) WHERE user_id = ? AND saved_at IS NULL "
            "AND EXISTS (SELECT 1 FROM replay_results x WHERE x.replay_run_id = replay_runs.replay_run_id)",
            (stamp, user_id),
        )
        conn.execute(
            "INSERT INTO replay_runs (replay_run_id, user_id, agent_id, prompts_json, model_a, model_b, kb_summary_tool, "
            "reasoning_level, context_summary, source_conversation_id, created_at, updated_at, temperature, logprobs, brief_replies) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                run_id,
                user_id,
                agent_id,
                json.dumps(prompts),
                model_a,
                model_b,
                int(kb_summary_tool),
                reasoning_level,
                context_summary,
                source_conversation_id,
                stamp,
                stamp,
                temperature,
                int(logprobs),
                int(brief_replies),
            ),
        )
        return _run(conn.execute("SELECT * FROM replay_runs WHERE replay_run_id = ?", (run_id,)).fetchone())

    return await run_in_db(db_path, _create)


async def get_owned(db_path: str, user_id: str, run_id: str) -> ReplayRun | None:
    def _get(conn: sqlite3.Connection) -> ReplayRun | None:
        row = conn.execute(
            "SELECT * FROM replay_runs WHERE replay_run_id = ? AND user_id = ?", (run_id, user_id)
        ).fetchone()
        return _run(row) if row else None

    return await run_in_db(db_path, _get)


async def get_latest(db_path: str, user_id: str) -> ReplayRun | None:
    def _get(conn: sqlite3.Connection) -> ReplayRun | None:
        row = conn.execute(
            "SELECT * FROM replay_runs WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1", (user_id,)
        ).fetchone()
        return _run(row) if row else None

    return await run_in_db(db_path, _get)


async def list_results(db_path: str, run_id: str) -> list[ReplayResult]:
    def _list(conn: sqlite3.Connection) -> list[ReplayResult]:
        rows = conn.execute(
            "SELECT * FROM replay_results WHERE replay_run_id = ? ORDER BY slot, turn_index", (run_id,)
        ).fetchall()
        return [_result(r) for r in rows]

    return await run_in_db(db_path, _list)


async def update_config(
    db_path: str,
    run_id: str,
    model_a: str,
    model_b: str,
    agent_id: str,
    kb_summary_tool: bool,
    reasoning_level: str,
    temperature: float,
    logprobs: bool,
    brief_replies: bool,
) -> None:
    def _update(conn: sqlite3.Connection) -> None:
        conn.execute(
            "UPDATE replay_runs SET model_a = ?, model_b = ?, agent_id = ?, kb_summary_tool = ?, reasoning_level = ?, "
            "temperature = ?, logprobs = ?, brief_replies = ?, updated_at = ? WHERE replay_run_id = ?",
            (
                model_a,
                model_b,
                agent_id,
                int(kb_summary_tool),
                reasoning_level,
                temperature,
                int(logprobs),
                int(brief_replies),
                _now(),
                run_id,
            ),
        )

    await run_in_db(db_path, _update)


async def save_if_has_results(db_path: str, run_id: str) -> bool:
    """The "Save replay" button. False when the run has no results yet."""

    def _save(conn: sqlite3.Connection) -> bool:
        has = conn.execute("SELECT 1 FROM replay_results WHERE replay_run_id = ? LIMIT 1", (run_id,)).fetchone()
        if not has:
            return False
        conn.execute(
            "UPDATE replay_runs SET saved_at = COALESCE(saved_at, ?) WHERE replay_run_id = ?", (_now(), run_id)
        )
        return True

    return await run_in_db(db_path, _save)


async def claim_step(
    db_path: str, run_id: str, expected_cursor: int, stale_before: str, request_id: str | None = None
) -> str:
    """Atomically take the right to run the next step. Returns:
    "claimed" | "stale" (cursor moved) | "complete" (no prompts left) | "stopped" (a stop naming this request got
    here first) | "busy" (another step is running)."""

    def _claim(conn: sqlite3.Connection) -> str:
        conn.execute("BEGIN IMMEDIATE")
        row = conn.execute("SELECT * FROM replay_runs WHERE replay_run_id = ?", (run_id,)).fetchone()
        if row is None or row["cursor"] != expected_cursor:
            return "stale"
        if row["cursor"] >= len(json.loads(row["prompts_json"])):
            return "complete"
        if request_id:
            consumed = conn.execute(
                "DELETE FROM stop_requests WHERE scope = 'step' AND scope_id = ? AND token = ?", (run_id, request_id)
            )
            if consumed.rowcount:
                return "stopped"
        if row["step_started_at"] is not None and row["step_started_at"] > stale_before:
            return "busy"
        conn.execute(
            "UPDATE replay_runs SET step_started_at = ?, stop_requested = 0, step_request_id = ? WHERE replay_run_id = ?",
            (_now(), request_id, run_id),
        )
        return "claimed"

    return await run_in_db(db_path, _claim)


async def release_step(db_path: str, run_id: str) -> None:
    def _release(conn: sqlite3.Connection) -> None:
        conn.execute(
            "UPDATE replay_runs SET step_started_at = NULL, stop_requested = 0 WHERE replay_run_id = ?", (run_id,)
        )

    await run_in_db(db_path, _release)


async def commit_step(db_path: str, run_id: str, cursor: int, results: list[dict]) -> str:
    """Store both slots' results and advance the cursor in ONE transaction, unless a stop was requested.
    Returns "committed" or "stopped" (nothing stored, cursor unchanged)."""

    def _commit(conn: sqlite3.Connection) -> str:
        conn.execute("BEGIN IMMEDIATE")
        row = conn.execute("SELECT * FROM replay_runs WHERE replay_run_id = ?", (run_id,)).fetchone()
        if row is None:
            return "stopped"
        if row["stop_requested"] or row["cursor"] != cursor:
            conn.execute(
                "UPDATE replay_runs SET step_started_at = NULL, stop_requested = 0 WHERE replay_run_id = ?", (run_id,)
            )
            return "stopped"
        stamp = _now()
        for item in results:
            conn.execute(
                "INSERT INTO replay_results (replay_result_id, replay_run_id, slot, turn_index, content, model, demo, error, "
                "decision_trace_json, kb_summary, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)",
                (
                    str(uuid.uuid4()),
                    run_id,
                    item["slot"],
                    cursor,
                    item["content"],
                    item["model"],
                    int(item["demo"]),
                    item.get("decision_trace_json"),
                    item.get("kb_summary"),
                    stamp,
                ),
            )
        done = cursor + 1 >= len(json.loads(row["prompts_json"]))
        conn.execute(
            "UPDATE replay_runs SET cursor = ?, step_started_at = NULL, stop_requested = 0, updated_at = ?, "
            "saved_at = CASE WHEN ? THEN COALESCE(saved_at, ?) ELSE saved_at END WHERE replay_run_id = ?",
            (cursor + 1, stamp, int(done), stamp, run_id),
        )
        return "committed"

    return await run_in_db(db_path, _commit)


_STOP_MARKER_KEEP_SECONDS = 3600


async def request_stop(db_path: str, run_id: str, stale_before: str, request_id: str | None = None) -> bool:
    """The stop command for a replay step. Idempotent. Returns True if a stop was applied or recorded.

    Without a request_id, the running step (if any) is flagged to be discarded.
    With one, it names a step:
      - that step is running                 -> flag it to be discarded
      - it already finished (or was refused) -> nothing to stop (False)
      - it has not reached the server yet    -> leave a marker; claim_step consumes it on arrival"""

    def _stop(conn: sqlite3.Connection) -> bool:
        conn.execute("BEGIN IMMEDIATE")
        row = conn.execute("SELECT * FROM replay_runs WHERE replay_run_id = ?", (run_id,)).fetchone()
        if row is None:
            return False
        running = row["step_started_at"] is not None and row["step_started_at"] > stale_before
        if request_id is None or row["step_request_id"] == request_id:
            if running:
                conn.execute("UPDATE replay_runs SET stop_requested = 1 WHERE replay_run_id = ?", (run_id,))
            return running
        old = (datetime.now(UTC) - timedelta(seconds=_STOP_MARKER_KEEP_SECONDS)).isoformat()
        conn.execute("DELETE FROM stop_requests WHERE scope = 'step' AND created_at < ?", (old,))
        conn.execute(
            "INSERT OR IGNORE INTO stop_requests (scope, scope_id, token, created_at) VALUES ('step', ?, ?, ?)",
            (run_id, request_id, _now()),
        )
        return True

    return await run_in_db(db_path, _stop)


async def list_saved(db_path: str, user_id: str) -> list[tuple[ReplayRun, dict[str, int]]]:
    """Saved runs (oldest first) with their result counts per slot."""

    def _list(conn: sqlite3.Connection) -> list[tuple[ReplayRun, dict[str, int]]]:
        runs = conn.execute(
            "SELECT * FROM replay_runs WHERE user_id = ? AND saved_at IS NOT NULL ORDER BY created_at, rowid",
            (user_id,),
        ).fetchall()
        out = []
        for row in runs:
            counts = {
                r["slot"]: r["n"]
                for r in conn.execute(
                    "SELECT slot, COUNT(*) AS n FROM replay_results WHERE replay_run_id = ? GROUP BY slot",
                    (row["replay_run_id"],),
                )
            }
            out.append((_run(row), counts))
        return out

    return await run_in_db(db_path, _list)


async def runs_owned(db_path: str, user_id: str, run_ids: list[str]) -> list[str]:
    """The ids among `run_ids` that belong to the user."""
    if not run_ids:
        return []

    def _run(conn: sqlite3.Connection) -> list[str]:
        marks = ", ".join("?" * len(run_ids))
        rows = conn.execute(
            f"SELECT replay_run_id FROM replay_runs WHERE user_id = ? AND replay_run_id IN ({marks})",
            (user_id, *run_ids),
        ).fetchall()
        return [r[0] for r in rows]

    return await run_in_db(db_path, _run)


async def delete_many(db_path: str, user_id: str, run_ids: list[str]) -> int:
    """Delete the user's replay runs (their results go with them). Returns how many were deleted."""
    if not run_ids:
        return 0

    def _run(conn: sqlite3.Connection) -> int:
        marks = ", ".join("?" * len(run_ids))
        return conn.execute(
            f"DELETE FROM replay_runs WHERE user_id = ? AND replay_run_id IN ({marks})", (user_id, *run_ids)
        ).rowcount

    return await run_in_db(db_path, _run)
