import sqlite3
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime

from db.connection import run_in_db
from db.kb_versions import add_version_if_changed
from models.knowledge_base import (
    Category,
    CategoryView,
    DocumentView,
    KnowledgeDocument,
    Subcategory,
    SubcategoryView,
)


class DuplicateName(Exception):
    """A unique (case-insensitive) name constraint was violated."""


def _now() -> str:
    return datetime.now(UTC).isoformat()


def _category(row: sqlite3.Row) -> Category:
    return Category(**{k: row[k] for k in ("category_id", "user_id", "agent_id", "name", "created_at")})


def _subcategory(row: sqlite3.Row) -> Subcategory:
    return Subcategory(**{k: row[k] for k in ("subcategory_id", "category_id", "name", "created_at")})


# The current version of a file is its highest-numbered one.
_CURRENT_VERSION = (
    "(SELECT {col} FROM kb_document_versions v WHERE v.document_id = d.document_id "
    "ORDER BY v.version_number DESC LIMIT 1) AS {alias}"
)
_DOCUMENT_COLUMNS = (
    "d.document_id, d.subcategory_id, d.title, d.content, d.status, d.created_at, d.updated_at, "
    + _CURRENT_VERSION.format(col="version_id", alias="version_id")
    + ", "
    + _CURRENT_VERSION.format(col="version_number", alias="version_number")
)


def _document(row: sqlite3.Row) -> KnowledgeDocument:
    keys = ("document_id", "subcategory_id", "title", "content", "status", "created_at", "updated_at")
    extra = {k: row[k] for k in ("version_id", "version_number") if k in row.keys()}  # noqa: SIM118
    return KnowledgeDocument(**{k: row[k] for k in keys}, **extra, size_bytes=len(row["content"].encode()))


def _insert_seed(conn: sqlite3.Connection, user_id: str, agent_id: str, data: list[dict]) -> None:
    for category in data:
        category_id = str(uuid.uuid4())
        conn.execute(
            "INSERT INTO kb_categories (category_id, user_id, agent_id, name, created_at) VALUES (?, ?, ?, ?, ?)",
            (category_id, user_id, agent_id, category["name"], _now()),
        )
        for sub in category["subcategories"]:
            sub_id = str(uuid.uuid4())
            conn.execute(
                "INSERT INTO kb_subcategories (subcategory_id, category_id, name, created_at) VALUES (?, ?, ?, ?)",
                (sub_id, category_id, sub["name"], _now()),
            )
            for doc in sub["documents"]:
                stamp = _now()
                document_id = str(uuid.uuid4())
                conn.execute(
                    "INSERT INTO kb_documents (document_id, subcategory_id, title, content, status, created_at, updated_at) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?)",
                    (document_id, sub_id, doc["title"], doc["content"], doc["status"], stamp, stamp),
                )
                add_version_if_changed(conn, document_id, doc["content"], stamp)


async def ensure_seeded(db_path: str, user_id: str, agent_id: str, data: list[dict]) -> bool:
    """Seed this user's knowledge base for an agent once. Returns True if it seeded just now."""

    def _run(conn: sqlite3.Connection) -> bool:
        conn.execute("BEGIN IMMEDIATE")
        if conn.execute("SELECT 1 FROM kb_seeded WHERE user_id = ? AND agent_id = ?", (user_id, agent_id)).fetchone():
            return False
        _insert_seed(conn, user_id, agent_id, data)
        conn.execute("INSERT INTO kb_seeded (user_id, agent_id) VALUES (?, ?)", (user_id, agent_id))
        return True

    return await run_in_db(db_path, _run)


async def reset(db_path: str, user_id: str, agent_id: str, data: list[dict]) -> None:
    def _run(conn: sqlite3.Connection) -> None:
        conn.execute("BEGIN IMMEDIATE")
        conn.execute("DELETE FROM kb_categories WHERE user_id = ? AND agent_id = ?", (user_id, agent_id))
        _insert_seed(conn, user_id, agent_id, data)
        conn.execute("INSERT OR IGNORE INTO kb_seeded (user_id, agent_id) VALUES (?, ?)", (user_id, agent_id))

    await run_in_db(db_path, _run)


async def get_tree(db_path: str, user_id: str, agent_id: str) -> list[CategoryView]:
    def _run(conn: sqlite3.Connection) -> list[CategoryView]:
        args = (user_id, agent_id)
        categories = conn.execute(
            "SELECT * FROM kb_categories WHERE user_id = ? AND agent_id = ? ORDER BY created_at, rowid", args
        ).fetchall()
        subs = conn.execute(
            "SELECT s.* FROM kb_subcategories s JOIN kb_categories c ON c.category_id = s.category_id "
            "WHERE c.user_id = ? AND c.agent_id = ? ORDER BY s.created_at, s.rowid",
            args,
        ).fetchall()
        docs = conn.execute(
            f"SELECT {_DOCUMENT_COLUMNS} FROM kb_documents d JOIN kb_subcategories s ON s.subcategory_id = d.subcategory_id "
            "JOIN kb_categories c ON c.category_id = s.category_id "
            "WHERE c.user_id = ? AND c.agent_id = ? ORDER BY d.created_at, d.rowid",
            args,
        ).fetchall()
        docs_by_sub: dict[str, list[DocumentView]] = {}
        for row in docs:
            docs_by_sub.setdefault(row["subcategory_id"], []).append(DocumentView(**_document(row).model_dump()))
        subs_by_category: dict[str, list[SubcategoryView]] = {}
        for row in subs:
            subs_by_category.setdefault(row["category_id"], []).append(
                SubcategoryView(
                    subcategory_id=row["subcategory_id"],
                    name=row["name"],
                    documents=docs_by_sub.get(row["subcategory_id"], []),
                )
            )
        return [
            CategoryView(
                category_id=row["category_id"],
                name=row["name"],
                subcategories=subs_by_category.get(row["category_id"], []),
            )
            for row in categories
        ]

    return await run_in_db(db_path, _run)


