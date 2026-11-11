import sqlite3
import uuid
from datetime import UTC, datetime, timedelta

from db.connection import run_in_db
from models.conversation import Message


def _now() -> str:
    return datetime.now(UTC).isoformat()


def _row(row: sqlite3.Row) -> Message:
    return Message(
        message_id=row["message_id"],
        conversation_id=row["conversation_id"],
        sequence_number=row["sequence_number"],
        role=row["role"],
        content=row["content"],
        status=row["status"],
        model=row["model"],
        agent=row["agent"],
        demo=bool(row["demo"]),
        created_at=row["created_at"],
        request_id=row["request_id"],
        message_type=row["message_type"],
        kb_version_id=row["kb_version_id"],
        kb_label=row["kb_label"],
    )


def _insert(
    conn: sqlite3.Connection,
    conversation_id: str,
    role: str,
    content: str,
    status: str,
    model: str | None = None,
    agent: str | None = None,
    demo: bool = False,
    request_id: str | None = None,
    message_type: str = "chat",
    kb_version_id: str | None = None,
    kb_label: str | None = None,
) -> Message:
    sequence = conn.execute(
        "SELECT COALESCE(MAX(sequence_number), 0) + 1 FROM messages WHERE conversation_id = ?", (conversation_id,)
    ).fetchone()[0]
    message_id = str(uuid.uuid4())
    conn.execute(
        "INSERT INTO messages (message_id, conversation_id, sequence_number, role, content, status, model, agent, demo, "
        "created_at, request_id, message_type, kb_version_id, kb_label) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (
            message_id,
            conversation_id,
            sequence,
            role,
            content,
            status,
            model,
            agent,
            int(demo),
            _now(),
            request_id,
            message_type,
            kb_version_id,
            kb_label,
        ),
    )
    conn.execute("UPDATE conversations SET updated_at = ? WHERE conversation_id = ?", (_now(), conversation_id))
    return _row(conn.execute("SELECT * FROM messages WHERE message_id = ?", (message_id,)).fetchone())


async def list_visible(db_path: str, conversation_id: str) -> list[Message]:
    """The turns the user sees, in order: every message except `ignored` ones and the internal knowledge base rows."""

    def _run(conn: sqlite3.Connection) -> list[Message]:
        rows = conn.execute(
            "SELECT * FROM messages WHERE conversation_id = ? AND status != 'ignored' "
            "AND message_type IN ('chat', 'compacted_summary') ORDER BY sequence_number",
            (conversation_id,),
        ).fetchall()
        return [_row(r) for r in rows]

    return await run_in_db(db_path, _run)


async def list_internal(db_path: str, conversation_id: str) -> list[Message]:
    """The internal knowledge base rows (kb_reference, kb_summary_tool), in order. They carry the request id of the
    prompt they belong to; the history builder attaches them to it."""

    def _run(conn: sqlite3.Connection) -> list[Message]:
        rows = conn.execute(
            "SELECT * FROM messages WHERE conversation_id = ? AND status != 'ignored' "
            "AND message_type IN ('kb_reference', 'kb_summary_tool') ORDER BY sequence_number",
            (conversation_id,),
        ).fetchall()
        return [_row(r) for r in rows]

    return await run_in_db(db_path, _run)


async def add_kb_row(
    db_path: str,
    conversation_id: str,
    request_id: str,
    message_type: str,
    content: str,
    kb_version_id: str,
    kb_label: str,
) -> None:
    """Record, by reference, which version of a file a turn was answered with (kb_reference: `content` is only the
    label, never the file's text) or the summary that was sent instead of it (kb_summary_tool: `content` is the
    summary). One per prompt: an earlier row for the same prompt is replaced."""

    def _run(conn: sqlite3.Connection) -> None:
        conn.execute(
            "DELETE FROM messages WHERE conversation_id = ? AND request_id = ? AND message_type IN ('kb_reference', 'kb_summary_tool')",
            (conversation_id, request_id),
        )
        _insert(
            conn,
            conversation_id,
            "user",
            content,
            "complete",
            request_id=request_id,
            message_type=message_type,
            kb_version_id=kb_version_id,
            kb_label=kb_label,
        )

    await run_in_db(db_path, _run)


async def delete_kb_rows(db_path: str, conversation_id: str, request_id: str) -> None:
    """Forget a turn's file reference (the turn was stopped or failed: its file must not be re-sent later)."""
    await run_in_db(
        db_path,
        lambda conn: conn.execute(
            "DELETE FROM messages WHERE conversation_id = ? AND request_id = ? AND message_type IN ('kb_reference', 'kb_summary_tool')",
            (conversation_id, request_id),
        ),
    )


