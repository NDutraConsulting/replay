"""One-time move of the knowledge base out of app.db into knowledgebase.db.

Existing databases have the kb_* tables in app.db (migration 0001). At startup, after knowledgebase.db has been
created and BEFORE app.db's migration 0004 drops those tables, the rows are copied across and the copy is verified.
Any problem raises KnowledgeMoveError, which stops startup before anything is dropped.

The copy is idempotent (INSERT OR IGNORE), so a crash half way is repaired by simply starting again. A fresh install
has no old tables here and nothing happens.
"""

import sqlite3
from pathlib import Path

# (table, columns, primary key) in dependency order
_TABLES = (
    ("kb_categories", ("category_id", "user_id", "agent_id", "name", "created_at"), ("category_id",)),
    ("kb_subcategories", ("subcategory_id", "category_id", "name", "created_at"), ("subcategory_id",)),
    (
        "kb_documents",
        ("document_id", "subcategory_id", "title", "content", "status", "created_at", "updated_at"),
        ("document_id",),
    ),
    ("kb_seeded", ("user_id", "agent_id"), ("user_id", "agent_id")),
)


class KnowledgeMoveError(RuntimeError):
    pass


def move_knowledge_base(app_db_path: str, kb_db_path: str) -> dict[str, int]:
    """Copy and verify the old knowledge base tables. Returns {table: rows} for what was found (empty if nothing)."""
    if not Path(app_db_path).exists():
        return {}
    conn = sqlite3.connect(kb_db_path)
    try:
        conn.execute("ATTACH DATABASE ? AS legacy", (str(app_db_path),))
        present = {row[0] for row in conn.execute("SELECT name FROM legacy.sqlite_master WHERE type = 'table'")}
        tables = [t for t in _TABLES if t[0] in present]
        if not tables:
            return {}

        with conn:  # one transaction on knowledgebase.db
            for table, columns, _ in tables:
                cols = ", ".join(columns)
                conn.execute(f"INSERT OR IGNORE INTO main.{table} ({cols}) SELECT {cols} FROM legacy.{table}")

        moved: dict[str, int] = {}
        for table, _, key_columns in tables:
            key = ", ".join(key_columns)
            missing = conn.execute(
                f"SELECT COUNT(*) FROM legacy.{table} WHERE ({key}) NOT IN (SELECT {key} FROM main.{table})"
            ).fetchone()[0]
            if missing:
                raise KnowledgeMoveError(
                    f"{missing} row(s) of {table} could not be copied from {app_db_path} to {kb_db_path} "
                    "(for example a name that already exists there under another id). "
                    "Nothing was dropped; fix or remove the conflicting rows and start again."
                )
            moved[table] = conn.execute(f"SELECT COUNT(*) FROM legacy.{table}").fetchone()[0]
        return moved
    finally:
        conn.close()
