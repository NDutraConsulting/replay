import sqlite3
from datetime import datetime

from db.connection import run_in_db


async def create(db_path: str, session_token: str, user_id: str, created_at: datetime) -> None:
    def _create(conn: sqlite3.Connection) -> None:
        conn.execute(
            "INSERT INTO sessions (session_token, user_id, created_at) VALUES (?, ?, ?)",
            (session_token, user_id, created_at.isoformat()),
        )

    await run_in_db(db_path, _create)


async def get(db_path: str, session_token: str) -> tuple[str, datetime] | None:
    """Returns (user_id, created_at) for a token, or None."""

    def _get(conn: sqlite3.Connection) -> tuple[str, datetime] | None:
        row = conn.execute(
            "SELECT user_id, created_at FROM sessions WHERE session_token = ?", (session_token,)
        ).fetchone()
        return (row["user_id"], datetime.fromisoformat(row["created_at"])) if row else None

    return await run_in_db(db_path, _get)


async def delete(db_path: str, session_token: str) -> None:
    def _delete(conn: sqlite3.Connection) -> None:
        conn.execute("DELETE FROM sessions WHERE session_token = ?", (session_token,))

    await run_in_db(db_path, _delete)
