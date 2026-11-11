"""An account's API connections (label, URL, key, models). The key is stored encrypted."""

import json
import sqlite3
import uuid
from datetime import UTC, datetime

from db.connection import run_in_db
from models.provider_settings import ApiConnection


def _now() -> str:
    return datetime.now(UTC).isoformat()


def _row(row: sqlite3.Row) -> ApiConnection:
    return ApiConnection(
        connection_id=row["connection_id"],
        user_id=row["user_id"],
        label=row["label"],
        base_url=row["base_url"],
        api_key=row["api_key"],
        models=json.loads(row["models_json"]),
        sort_order=row["sort_order"],
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )


async def list_for_user(db_path: str, user_id: str) -> list[ApiConnection]:
    def _run(conn: sqlite3.Connection) -> list[ApiConnection]:
        rows = conn.execute(
            "SELECT * FROM api_connections WHERE user_id = ? ORDER BY sort_order, created_at, rowid", (user_id,)
        ).fetchall()
        return [_row(r) for r in rows]

    return await run_in_db(db_path, _run)


async def get(db_path: str, user_id: str, connection_id: str) -> ApiConnection | None:
    def _run(conn: sqlite3.Connection) -> ApiConnection | None:
        row = conn.execute(
            "SELECT * FROM api_connections WHERE user_id = ? AND connection_id = ?", (user_id, connection_id)
        ).fetchone()
        return _row(row) if row else None

    return await run_in_db(db_path, _run)


async def label_taken(db_path: str, user_id: str, label: str) -> bool:
    def _run(conn: sqlite3.Connection) -> bool:
        return (
            conn.execute(
                "SELECT 1 FROM api_connections WHERE user_id = ? AND label = ? COLLATE NOCASE", (user_id, label)
            ).fetchone()
            is not None
        )

    return await run_in_db(db_path, _run)


async def create(
    db_path: str, user_id: str, label: str, base_url: str, api_key: str, models: list[str]
) -> ApiConnection:
    connection_id = uuid.uuid4().hex

    def _run(conn: sqlite3.Connection) -> ApiConnection:
        stamp = _now()
        order = conn.execute(
            "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM api_connections WHERE user_id = ?", (user_id,)
        ).fetchone()[0]
        conn.execute(
            "INSERT INTO api_connections (connection_id, user_id, label, base_url, api_key, models_json, sort_order, "
            "created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (connection_id, user_id, label, base_url, api_key, json.dumps(models), order, stamp, stamp),
        )
        return _row(conn.execute("SELECT * FROM api_connections WHERE connection_id = ?", (connection_id,)).fetchone())

    return await run_in_db(db_path, _run)


async def update(
    db_path: str, user_id: str, connection_id: str, base_url: str, api_key: str, models: list[str]
) -> ApiConnection | None:
    def _run(conn: sqlite3.Connection) -> ApiConnection | None:
        cursor = conn.execute(
            "UPDATE api_connections SET base_url = ?, api_key = ?, models_json = ?, updated_at = ? "
            "WHERE user_id = ? AND connection_id = ?",
            (base_url, api_key, json.dumps(models), _now(), user_id, connection_id),
        )
        if not cursor.rowcount:
            return None
        return _row(conn.execute("SELECT * FROM api_connections WHERE connection_id = ?", (connection_id,)).fetchone())

    return await run_in_db(db_path, _run)


async def delete(db_path: str, user_id: str, connection_id: str) -> bool:
    def _run(conn: sqlite3.Connection) -> bool:
        return bool(
            conn.execute(
                "DELETE FROM api_connections WHERE user_id = ? AND connection_id = ?", (user_id, connection_id)
            ).rowcount
        )

    return await run_in_db(db_path, _run)