# ---- ownership-checked lookups
async def get_category(db_path: str, user_id: str, category_id: str) -> Category | None:
    def _run(conn: sqlite3.Connection) -> Category | None:
        row = conn.execute(
            "SELECT * FROM kb_categories WHERE category_id = ? AND user_id = ?", (category_id, user_id)
        ).fetchone()
        return _category(row) if row else None

    return await run_in_db(db_path, _run)


async def get_subcategory(db_path: str, user_id: str, subcategory_id: str) -> tuple[Subcategory, Category] | None:
    def _run(conn: sqlite3.Connection) -> tuple[Subcategory, Category] | None:
        row = conn.execute(
            "SELECT s.subcategory_id AS s_id, s.category_id AS s_category_id, s.name AS s_name, s.created_at AS s_created, "
            "c.* FROM kb_subcategories s JOIN kb_categories c ON c.category_id = s.category_id "
            "WHERE s.subcategory_id = ? AND c.user_id = ?",
            (subcategory_id, user_id),
        ).fetchone()
        if row is None:
            return None
        sub = Subcategory(
            subcategory_id=row["s_id"],
            category_id=row["s_category_id"],
            name=row["s_name"],
            created_at=row["s_created"],
        )
        return sub, _category(row)

    return await run_in_db(db_path, _run)


async def get_document(
    db_path: str, user_id: str, document_id: str
) -> tuple[KnowledgeDocument, Subcategory, Category] | None:
    def _run(conn: sqlite3.Connection) -> tuple[KnowledgeDocument, Subcategory, Category] | None:
        row = conn.execute(
            f"SELECT {_DOCUMENT_COLUMNS}, "
            "s.name AS s_name, s.created_at AS s_created, c.category_id, c.user_id, c.agent_id, "
            "c.name AS c_name, c.created_at AS c_created "
            "FROM kb_documents d JOIN kb_subcategories s ON s.subcategory_id = d.subcategory_id "
            "JOIN kb_categories c ON c.category_id = s.category_id WHERE d.document_id = ? AND c.user_id = ?",
            (document_id, user_id),
        ).fetchone()
        if row is None:
            return None
        document = _document(row)
        sub = Subcategory(
            subcategory_id=row["subcategory_id"],
            category_id=row["category_id"],
            name=row["s_name"],
            created_at=row["s_created"],
        )
        category = Category(
            category_id=row["category_id"],
            user_id=row["user_id"],
            agent_id=row["agent_id"],
            name=row["c_name"],
            created_at=row["c_created"],
        )
        return document, sub, category

    return await run_in_db(db_path, _run)


# ---- writes
async def create_category(db_path: str, user_id: str, agent_id: str, name: str) -> Category:
    category = Category(category_id=str(uuid.uuid4()), user_id=user_id, agent_id=agent_id, name=name, created_at=_now())

    def _run(conn: sqlite3.Connection) -> None:
        conn.execute(
            "INSERT INTO kb_categories (category_id, user_id, agent_id, name, created_at) VALUES (?, ?, ?, ?, ?)",
            (category.category_id, user_id, agent_id, name, category.created_at.isoformat()),
        )

    try:
        await run_in_db(db_path, _run)
    except sqlite3.IntegrityError as exc:
        raise DuplicateName from exc
    return category


async def create_subcategory(db_path: str, category_id: str, name: str) -> Subcategory:
    sub = Subcategory(subcategory_id=str(uuid.uuid4()), category_id=category_id, name=name, created_at=_now())

    def _run(conn: sqlite3.Connection) -> None:
        conn.execute(
            "INSERT INTO kb_subcategories (subcategory_id, category_id, name, created_at) VALUES (?, ?, ?, ?)",
            (sub.subcategory_id, category_id, name, sub.created_at.isoformat()),
        )

    try:
        await run_in_db(db_path, _run)
    except sqlite3.IntegrityError as exc:
        raise DuplicateName from exc
    return sub


