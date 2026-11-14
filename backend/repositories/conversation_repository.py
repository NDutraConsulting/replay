import sqlite3
import uuid
from datetime import UTC, datetime

from db.connection import run_in_db
from models.conversation import Conversation
from repositories.conversation_errors import PromptInProgress


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
        locked_at=row["locked_at"],
        lock_reason=row["lock_reason"],
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


async def lock(db_path: str, conversation_id: str, reason: str) -> bool:
    """Lock a conversation. Returns whether this call locked it (False: it was already locked, which is not an error).
    A lock the user asks for is refused with PromptInProgress while a prompt is still waiting for its reply. The lock
    leaves `updated_at` alone: `get_latest` orders by it, and locking must not change which conversation is current."""

    def _run(conn: sqlite3.Connection) -> bool:
        conn.execute("BEGIN IMMEDIATE")
        if (
            reason == "user"
            and conn.execute(
                "SELECT 1 FROM messages WHERE conversation_id = ? AND role = 'user' AND status = 'pending'",
                (conversation_id,),
            ).fetchone()
        ):
            raise PromptInProgress
        cursor = conn.execute(
            "UPDATE conversations SET locked_at = ?, lock_reason = ? WHERE conversation_id = ? AND locked_at IS NULL",
            (_now(), reason, conversation_id),
        )
        return cursor.rowcount > 0

    return await run_in_db(db_path, _run)


async def fork(
    db_path: str, user_id: str, source: Conversation, name: str, through_sequence: int | None = None
) -> tuple[Conversation, dict[str, str], str]:
    """Copy a conversation into a NEW one (new conversation id) in ONE transaction: the same fixed settings, and every
    message of the source up to and including `through_sequence` (all of them when None), except `ignored` ones. The
    copied messages get new ids but keep their order, their sequence numbers, request ids, statuses, types and knowledge
    base fields, so a conversation can be deleted without touching its fork. The fork is unlocked and is the most recently
    updated conversation, so it becomes the current one. Refused (PromptInProgress) while a prompt in the copied range
    is still waiting for its reply.

    The fork is recorded in `conversation_forks` in the same transaction (a fork that has no row cannot exist).

    Returns (the fork, {source message id: fork message id}, the fork's `fork_id`). The knowledge base choices
    (knowledgebase.db) and the API-log rows (Log.db) live in other database files: the service copies those afterwards."""
    conversation_id = str(uuid.uuid4())
    fork_id = str(uuid.uuid4())

    def _run(conn: sqlite3.Connection) -> tuple[Conversation, dict[str, str], str]:
        conn.execute("BEGIN IMMEDIATE")
        limit = through_sequence if through_sequence is not None else 2**62
        if conn.execute(
            "SELECT 1 FROM messages WHERE conversation_id = ? AND role = 'user' AND status = 'pending' "
            "AND sequence_number <= ?",
            (source.conversation_id, limit),
        ).fetchone():
            raise PromptInProgress
        stamp = _now()
        conn.execute(
            "INSERT INTO conversations (conversation_id, user_id, is_sample, name, agent_id, model, reasoning_level, "
            "kb_summary_tool, source_conversation_id, created_at, updated_at, temperature, brief_replies) "
            "VALUES (?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                conversation_id,
                user_id,
                name,
                source.agent_id,
                source.model,
                source.reasoning_level,
                int(source.kb_summary_tool),
                source.source_conversation_id,  # a fork of a Compact chat keeps its summary, so it keeps the link too
                stamp,
                stamp,
                source.temperature,
                int(source.brief_replies),
            ),
        )
        conn.execute(
            "INSERT INTO conversation_forks (fork_id, conversation_id, origin_conversation_id, created_at, created_by) "
            "VALUES (?, ?, ?, ?, ?)",
            (fork_id, conversation_id, source.conversation_id, stamp, user_id),
        )
        mapping: dict[str, str] = {}
        rows = conn.execute(
            "SELECT * FROM messages WHERE conversation_id = ? AND status != 'ignored' AND sequence_number <= ? "
            "ORDER BY sequence_number",
            (source.conversation_id, limit),
        ).fetchall()
        for m in rows:
            new_id = str(uuid.uuid4())
            mapping[m["message_id"]] = new_id
            conn.execute(
                "INSERT INTO messages (message_id, conversation_id, sequence_number, role, content, status, model, "
                "agent, demo, created_at, request_id, message_type, kb_version_id, kb_label) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    new_id,
                    conversation_id,
                    m["sequence_number"],
                    m["role"],
                    m["content"],
                    m["status"],
                    m["model"],
                    m["agent"],
                    m["demo"],
                    m["created_at"],
                    m["request_id"],
                    m["message_type"],
                    m["kb_version_id"],
                    m["kb_label"],
                ),
            )
        created = _row(
            conn.execute("SELECT * FROM conversations WHERE conversation_id = ?", (conversation_id,)).fetchone()
        )
        return created, mapping, fork_id

    return await run_in_db(db_path, _run)


