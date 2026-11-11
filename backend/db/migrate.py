"""Tiny numbered-migration runner.

Files live in db/migrations as NNNN_name.sql (0001, 0002, ...). Each is applied once, in order, inside a
transaction, and recorded in schema_migrations with a checksum. Rules:
  - never edit a migration that has been applied (the checksum check refuses to start);
  - add a new numbered file for every schema change;
  - no gaps or duplicates in the numbering.
"""

import hashlib
import re
import sqlite3
from datetime import UTC, datetime
from pathlib import Path

MIGRATIONS_DIR = Path(__file__).parent / "migrations"
KB_MIGRATIONS_DIR = Path(__file__).parent / "kb_migrations"
"""The knowledge base database (knowledgebase.db) has its own migrations and its own schema_migrations table."""
LOG_MIGRATIONS_DIR = Path(__file__).parent / "log_migrations"
"""The API log database (Log.db) has its own migrations and its own schema_migrations table."""
_NAME = re.compile(r"^(\d{4})_[a-z0-9_]+\.sql$")


class MigrationError(RuntimeError):
    pass


def _checksum(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _load(migrations_dir: Path) -> list[tuple[int, Path]]:
    files: list[tuple[int, Path]] = []
    for path in sorted(migrations_dir.glob("*.sql")):
        match = _NAME.match(path.name)
        if not match:
            raise MigrationError(f"Bad migration file name: {path.name} (expected NNNN_name.sql)")
        files.append((int(match.group(1)), path))
    for expected, (number, path) in enumerate(files, start=1):
        if number != expected:
            raise MigrationError(f"Migration numbering gap or duplicate at {path.name}: expected {expected:04d}")
    return files


def apply_migrations(db_path: str, migrations_dir: Path = MIGRATIONS_DIR) -> list[int]:
    """Apply every pending migration. Returns the versions applied by this call."""
    files = _load(Path(migrations_dir))
    by_version = dict(files)
    conn = sqlite3.connect(db_path)
    conn.isolation_level = None  # explicit transactions below
    try:
        conn.execute(
            "CREATE TABLE IF NOT EXISTS schema_migrations ("
            "version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)"
        )
        applied = {
            row[0]: (row[1], row[2]) for row in conn.execute("SELECT version, name, checksum FROM schema_migrations")
        }
        for version, (name, checksum) in applied.items():
            if version not in by_version:
                raise MigrationError(
                    f"The database has migration {version:04d} ({name}) that this code does not know; "
                    "refusing to run against a newer database."
                )
            if _checksum(by_version[version]) != checksum:
                raise MigrationError(
                    f"Applied migration {by_version[version].name} was modified. "
                    "Never edit an applied migration; add a new one."
                )
        newly_applied: list[int] = []
        for version, path in files:
            if version in applied:
                continue
            record = (
                "INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES "
                f"({version}, '{path.name}', '{_checksum(path)}', '{datetime.now(UTC).isoformat()}');"
            )
            try:
                conn.executescript(f"BEGIN IMMEDIATE;\n{path.read_text()}\n{record}\nCOMMIT;")
            except sqlite3.Error as exc:
                if conn.in_transaction:
                    conn.execute("ROLLBACK")
                raise MigrationError(f"Migration {path.name} failed: {exc}") from exc
            newly_applied.append(version)
        return newly_applied
    finally:
        conn.close()
