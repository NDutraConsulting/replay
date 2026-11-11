import json
import sqlite3
import uuid
from datetime import UTC, datetime

from db.connection import run_in_db
from models.chat_record import ChatRecord


def _row(row: sqlite3.Row) -> ChatRecord:
    return ChatRecord(
        chat_record_id=row["chat_record_id"],
        user_id=row["user_id"],
        name=row["name"],
        prompts=json.loads(row["prompts_json"]),
        created_at=row["created_at"],
    )


async def create(db_path: str, user_id: str, prompts: list[str]) -> ChatRecord:
    """Stores the prompts under the next free "Chat record N" name for this user."""

    def _run(conn: sqlite3.Connection) -> ChatRecord:
        conn.execute("BEGIN IMMEDIATE")
        count = conn.execute("SELECT COUNT(*) FROM chat_records WHERE user_id = ?", (user_id,)).fetchone()[0]
        record_id = str(uuid.uuid4())
        conn.execute(
            "INSERT INTO chat_records (chat_record_id, user_id, name, prompts_json, created_at) VALUES (?, ?, ?, ?, ?)",
            (record_id, user_id, f"Chat record {count + 1}", json.dumps(prompts), datetime.now(UTC).isoformat()),
        )
        return _row(conn.execute("SELECT * FROM chat_records WHERE chat_record_id = ?", (record_id,)).fetchone())

    return await run_in_db(db_path, _run)


async def list_for_user(db_path: str, user_id: str) -> list[ChatRecord]:
    """Oldest first (the order the UI already expects)."""

    def _run(conn: sqlite3.Connection) -> list[ChatRecord]:
        rows = conn.execute(
            "SELECT * FROM chat_records WHERE user_id = ? ORDER BY created_at, rowid", (user_id,)
        ).fetchall()
        return [_row(r) for r in rows]

    return await run_in_db(db_path, _run)


async def get_owned(db_path: str, user_id: str, chat_record_id: str) -> ChatRecord | None:
    def _run(conn: sqlite3.Connection) -> ChatRecord | None:
        row = conn.execute(
            "SELECT * FROM chat_records WHERE chat_record_id = ? AND user_id = ?", (chat_record_id, user_id)
        ).fetchone()
        return _row(row) if row else None

    return await run_in_db(db_path, _run)