async def undo_fork(db_path: str, user_id: str, conversation_id: str) -> None:
    """Take back a fork whose other copies failed: the conversation (its messages go with it) AND its fork row. Deleting a
    conversation any other way keeps its fork rows (they are plain ids, so lineage outlives a deletion); a fork that never
    finished is not lineage, so this removes the row too."""

    def _run(conn: sqlite3.Connection) -> None:
        conn.execute(
            "DELETE FROM conversation_forks WHERE conversation_id = ? AND created_by = ?", (conversation_id, user_id)
        )
        conn.execute("DELETE FROM conversations WHERE conversation_id = ? AND user_id = ?", (conversation_id, user_id))

    await run_in_db(db_path, _run)


async def forks_for(db_path: str, created_by: str, conversation_ids: list[str]) -> dict[str, str]:
    """{fork conversation id: the conversation it was forked from} for those of `conversation_ids` that are forks and were
    forked by this user. One query for the whole list."""
    if not conversation_ids:
        return {}

    def _run(conn: sqlite3.Connection) -> dict[str, str]:
        marks = ", ".join("?" * len(conversation_ids))
        rows = conn.execute(
            f"SELECT conversation_id, origin_conversation_id FROM conversation_forks "
            f"WHERE created_by = ? AND conversation_id IN ({marks})",
            (created_by, *conversation_ids),
        ).fetchall()
        return {r["conversation_id"]: r["origin_conversation_id"] for r in rows}

    return await run_in_db(db_path, _run)


async def delete_one(db_path: str, user_id: str, conversation_id: str) -> bool:
    """Delete one of the user's conversations: its messages go with it (cascade), replay runs that were started from it keep
    their prompts and just lose the link (ON DELETE SET NULL), and its pending stop markers are cleared. Rows in
    `conversation_forks` stay (plain ids): lineage outlives a deletion. Returns whether a conversation was deleted."""

    def _run(conn: sqlite3.Connection) -> bool:
        owned = conn.execute(
            "SELECT 1 FROM conversations WHERE conversation_id = ? AND user_id = ?", (conversation_id, user_id)
        ).fetchone()
        if owned is None:
            return False
        conn.execute("DELETE FROM stop_requests WHERE scope = 'message' AND scope_id = ?", (conversation_id,))
        conn.execute("DELETE FROM conversations WHERE conversation_id = ? AND user_id = ?", (conversation_id, user_id))
        return True

    return await run_in_db(db_path, _run)


LESSON_SAMPLE_STAMP = "2000-01-01T00:00:00+00:00"
"""A lesson's sample chat is dated long ago, so it is never the user's "latest" chat (the one the Chat page opens)."""


async def ensure_lesson_sample(
    db_path: str,
    user_id: str,
    conversation_id: str,
    *,
    name: str,
    agent_id: str,
    model: str,
    temperature: float,
    brief_replies: bool,
    messages: list[dict],
) -> bool:
    """Put a lesson's sample chat in the user's chat history if it is not there. Idempotent (a fixed conversation id), so it
    never duplicates and never overwrites a chat the user has since changed. A chat the user deleted comes back the next time
    the lesson is opened. The assistant's answers are canned text, so they are marked `demo`. Returns True when it was added."""

    def _run(conn: sqlite3.Connection) -> bool:
        cursor = conn.execute(
            "INSERT OR IGNORE INTO conversations (conversation_id, user_id, is_sample, name, agent_id, model, "
            "reasoning_level, kb_summary_tool, source_conversation_id, created_at, updated_at, temperature, brief_replies) "
            "VALUES (?, ?, 0, ?, ?, ?, 'default', 0, NULL, ?, ?, ?, ?)",
            (
                conversation_id,
                user_id,
                name,
                agent_id,
                model,
                LESSON_SAMPLE_STAMP,
                LESSON_SAMPLE_STAMP,
                temperature,
                int(brief_replies),
            ),
        )
        if cursor.rowcount == 0:
            return False
        for number, message in enumerate(messages, start=1):
            conn.execute(
                "INSERT INTO messages (message_id, conversation_id, sequence_number, role, content, status, model, agent, "
                "demo, created_at) VALUES (?, ?, ?, ?, ?, 'complete', NULL, NULL, ?, ?)",
                (
                    str(uuid.uuid4()),
                    conversation_id,
                    number,
                    message["role"],
                    message["content"],
                    int(message["role"] == "assistant"),
                    LESSON_SAMPLE_STAMP,
                ),
            )
        return True

    return await run_in_db(db_path, _run)
