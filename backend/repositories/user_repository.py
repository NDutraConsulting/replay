import sqlite3

from db.connection import run_in_db
from models.user import User


def _row_to_user(row: sqlite3.Row) -> User:
    return User(
        user_id=row["user_id"],
        username=row["username"],
        password_hash=row["password_hash"],
        created_at=row["created_at"],
    )


async def create(db_path: str, user: User) -> User:
    def _create(conn: sqlite3.Connection) -> None:
        conn.execute(
            "INSERT INTO users (user_id, username, password_hash, created_at) VALUES (?, ?, ?, ?)",
            (user.user_id, user.username, user.password_hash, user.created_at.isoformat()),
        )

    await run_in_db(db_path, _create)
    return user


async def get_by_username(db_path: str, username: str) -> User | None:
    def _get(conn: sqlite3.Connection) -> User | None:
        row = conn.execute("SELECT * FROM users WHERE username = ?", (username,)).fetchone()
        return _row_to_user(row) if row else None

    return await run_in_db(db_path, _get)


async def get_by_id(db_path: str, user_id: str) -> User | None:
    def _get(conn: sqlite3.Connection) -> User | None:
        row = conn.execute("SELECT * FROM users WHERE user_id = ?", (user_id,)).fetchone()
        return _row_to_user(row) if row else None

    return await run_in_db(db_path, _get)


async def set_password_hash(db_path: str, user_id: str, password_hash: str) -> None:
    await run_in_db(
        db_path,
        lambda conn: conn.execute("UPDATE users SET password_hash = ? WHERE user_id = ?", (password_hash, user_id)),
    )