async def conversations_using(db_path: str, user_id: str, version_ids: list[str]) -> list[str]:
    """The user's conversations that have a turn answered with any of these file versions."""
    if not version_ids:
        return []

    def _run(conn: sqlite3.Connection) -> list[str]:
        marks = ", ".join("?" * len(version_ids))
        rows = conn.execute(
            f"SELECT DISTINCT m.conversation_id FROM messages m JOIN conversations c ON c.conversation_id = m.conversation_id "
            f"WHERE c.user_id = ? AND m.kb_version_id IN ({marks})",
            (user_id, *version_ids),
        ).fetchall()
        return [r[0] for r in rows]

    return await run_in_db(db_path, _run)


async def answered_request_ids(db_path: str, conversation_id: str) -> list[str]:
    """Request ids of the conversation's answered prompts (status `complete`), oldest first."""

    def _run(conn: sqlite3.Connection) -> list[str]:
        rows = conn.execute(
            "SELECT request_id FROM messages WHERE conversation_id = ? AND role = 'user' AND status = 'complete' "
            "AND message_type = 'chat' AND request_id IS NOT NULL ORDER BY sequence_number",
            (conversation_id,),
        ).fetchall()
        return [r["request_id"] for r in rows]

    return await run_in_db(db_path, _run)


async def user_prompts(db_path: str, conversation_id: str) -> list[str]:
    def _run(conn: sqlite3.Connection) -> list[str]:
        rows = conn.execute(
            "SELECT content FROM messages WHERE conversation_id = ? AND role = 'user' AND message_type = 'chat' "
            "ORDER BY sequence_number",
            (conversation_id,),
        ).fetchall()
        return [r["content"] for r in rows]

    return await run_in_db(db_path, _run)


async def count_user_prompts(db_path: str, conversation_id: str) -> int:
    """How many prompts the user has in this conversation (the ones it shows: a removed or ignored one does not count)."""

    def _run(conn: sqlite3.Connection) -> int:
        return conn.execute(
            "SELECT COUNT(*) FROM messages WHERE conversation_id = ? AND role = 'user' AND message_type = 'chat' "
            "AND status != 'ignored'",
            (conversation_id,),
        ).fetchone()[0]

    return await run_in_db(db_path, _run)


async def begin_turn(
    db_path: str, conversation_id: str, content: str, request_id: str | None = None
) -> tuple[Message, bool]:
    """Store the user's message before the model is called, so it survives any failure.

    Returns (message, already_stopped). The message is `pending`, unless the user's stop command for this
    request_id got here first: then it is stored as `stopped` and the model must not be called.
    A previous message still `pending` can only be left over from an interrupted request; mark it failed."""

    def _run(conn: sqlite3.Connection) -> tuple[Message, bool]:
        conn.execute("BEGIN IMMEDIATE")
        conn.execute(
            "UPDATE messages SET status = 'failed' WHERE conversation_id = ? AND role = 'user' AND status = 'pending'",
            (conversation_id,),
        )
        conn.execute("UPDATE conversations SET is_sample = 0 WHERE conversation_id = ?", (conversation_id,))
        stopped = False
        if request_id:
            consumed = conn.execute(
                "DELETE FROM stop_requests WHERE scope = 'message' AND scope_id = ? AND token = ?",
                (conversation_id, request_id),
            )
            stopped = consumed.rowcount > 0
        message = _insert(
            conn, conversation_id, "user", content, "stopped" if stopped else "pending", request_id=request_id
        )
        return message, stopped

    return await run_in_db(db_path, _run)


async def finish_reply(
    db_path: str, conversation_id: str, user_message_id: str, content: str, model: str, agent: str, demo: bool
) -> tuple[str, Message | None, Message | None]:
    """Store the model's reply, deciding by the user message's *current* status in one transaction.

    Returns (outcome, user_message, assistant_message):
      "complete" - the prompt was still pending: user message -> complete, reply stored as complete
      "ignored"  - the user sent a stop first (or the prompt was superseded): reply stored as `ignored`
      "gone"     - the prompt no longer exists (rewound): nothing stored
    """

    def _run(conn: sqlite3.Connection) -> tuple[str, Message | None, Message | None]:
        conn.execute("BEGIN IMMEDIATE")
        row = conn.execute("SELECT * FROM messages WHERE message_id = ?", (user_message_id,)).fetchone()
        if row is None:
            return "gone", None, None
        if row["status"] == "pending":
            conn.execute("UPDATE messages SET status = 'complete' WHERE message_id = ?", (user_message_id,))
            reply = _insert(conn, conversation_id, "assistant", content, "complete", model, agent, demo)
            user = _row(conn.execute("SELECT * FROM messages WHERE message_id = ?", (user_message_id,)).fetchone())
            return "complete", user, reply
        reply = _insert(conn, conversation_id, "assistant", content, "ignored", model, agent, demo)
        return "ignored", _row(row), reply

    return await run_in_db(db_path, _run)


