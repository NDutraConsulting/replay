"""The one-time move of the knowledge base from app.db to knowledgebase.db (db/kb_move.py)."""

import shutil
import sqlite3
from datetime import UTC, datetime

import pytest
from fastapi.testclient import TestClient

from config import Settings, get_settings
from db.connection import init_db
from db.kb_move import KnowledgeMoveError, move_knowledge_base
from db.migrate import KB_MIGRATIONS_DIR, MIGRATIONS_DIR, apply_migrations
from services import auth_service

NOW = datetime.now(UTC).isoformat()
KB_TABLES = {"kb_categories", "kb_subcategories", "kb_documents", "kb_seeded"}
LATEST = max(int(path.name[:4]) for path in MIGRATIONS_DIR.glob("*.sql"))
"""The newest app.db migration. The tests below say "everything after 0004" or "all of them" in terms of this, so adding a
migration never breaks them."""


def tables(path):
    conn = sqlite3.connect(path)
    try:
        return {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    finally:
        conn.close()


def versions(path):
    conn = sqlite3.connect(path)
    try:
        return [r[0] for r in conn.execute("SELECT version FROM schema_migrations ORDER BY version")]
    finally:
        conn.close()


def count(path, table):
    conn = sqlite3.connect(path)
    try:
        return conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
    finally:
        conn.close()


@pytest.fixture
def legacy(tmp_path):
    """An app.db as it was before the move: migrations 0001-0003 applied, knowledge base rows inside it."""
    old = tmp_path / "old-migrations"
    old.mkdir()
    for name in ("0001_initial.sql", "0002_stop_requests.sql", "0003_step_request_id.sql"):
        shutil.copy(MIGRATIONS_DIR / name, old / name)
    app_db = str(tmp_path / "app.db")
    apply_migrations(app_db, old)
    conn = sqlite3.connect(app_db)
    password_hash = auth_service.hash_password("legacy-password", 1000)
    conn.execute("INSERT INTO users VALUES ('u-old', 'legacyuser', ?, ?)", (password_hash, NOW))
    conn.execute("INSERT INTO kb_categories VALUES ('c-old', 'u-old', 'research', 'Legacy only', ?)", (NOW,))
    conn.execute("INSERT INTO kb_subcategories VALUES ('s-old', 'c-old', 'Legacy sub', ?)", (NOW,))
    conn.execute(
        "INSERT INTO kb_documents VALUES ('d-old', 's-old', 'legacy-notes.txt', 'kept through the move', 'current', ?, ?)",
        (NOW, NOW),
    )
    conn.execute("INSERT INTO kb_seeded VALUES ('u-old', 'research')")
    conn.commit()
    conn.close()
    return app_db, str(tmp_path / "knowledgebase.db")


def test_existing_knowledge_base_rows_are_moved_and_the_old_tables_dropped(legacy):
    app_db, kb_db = legacy
    assert KB_TABLES <= tables(app_db)
    assert init_db(app_db, kb_db) == list(range(4, LATEST + 1))  # app.db: 0004 and everything after it were pending
    assert not KB_TABLES & tables(app_db)
    assert versions(app_db) == list(range(1, LATEST + 1)) and versions(kb_db) == [1, 2]
    assert [count(kb_db, t) for t in ("kb_categories", "kb_subcategories", "kb_documents", "kb_seeded")] == [1, 1, 1, 1]
    conn = sqlite3.connect(kb_db)
    assert conn.execute("SELECT content, status FROM kb_documents WHERE document_id = 'd-old'").fetchone() == (
        "kept through the move",
        "current",
    )


def test_a_moved_user_keeps_their_knowledge_base_and_is_not_seeded_again(legacy):
    """End to end through the API: the seeded marker moved too, so the user does not get the defaults on top."""
    app_db, kb_db = legacy
    settings = Settings(
        _env_file=None,
        DATABASE_PATH=app_db,
        KNOWLEDGE_DB_PATH=kb_db,
        ENCRYPTION_KEY="x",
        PASSWORD_HASH_ITERATIONS=1000,
        DEMO_DELAY_SECONDS=0,
    )
    from main import app

    app.dependency_overrides[get_settings] = lambda: settings
    try:
        with TestClient(app) as client:  # startup runs init_db, which moves the data
            assert (
                client.post(
                    "/api/account/login", json={"username": "legacyuser", "password": "legacy-password"}
                ).status_code
                == 200
            )
            tree = client.get("/api/agents/research/knowledge-base").json()
    finally:
        app.dependency_overrides.clear()
    assert [c["name"] for c in tree["categories"]] == ["Legacy only"]  # not the ten seeded categories as well
    assert tree["categories"][0]["subcategories"][0]["documents"][0]["content"] == "kept through the move"


def test_running_the_move_again_changes_nothing(legacy):
    app_db, kb_db = legacy
    init_db(app_db, kb_db)
    before = count(kb_db, "kb_documents")
    assert init_db(app_db, kb_db) == []  # nothing pending
    assert move_knowledge_base(app_db, kb_db) == {}  # no old tables left to move
    assert count(kb_db, "kb_documents") == before


def test_a_crash_half_way_is_repaired_by_starting_again(legacy):
    app_db, kb_db = legacy
    apply_migrations(kb_db, KB_MIGRATIONS_DIR)
    conn = sqlite3.connect(kb_db)  # the previous run copied the categories, then died before the rest
    conn.execute("INSERT INTO kb_categories VALUES ('c-old', 'u-old', 'research', 'Legacy only', ?)", (NOW,))
    conn.commit()
    conn.close()
    init_db(app_db, kb_db)
    assert [count(kb_db, t) for t in ("kb_categories", "kb_subcategories", "kb_documents", "kb_seeded")] == [1, 1, 1, 1]
    assert not KB_TABLES & tables(app_db)


def test_a_row_that_cannot_be_copied_stops_startup_before_anything_is_dropped(legacy):
    app_db, kb_db = legacy
    apply_migrations(kb_db, KB_MIGRATIONS_DIR)
    conn = sqlite3.connect(kb_db)  # the same name for the same user and agent, under a different id
    conn.execute("INSERT INTO kb_categories VALUES ('c-other', 'u-old', 'research', 'legacy only', ?)", (NOW,))
    conn.commit()
    conn.close()
    with pytest.raises(KnowledgeMoveError, match="could not be copied"):
        init_db(app_db, kb_db)
    assert KB_TABLES <= tables(app_db)  # nothing was dropped
    assert versions(app_db) == [1, 2, 3]  # migration 0004 was not applied
    assert count(app_db, "kb_documents") == 1


def test_a_fresh_install_has_nothing_to_move(tmp_path):
    app_db, kb_db = str(tmp_path / "app.db"), str(tmp_path / "kb.db")
    assert init_db(app_db, kb_db) == list(range(1, LATEST + 1))
    assert not KB_TABLES & tables(app_db)
    assert KB_TABLES <= tables(kb_db)
    assert move_knowledge_base(str(tmp_path / "missing.db"), kb_db) == {}
