"""The knowledge base lives in its own SQLite file."""

import os
import sqlite3
import subprocess
import sys
from pathlib import Path

from repositories import kb_repository

ROOT = Path(__file__).parent.parent


def table_names(path):
    conn = sqlite3.connect(path)
    try:
        return {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    finally:
        conn.close()


def test_the_knowledge_base_is_stored_in_its_own_file(logged_in_client, db, kb_db):
    assert db != kb_db
    logged_in_client.get("/api/agents/research/knowledge-base")  # first use seeds it
    app_tables, kb_tables = table_names(db), table_names(kb_db)
    assert not {"kb_categories", "kb_subcategories", "kb_documents", "kb_seeded", "knowledge_base_choice"} & app_tables
    assert {"kb_categories", "kb_subcategories", "kb_documents", "kb_seeded", "knowledge_base_choice"} <= kb_tables
    assert not {"users", "sessions", "messages", "agents", "replay_runs"} & kb_tables
    conn = sqlite3.connect(kb_db)
    assert conn.execute("SELECT COUNT(*) FROM kb_categories").fetchone()[0] == 10
    assert conn.execute("SELECT COUNT(*) FROM kb_documents WHERE status = 'current'").fetchone()[0] > 0


def test_each_users_rows_are_scoped_by_user_id_without_a_foreign_key(logged_in_client, other_client, kb_db):
    logged_in_client.get("/api/agents/research/knowledge-base")
    other_client.get("/api/agents/research/knowledge-base")
    conn = sqlite3.connect(kb_db)
    owners = {r[0] for r in conn.execute("SELECT DISTINCT user_id FROM kb_categories")}
    assert len(owners) == 2
    assert "FOREIGN KEY" not in conn.execute("SELECT sql FROM sqlite_master WHERE name = 'kb_categories'").fetchone()[0]


async def test_deleting_a_users_knowledge_clears_every_table_in_the_knowledge_database(logged_in_client, kb_db):
    logged_in_client.get("/api/agents/research/knowledge-base")
    conn = sqlite3.connect(kb_db)
    user_id = conn.execute("SELECT user_id FROM kb_categories LIMIT 1").fetchone()[0]
    conn.execute(
        "INSERT INTO knowledge_base_choice (choice_id, user_id, agent_id, scope, scope_id, ref, step_number, level, "
        "options_json, outcome, created_at) VALUES ('ch1', ?, 'research', 'chat', 'c1', 'r1', 1, 'category', '[]', 'none', 'now')",
        (user_id,),
    )
    conn.commit()
    await kb_repository.delete_user_knowledge(kb_db, user_id)
    for table in ("kb_categories", "kb_subcategories", "kb_documents", "kb_seeded", "knowledge_base_choice"):
        assert conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0] == 0, table


def test_an_unknown_agent_is_checked_against_the_app_database(logged_in_client):
    assert logged_in_client.get("/api/agents/not-an-agent/knowledge-base").status_code == 404


# ---- reset tooling (scripts/reset_db.py)
def run_reset(tmp_path, *args):
    app, kb = tmp_path / "a.db", tmp_path / "k.db"
    for path in (app, kb):
        path.write_text("x")
        Path(f"{path}-wal").write_text("x")
    env = {**os.environ, "DATABASE_PATH": str(app), "KNOWLEDGE_DB_PATH": str(kb)}
    result = subprocess.run(
        [sys.executable, str(ROOT / "scripts" / "reset_db.py"), *args],
        cwd=ROOT,
        env=env,
        capture_output=True,
        text=True,
    )
    return result, app, kb


def test_reset_refuses_without_yes_and_deletes_nothing(tmp_path):
    result, app, kb = run_reset(tmp_path)
    assert result.returncode == 2 and app.exists() and kb.exists()


def test_reset_deletes_both_files_by_default(tmp_path):
    result, app, kb = run_reset(tmp_path, "--yes")
    assert result.returncode == 0
    assert not app.exists() and not kb.exists()
    assert not Path(f"{app}-wal").exists() and not Path(f"{kb}-wal").exists()


def test_reset_can_target_one_file(tmp_path):
    result, app, kb = run_reset(tmp_path, "--yes", "--only=knowledge")
    assert result.returncode == 0 and app.exists() and not kb.exists()
    result, app, kb = run_reset(tmp_path, "--yes", "--only=app")
    assert result.returncode == 0 and not app.exists() and kb.exists()


def test_reset_rejects_an_unknown_target(tmp_path):
    result, app, kb = run_reset(tmp_path, "--yes", "--only=everything")
    assert result.returncode == 2 and app.exists() and kb.exists()
