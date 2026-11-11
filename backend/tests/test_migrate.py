import sqlite3

import pytest

from db.migrate import MigrationError, apply_migrations


def _write(directory, name, sql):
    (directory / name).write_text(sql)


def _tables(db_path):
    conn = sqlite3.connect(db_path)
    try:
        return {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    finally:
        conn.close()


@pytest.fixture
def mdir(tmp_path):
    d = tmp_path / "migrations"
    d.mkdir()
    return d


def test_applies_in_order_and_records_versions(tmp_path, mdir):
    db = str(tmp_path / "m.db")
    _write(mdir, "0001_a.sql", "CREATE TABLE a (id INTEGER);")
    _write(mdir, "0002_b.sql", "CREATE TABLE b (id INTEGER REFERENCES a(id));")
    assert apply_migrations(db, mdir) == [1, 2]
    assert {"a", "b", "schema_migrations"} <= _tables(db)


def test_is_idempotent(tmp_path, mdir):
    db = str(tmp_path / "m.db")
    _write(mdir, "0001_a.sql", "CREATE TABLE a (id INTEGER);")
    assert apply_migrations(db, mdir) == [1]
    assert apply_migrations(db, mdir) == []


def test_new_migration_applies_to_existing_data(tmp_path, mdir):
    db = str(tmp_path / "m.db")
    _write(mdir, "0001_a.sql", "CREATE TABLE a (id INTEGER);")
    apply_migrations(db, mdir)
    conn = sqlite3.connect(db)
    conn.execute("INSERT INTO a VALUES (7)")
    conn.commit()
    conn.close()
    _write(mdir, "0002_add_col.sql", "ALTER TABLE a ADD COLUMN note TEXT;")
    assert apply_migrations(db, mdir) == [2]
    conn = sqlite3.connect(db)
    assert conn.execute("SELECT id, note FROM a").fetchall() == [(7, None)]
    conn.close()


def test_refuses_a_modified_applied_migration(tmp_path, mdir):
    db = str(tmp_path / "m.db")
    _write(mdir, "0001_a.sql", "CREATE TABLE a (id INTEGER);")
    apply_migrations(db, mdir)
    _write(mdir, "0001_a.sql", "CREATE TABLE a (id INTEGER, extra TEXT);")
    with pytest.raises(MigrationError, match="modified"):
        apply_migrations(db, mdir)


def test_refuses_a_gap_and_bad_names(tmp_path, mdir):
    db = str(tmp_path / "m.db")
    _write(mdir, "0001_a.sql", "CREATE TABLE a (id INTEGER);")
    _write(mdir, "0003_c.sql", "CREATE TABLE c (id INTEGER);")
    with pytest.raises(MigrationError, match="gap"):
        apply_migrations(db, mdir)
    (mdir / "0003_c.sql").unlink()
    _write(mdir, "notes.sql", "SELECT 1;")
    with pytest.raises(MigrationError, match="Bad migration file name"):
        apply_migrations(db, mdir)


def test_refuses_a_database_newer_than_the_code(tmp_path, mdir):
    db = str(tmp_path / "m.db")
    _write(mdir, "0001_a.sql", "CREATE TABLE a (id INTEGER);")
    _write(mdir, "0002_b.sql", "CREATE TABLE b (id INTEGER);")
    apply_migrations(db, mdir)
    (mdir / "0002_b.sql").unlink()
    with pytest.raises(MigrationError, match="newer database"):
        apply_migrations(db, mdir)


def test_failed_migration_rolls_back(tmp_path, mdir):
    db = str(tmp_path / "m.db")
    _write(mdir, "0001_a.sql", "CREATE TABLE ok (id INTEGER); INSERT INTO missing VALUES (1);")
    with pytest.raises(MigrationError, match="failed"):
        apply_migrations(db, mdir)
    assert "ok" not in _tables(db)


def test_real_migrations_apply_cleanly(tmp_path):
    db = str(tmp_path / "real.db")
    assert apply_migrations(db) == [1, 2, 3, 4, 5, 6, 7]
    tables = _tables(db)
    assert {"users", "messages", "replay_runs", "stop_requests"} <= tables
    assert not {"kb_categories", "kb_subcategories", "kb_documents", "kb_seeded"} & tables  # moved to knowledgebase.db


def test_the_knowledge_database_has_its_own_migrations(tmp_path):
    from db.migrate import KB_MIGRATIONS_DIR

    kb = str(tmp_path / "kb.db")
    assert apply_migrations(kb, KB_MIGRATIONS_DIR) == [1, 2]
    tables = _tables(kb)
    assert {
        "kb_categories",
        "kb_subcategories",
        "kb_documents",
        "kb_seeded",
        "knowledge_base_choice",
        "kb_document_versions",
    } <= tables
    assert not {"users", "messages", "agents", "replay_runs"} & tables
    assert apply_migrations(kb, KB_MIGRATIONS_DIR) == []


def test_older_conversations_get_their_configuration_from_what_they_used(tmp_path):
    """Migration 0006 fills agent and model from the latest answer, else the saved preferences, else leaves the model empty."""
    import shutil

    from db.migrate import MIGRATIONS_DIR

    early = tmp_path / "early"
    early.mkdir()
    for path in sorted(MIGRATIONS_DIR.glob("*.sql")):
        if int(path.name[:4]) <= 5:
            shutil.copy(path, early / path.name)
    db = str(tmp_path / "old.db")
    assert apply_migrations(db, early) == [1, 2, 3, 4, 5]
    conn = sqlite3.connect(db)
    conn.executescript(
        """
        INSERT INTO users VALUES ('u1', 'ann', 'x', '2026-01-01T00:00:00'), ('u2', 'bob', 'x', '2026-01-01T00:00:00');
        INSERT INTO agents VALUES ('assistant', 'General assistant', 'p', 1), ('code', 'Code assistant', 'p', 2);
        INSERT INTO user_preferences (user_id, agent_id, model, updated_at) VALUES ('u2', 'code', 'pref-model', 'now');
        INSERT INTO conversations VALUES ('c-used', 'u1', 0, '2026-03-04T10:00:00', '2026-03-04T10:00:00', NULL);
        INSERT INTO conversations VALUES ('c-pref', 'u2', 0, '2026-03-05T10:00:00', '2026-03-05T10:00:00', NULL);
        INSERT INTO conversations VALUES ('c-none', 'u1', 0, '2026-03-06T10:00:00', '2026-03-06T10:00:00', NULL);
        INSERT INTO messages (message_id, conversation_id, sequence_number, role, content, status, model, agent, demo, created_at)
          VALUES ('m1', 'c-used', 1, 'user', 'hi', 'complete', NULL, NULL, 0, 'now'),
                 ('m2', 'c-used', 2, 'assistant', 'old', 'complete', 'model-x', 'General assistant', 0, 'now'),
                 ('m3', 'c-used', 3, 'assistant', 'new', 'complete', 'model-y', 'Code assistant', 0, 'now');
        """
    )
    conn.commit()
    conn.close()
    assert apply_migrations(db) == [6, 7]
    conn = sqlite3.connect(db)
    rows = {
        r[0]: r[1:]
        for r in conn.execute(
            "SELECT conversation_id, name, agent_id, model, reasoning_level, kb_summary_tool, source_conversation_id FROM conversations"
        )
    }
    assert rows["c-used"] == ("code 2026-03-04", "code", "model-y", "default", 0, None)  # the latest answer wins
    assert rows["c-pref"] == ("code 2026-03-05", "code", "pref-model", "default", 0, None)  # saved preferences
    assert rows["c-none"] == ("assistant 2026-03-06", "assistant", "", "default", 0, None)  # model filled in on open
    assert conn.execute("SELECT message_type FROM messages WHERE message_id = 'm1'").fetchone() == ("chat",)
    conn.close()