async def create_document(
    db_path: str, subcategory_id: str, title: str, content: str, status: str
) -> KnowledgeDocument:
    stamp = _now()
    doc = KnowledgeDocument(
        document_id=str(uuid.uuid4()),
        subcategory_id=subcategory_id,
        title=title,
        content=content,
        status=status,
        created_at=stamp,
        updated_at=stamp,
    )

    def _run(conn: sqlite3.Connection) -> None:
        conn.execute(
            "INSERT INTO kb_documents (document_id, subcategory_id, title, content, status, created_at, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (doc.document_id, subcategory_id, title, content, status, stamp, stamp),
        )
        doc.version_id = add_version_if_changed(conn, doc.document_id, content, stamp)
        doc.version_number = 1

    try:
        await run_in_db(db_path, _run)
    except sqlite3.IntegrityError as exc:
        raise DuplicateName from exc
    doc.size_bytes = len(content.encode())
    return doc


async def update_document(db_path: str, document_id: str, title: str, content: str, status: str) -> None:
    def _run(conn: sqlite3.Connection) -> None:
        conn.execute(
            "UPDATE kb_documents SET title = ?, content = ?, status = ?, updated_at = ? WHERE document_id = ?",
            (title, content, status, _now(), document_id),
        )
        add_version_if_changed(conn, document_id, content)  # a new version only when the text really changed

    try:
        await run_in_db(db_path, _run)
    except sqlite3.IntegrityError as exc:
        raise DuplicateName from exc


async def delete_category(db_path: str, category_id: str) -> None:
    await run_in_db(
        db_path, lambda conn: conn.execute("DELETE FROM kb_categories WHERE category_id = ?", (category_id,))
    )


async def delete_subcategory(db_path: str, subcategory_id: str) -> None:
    await run_in_db(
        db_path, lambda conn: conn.execute("DELETE FROM kb_subcategories WHERE subcategory_id = ?", (subcategory_id,))
    )


async def delete_document(db_path: str, document_id: str) -> None:
    await run_in_db(
        db_path, lambda conn: conn.execute("DELETE FROM kb_documents WHERE document_id = ?", (document_id,))
    )


async def delete_user_knowledge(db_path: str, user_id: str) -> None:
    """Remove everything a user has in the knowledge database.

    The knowledge base is a separate file, so deleting a user in app.db no longer cascades here: a future
    delete-user route must call this too."""

    def _run(conn: sqlite3.Connection) -> None:
        conn.execute("DELETE FROM kb_categories WHERE user_id = ?", (user_id,))  # cascades to sub categories and files
        conn.execute("DELETE FROM kb_seeded WHERE user_id = ?", (user_id,))
        conn.execute("DELETE FROM knowledge_base_choice WHERE user_id = ?", (user_id,))

    await run_in_db(db_path, _run)


# ---- versions
@dataclass
class VersionRow:
    version_id: str
    document_id: str
    version_number: int
    content: str


async def get_versions(db_path: str, version_ids: list[str]) -> dict[str, VersionRow]:
    """{version_id: VersionRow} for the versions that still exist (a deleted file's versions are gone)."""
    wanted = list(dict.fromkeys(v for v in version_ids if v))
    if not wanted:
        return {}

    def _run(conn: sqlite3.Connection) -> dict[str, VersionRow]:
        marks = ", ".join("?" * len(wanted))
        rows = conn.execute(
            f"SELECT version_id, document_id, version_number, content FROM kb_document_versions "
            f"WHERE version_id IN ({marks})",
            wanted,
        ).fetchall()
        return {
            r["version_id"]: VersionRow(r["version_id"], r["document_id"], r["version_number"], r["content"])
            for r in rows
        }

    return await run_in_db(db_path, _run)


async def version_ids_for_agent(db_path: str, user_id: str, agent_id: str) -> list[str]:
    """Every version id of every file in this user's knowledge base for the agent."""

    def _run(conn: sqlite3.Connection) -> list[str]:
        rows = conn.execute(
            "SELECT v.version_id FROM kb_document_versions v JOIN kb_documents d ON d.document_id = v.document_id "
            "JOIN kb_subcategories s ON s.subcategory_id = d.subcategory_id "
            "JOIN kb_categories c ON c.category_id = s.category_id WHERE c.user_id = ? AND c.agent_id = ?",
            (user_id, agent_id),
        ).fetchall()
        return [r[0] for r in rows]

    return await run_in_db(db_path, _run)


async def version_ids_under(
    db_path: str,
    *,
    document_id: str | None = None,
    subcategory_id: str | None = None,
    category_id: str | None = None,
) -> list[str]:
    """Every version id that deleting this file, sub category or category would remove."""

    def _run(conn: sqlite3.Connection) -> list[str]:
        base = (
            "SELECT v.version_id FROM kb_document_versions v JOIN kb_documents d ON d.document_id = v.document_id "
            "JOIN kb_subcategories s ON s.subcategory_id = d.subcategory_id "
        )
        if document_id is not None:
            rows = conn.execute(base + "WHERE d.document_id = ?", (document_id,))
        elif subcategory_id is not None:
            rows = conn.execute(base + "WHERE s.subcategory_id = ?", (subcategory_id,))
        else:
            rows = conn.execute(base + "WHERE s.category_id = ?", (category_id,))
        return [r[0] for r in rows.fetchall()]

    return await run_in_db(db_path, _run)