async def mark_failed(db_path: str, user_message_id: str) -> str | None:
    """pending -> failed. Returns the message's resulting status (e.g. `stopped` if the user got there first)."""

    def _run(conn: sqlite3.Connection) -> str | None:
        conn.execute("BEGIN IMMEDIATE")
        conn.execute(
            "UPDATE messages SET status = 'failed' WHERE message_id = ? AND status = 'pending'", (user_message_id,)
        )
        row = conn.execute("SELECT status FROM messages WHERE message_id = ?", (user_message_id,)).fetchone()
        return row["status"] if row else None

    return await run_in_db(db_path, _run)


_STOP_MARKER_KEEP_SECONDS = 3600


async def stop(db_path: str, conversation_id: str, request_id: str | None = None) -> bool:
    """The stop command. Idempotent. Returns True if a stop was applied or recorded.

    With a request_id it names one send:
      - that send's prompt is still pending            -> mark it `stopped`
      - it was already answered, failed or stopped      -> nothing to stop (False)
      - it has not reached the server yet               -> leave a marker; begin_turn consumes it on arrival
    Without one, the conversation's latest pending prompt is stopped."""

    def _run(conn: sqlite3.Connection) -> bool:
        conn.execute("BEGIN IMMEDIATE")
        if request_id is None:
            cursor = conn.execute(
                "UPDATE messages SET status = 'stopped' WHERE status = 'pending' AND message_id = ("
                "SELECT message_id FROM messages WHERE conversation_id = ? AND role = 'user' AND message_type = 'chat' "
                "ORDER BY sequence_number DESC LIMIT 1)",
                (conversation_id,),
            )
            return cursor.rowcount > 0
        cursor = conn.execute(
            "UPDATE messages SET status = 'stopped' WHERE conversation_id = ? AND request_id = ? AND status = 'pending'",
            (conversation_id, request_id),
        )
        if cursor.rowcount:
            return True
        if conn.execute(
            "SELECT 1 FROM messages WHERE conversation_id = ? AND request_id = ?", (conversation_id, request_id)
        ).fetchone():
            return False
        old = (datetime.now(UTC) - timedelta(seconds=_STOP_MARKER_KEEP_SECONDS)).isoformat()
        conn.execute("DELETE FROM stop_requests WHERE scope = 'message' AND created_at < ?", (old,))
        conn.execute(
            "INSERT OR IGNORE INTO stop_requests (scope, scope_id, token, created_at) VALUES ('message', ?, ?, ?)",
            (conversation_id, request_id, _now()),
        )
        return True

    return await run_in_db(db_path, _run)


async def rewind(db_path: str, conversation_id: str) -> tuple[str, list[str]] | None:
    """Delete the last user message and everything after it.
    Returns (the removed prompt, the request ids of the removed prompts), or None when there is no prompt."""

    def _run(conn: sqlite3.Connection) -> tuple[str, list[str]] | None:
        conn.execute("BEGIN IMMEDIATE")
        row = conn.execute(
            "SELECT sequence_number, content FROM messages WHERE conversation_id = ? AND role = 'user' "
            "AND message_type = 'chat' ORDER BY sequence_number DESC LIMIT 1",
            (conversation_id,),
        ).fetchone()
        if row is None:
            return None
        removed = conn.execute(
            "SELECT DISTINCT request_id FROM messages WHERE conversation_id = ? AND sequence_number >= ? AND request_id IS NOT NULL",
            (conversation_id, row["sequence_number"]),
        ).fetchall()
        conn.execute(
            "DELETE FROM messages WHERE conversation_id = ? AND sequence_number >= ?",
            (conversation_id, row["sequence_number"]),
        )
        conn.execute(
            "UPDATE conversations SET is_sample = 0, updated_at = ? WHERE conversation_id = ?",
            (_now(), conversation_id),
        )
        return row["content"], [r["request_id"] for r in removed]

    return await run_in_db(db_path, _run)
