import asyncio
import sqlite3
import threading
from collections.abc import Callable

from db.kb_move import move_knowledge_base
from db.kb_versions import backfill as backfill_document_versions
from db.migrate import KB_MIGRATIONS_DIR, LESSON_MIGRATIONS_DIR, LOG_MIGRATIONS_DIR, apply_migrations


def get_connection(db_path: str) -> sqlite3.Connection:
    conn = sqlite3.connect(db_path, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db(
    db_path: str, knowledge_db_path: str, log_db_path: str | None = None, lessons_db_path: str | None = None
) -> list[int]:
    """Create/upgrade the database files (app.db, knowledgebase.db and, when given, Log.db and lessons.db). They persist between runs; only new migrations are applied.

    Order matters: the knowledge base database is created first, the old knowledge base tables are copied out of
    app.db (verified), and only then does app.db's migration 0004 drop them.
    Returns the app.db migration versions applied by this call."""
    extra = [p for p in (log_db_path, lessons_db_path) if p]
    for path in (db_path, knowledge_db_path, *extra):
        conn = sqlite3.connect(path)
        try:
            conn.execute("PRAGMA journal_mode = WAL")
        finally:
            conn.close()
    apply_migrations(knowledge_db_path, KB_MIGRATIONS_DIR)
    if log_db_path:
        apply_migrations(log_db_path, LOG_MIGRATIONS_DIR)
    if lessons_db_path:
        apply_migrations(lessons_db_path, LESSON_MIGRATIONS_DIR)
    move_knowledge_base(db_path, knowledge_db_path)
    backfill_document_versions(knowledge_db_path)  # every file has at least its version 1
    return apply_migrations(db_path)


_LOG_HEAL = threading.Lock()


def _ensure_log_schema(db_path: str) -> None:
    """Create Log.db's tables if its file was deleted or emptied while the server runs (migrations are otherwise only applied at
    startup, and SQLite quietly makes a new empty file on the next connection). Safe to call from several requests at once."""
    with _LOG_HEAL:
        conn = sqlite3.connect(db_path)
        try:
            conn.execute("PRAGMA journal_mode = WAL")
        finally:
            conn.close()
        apply_migrations(db_path, LOG_MIGRATIONS_DIR)


async def run_in_log_db[T](db_path: str, fn: Callable[[sqlite3.Connection], T]) -> T:
    """`run_in_db` for Log.db. If a table is missing, the file was deleted or emptied under the running server (for example by
    `run.sh --reset-log` run in another terminal): rebuild the schema from the migrations and try once more, instead of failing
    every log write and read until the next restart. The failed attempt was rolled back, so the retry starts clean. Anything
    else, or a table the migrations do not create, is raised as it was."""
    try:
        return await run_in_db(db_path, fn)
    except sqlite3.OperationalError as exc:
        if "no such table" not in str(exc):
            raise
    await asyncio.to_thread(_ensure_log_schema, db_path)
    return await run_in_db(db_path, fn)


_LESSONS_HEAL = threading.Lock()


def _ensure_lessons_schema(db_path: str) -> None:
    """Rebuild lessons.db's tables (and its seeded lessons are restored by the next start or seed) after the file was deleted
    while the server runs. Same idea as `_ensure_log_schema`."""
    with _LESSONS_HEAL:
        conn = sqlite3.connect(db_path)
        try:
            conn.execute("PRAGMA journal_mode = WAL")
        finally:
            conn.close()
        apply_migrations(db_path, LESSON_MIGRATIONS_DIR)


async def run_in_lessons_db[T](db_path: str, fn: Callable[[sqlite3.Connection], T]) -> T:
    """`run_in_db` for lessons.db, with the one retry after rebuilding the schema when a table is missing."""
    try:
        return await run_in_db(db_path, fn)
    except sqlite3.OperationalError as exc:
        if "no such table" not in str(exc):
            raise
    await asyncio.to_thread(_ensure_lessons_schema, db_path)
    return await run_in_db(db_path, fn)


async def run_in_db[T](db_path: str, fn: Callable[[sqlite3.Connection], T]) -> T:
    """Run `fn(conn)` in a worker thread inside one transaction (commit on success, rollback on error).
    Repositories write small synchronous closures and call this, so the event loop is never blocked."""

    def _call() -> T:
        conn = get_connection(db_path)
        try:
            result = fn(conn)
            conn.commit()
            return result
        except BaseException:
            conn.rollback()
            raise
        finally:
            conn.close()

    return await asyncio.to_thread(_call)
