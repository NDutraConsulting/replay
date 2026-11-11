import sqlite3
from datetime import UTC, datetime

from db.connection import run_in_db
from models.preferences import UserPreferences


async def get(db_path: str, user_id: str) -> UserPreferences | None:
    def _get(conn: sqlite3.Connection) -> UserPreferences | None:
        row = conn.execute("SELECT * FROM user_preferences WHERE user_id = ?", (user_id,)).fetchone()
        if row is None:
            return None
        return UserPreferences(
            user_id=row["user_id"],
            agent_id=row["agent_id"],
            model=row["model"],
            chat_sidebar_hidden=bool(row["chat_sidebar_hidden"]),
            replay_prompts_hidden=bool(row["replay_prompts_hidden"]),
            updated_at=row["updated_at"],
        )

    return await run_in_db(db_path, _get)


_COLUMNS = {
    "agent_id": str,
    "model": lambda v: v,
    "chat_sidebar_hidden": int,
    "replay_prompts_hidden": int,
}


async def update(db_path: str, user_id: str, changes: dict) -> None:
    """Change only the given fields, atomically.

    A read-then-write of the whole row would let two quick requests (changing the agent, then the model)
    overwrite each other's field with a stale value. Instead the row is created with its defaults if missing
    and then only the changed columns are written, inside one transaction.
    """
    unknown = set(changes) - set(_COLUMNS)
    if unknown:
        raise ValueError(f"Unknown preference fields: {sorted(unknown)}")

    def _update(conn: sqlite3.Connection) -> None:
        stamp = datetime.now(UTC).isoformat()
        conn.execute("BEGIN IMMEDIATE")
        conn.execute("INSERT OR IGNORE INTO user_preferences (user_id, updated_at) VALUES (?, ?)", (user_id, stamp))
        if changes:
            assignments = ", ".join(f"{column} = ?" for column in changes)  # column names come from the allow-list
            values = [_COLUMNS[column](value) if value is not None else None for column, value in changes.items()]
            conn.execute(
                f"UPDATE user_preferences SET {assignments}, updated_at = ? WHERE user_id = ?",
                (*values, stamp, user_id),
            )

    await run_in_db(db_path, _update)
