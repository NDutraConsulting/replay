import sqlite3
import uuid
from datetime import UTC, datetime

from db.connection import run_in_db
from models.conversation import Conversation


def _now() -> str:
    return datetime.now(UTC).isoformat()


def _row(row: sqlite3.Row) -> Conversation:
    return Conversation(
        conversation_id=row["conversation_id"],
        user_id=row["user_id"],
        is_sample=bool(row["is_sample"]),
        name=row["name"],
        agent_id=row["agent_id"],
        model=row["model"],
        reasoning_level=row["reasoning_level"],
        temperature=row["temperature"],
        kb_summary_tool=bool(row["kb_summary_tool"]),
        brief_replies=bool(row["brief_replies"]),
        source_conversation_id=row["source_conversation_id"],
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )


async def create(
    db_path: str,
    user_id: str,
    *,
    name: str,
    agent_id: str,
    model: str,
    reasoning_level: str = "default",
    kb_summary_tool: bool = False,
    temperature: float = 0.0,
    brief_replies: bool = False,
    sample_messages: list[dict] | None = None,
    source_conversation_id: str | None = None,
    opening: dict | None = None,
) -> Conversation:
    """Create a conversation with its fixed configuration. With `sample_messages` it is the sample conversation
    (is_sample = true). `opening` is a first message ({role, content, message_type, model, agent}) for a conversation
    started by Compact."""
    conversation_id = str(uuid.uuid4())

    def _run(conn: sqlite3.Connection) -> Conversation:
        stamp = _now()
        conn.execute(
            "INSERT INTO conversations (conversation_id, user_id, is_sample, name, agent_id, model, reasoning_level, "
            "kb_summary_tool, source_conversation_id, created_at, updated_at, temperature, brief_replies) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                conversation_id,
                user_id,
                int(sample_messages is not None),
                name,
                agent_id,
                model,
                reasoning_level,
                int(kb_summary_tool),
                source_conversation_id,
                stamp,
                stamp,
                temperature,
                int(brief_replies),
            ),
        )
        if opening is not None:
            conn.execute(
                "INSERT INTO messages (message_id, conversation_id, sequence_number, role, content, status, model, agent, "
                "demo, created_at, message_type) VALUES (?, ?, 1, ?, ?, 'complete', ?, ?, ?, ?, ?)",
                (
                    str(uuid.uuid4()),
                    conversation_id,
                    opening["role"],
                    opening["content"],
                    opening.get("model"),
                    opening.get("agent"),
                    int(opening.get("demo", False)),
                    stamp,
                    opening["message_type"],
                ),
            )
        for number, message in enumerate(sample_messages or [], start=1):
            conn.execute(
                "INSERT INTO messages (message_id, conversation_id, sequence_number, role, content, status, model, agent, demo, created_at) "
                "VALUES (?, ?, ?, ?, ?, 'complete', NULL, NULL, ?, ?)",
                (
                    str(uuid.uuid4()),
                    conversation_id,
                    number,
                    message["role"],
                    message["content"],
                    int(message.get("demo", False)),
                    stamp,
                ),
            )
        return _row(
            conn.execute("SELECT * FROM conversations WHERE conversation_id = ?", (conversation_id,)).fetchone()
        )

    return await run_in_db(db_path, _run)


async def get_owned(db_path: str, user_id: str, conversation_id: str) -> Conversation | None:
    def _run(conn: sqlite3.Connection) -> Conversation | None:
        row = conn.execute(
            "SELECT * FROM conversations WHERE conversation_id = ? AND user_id = ?", (conversation_id, user_id)
        ).fetchone()
        return _row(row) if row else None

    return await run_in_db(db_path, _run)


async def get_latest(db_path: str, user_id: str) -> Conversation | None:
    def _run(conn: sqlite3.Connection) -> Conversation | None:
        row = conn.execute(
            "SELECT * FROM conversations WHERE user_id = ? ORDER BY updated_at DESC, rowid DESC LIMIT 1", (user_id,)
        ).fetchone()
        return _row(row) if row else None

    return await run_in_db(db_path, _run)


async def list_with_prompt_counts(db_path: str, user_id: str) -> list[tuple[Conversation, int]]:
    """The user's conversations, most recently used first, each with how many prompts the user has sent in it."""

    def _run(conn: sqlite3.Connection) -> list[tuple[Conversation, int]]:
        rows = conn.execute(
            "SELECT c.*, (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.conversation_id "
            "AND m.role = 'user' AND m.message_type = 'chat' AND m.status != 'ignored') AS prompt_count "
            "FROM conversations c WHERE c.user_id = ? ORDER BY c.updated_at DESC, c.rowid DESC",
            (user_id,),
        ).fetchall()
        return [(_row(r), r["prompt_count"]) for r in rows]

    return await run_in_db(db_path, _run)


async def touch(db_path: str, conversation_id: str) -> None:
    """Mark a conversation as the one most recently used (it becomes the user's current conversation)."""
    await run_in_db(
        db_path,
        lambda conn: conn.execute(
            "UPDATE conversations SET updated_at = ? WHERE conversation_id = ?", (_now(), conversation_id)
        ),
    )


async def rename(db_path: str, conversation_id: str, name: str) -> None:
    await run_in_db(
        db_path,
        lambda conn: conn.execute(
            "UPDATE conversations SET name = ?, updated_at = ? WHERE conversation_id = ?",
            (name, _now(), conversation_id),
        ),
    )


async def fill_model(db_path: str, conversation_id: str, model: str) -> None:
    """Give an older conversation that never recorded a model its model, once (it is fixed afterwards)."""
    await run_in_db(
        db_path,
        lambda conn: conn.execute(
            "UPDATE conversations SET model = ? WHERE conversation_id = ? AND model = ''", (model, conversation_id)
        ),
    )


async def delete_many(db_path: str, user_id: str, conversation_ids: list[str]) -> int:
    """Delete the user's conversations (their messages go with them). Returns how many were deleted."""
    if not conversation_ids:
        return 0

    def _run(conn: sqlite3.Connection) -> int:
        marks = ", ".join("?" * len(conversation_ids))
        cursor = conn.execute(
            f"DELETE FROM conversations WHERE user_id = ? AND conversation_id IN ({marks})",
            (user_id, *conversation_ids),
        )
        return cursor.rowcount

    return await run_in_db(db_path, _run)
