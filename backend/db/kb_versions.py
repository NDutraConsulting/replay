"""Document versions (knowledgebase.db): the text a file held, once per change, identified by a uuid.

A version never changes. A file's current text is the version with the highest number (kb_documents.content mirrors
it so the existing reads stay simple)."""

import hashlib
import sqlite3
import uuid
from datetime import UTC, datetime


def content_hash(content: str) -> str:
    return hashlib.sha256(content.encode("utf-8")).hexdigest()


def add_version_if_changed(conn: sqlite3.Connection, document_id: str, content: str, stamp: str | None = None) -> str:
    """Store `content` as the file's next version unless it equals the latest one. Returns the current version id."""
    digest = content_hash(content)
    latest = conn.execute(
        "SELECT version_id, version_number, content_hash FROM kb_document_versions WHERE document_id = ? "
        "ORDER BY version_number DESC LIMIT 1",
        (document_id,),
    ).fetchone()
    if latest is not None and latest[2] == digest:
        return latest[0]
    version_id = str(uuid.uuid4())
    conn.execute(
        "INSERT INTO kb_document_versions (version_id, document_id, version_number, content_hash, content, created_at) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        (
            version_id,
            document_id,
            (latest[1] + 1) if latest else 1,
            digest,
            content,
            stamp or datetime.now(UTC).isoformat(),
        ),
    )
    return version_id


def backfill(db_path: str) -> int:
    """Give every file that has no version its version 1 (idempotent: files that have one are skipped). Returns how many
    were added. Verified: afterwards no file is left without a version, or this raises."""
    conn = sqlite3.connect(db_path, timeout=30)
    try:
        conn.execute("PRAGMA foreign_keys = ON")
        rows = conn.execute(
            "SELECT d.document_id, d.content, d.created_at FROM kb_documents d "
            "WHERE NOT EXISTS (SELECT 1 FROM kb_document_versions v WHERE v.document_id = d.document_id)"
        ).fetchall()
        for document_id, content, created_at in rows:
            add_version_if_changed(conn, document_id, content, created_at)
        conn.commit()
        missing = conn.execute(
            "SELECT COUNT(*) FROM kb_documents d WHERE NOT EXISTS "
            "(SELECT 1 FROM kb_document_versions v WHERE v.document_id = d.document_id)"
        ).fetchone()[0]
        if missing:
            raise RuntimeError(f"{missing} knowledge base files are still without a version after the backfill.")
        return len(rows)
    finally:
        conn.close()
