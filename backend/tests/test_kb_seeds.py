"""The knowledge base seed content and the seeder (services.knowledge_base_service.seed_for_user, scripts/seed_knowledge.py)."""

import importlib.util
import sqlite3
from pathlib import Path

import pytest

from db import seed_knowledge_bases
from errors import AppError
from services import knowledge_base_service as kb_service

ROOT = Path(__file__).parent.parent
STATUSES = {"current", "pending-review", "malicious-active", "quarantined", "archived"}
AGENTS = ("assistant", "code", "research")


def test_every_agent_has_seed_data_and_nothing_else_does():
    assert set(seed_knowledge_bases._load()) == set(AGENTS)


def test_the_seed_content_is_valid_and_would_pass_the_apis_own_rules():
    for agent in AGENTS:
        categories = seed_knowledge_bases.categories_for(agent)
        assert len({c["name"].lower() for c in categories}) == len(categories), f"{agent}: duplicate category names"
        for category in categories:
            assert category["name"].strip() and category["subcategories"], f"{agent}/{category['name']}: empty"
            assert len({s["name"].lower() for s in category["subcategories"]}) == len(category["subcategories"])
            for sub in category["subcategories"]:
                assert sub["documents"], f"{agent}/{category['name']}/{sub['name']}: no files"
                assert len({d["title"].lower() for d in sub["documents"]}) == len(sub["documents"])
                for doc in sub["documents"]:
                    assert doc["status"] in STATUSES
                    assert kb_service.normalize_title(doc["title"]) == doc["title"], (
                        f"{doc['title']}: not a clean file name"
                    )
                    assert doc["content"].strip() and len(doc["content"].encode()) < 200 * 1024


def test_the_research_and_code_agents_have_the_documented_categories():
    assert [c["name"] for c in seed_knowledge_bases.categories_for("research")][:3] == [
        "Networks",
        "Penetration Testing",
        "HIPAA",
    ]
    assert [c["name"] for c in seed_knowledge_bases.categories_for("code")] == ["Python", "C++"]
    assert seed_knowledge_bases.categories_for("assistant") == []
    assert any(
        d["status"] == "current"
        for c in seed_knowledge_bases.categories_for("research")
        for s in c["subcategories"]
        for d in s["documents"]
    )


async def test_seed_for_user_seeds_every_agent_and_is_idempotent(test_settings, db, kb_db):
    first = await kb_service.seed_for_user(test_settings, "demo")
    assert first == [("assistant", 0), ("code", 2), ("research", 10)]
    conn = sqlite3.connect(kb_db)
    rows = conn.execute("SELECT COUNT(*) FROM kb_categories").fetchone()[0]
    conn.execute("UPDATE kb_documents SET content = 'my edit' WHERE rowid = (SELECT MIN(rowid) FROM kb_documents)")
    conn.commit()
    assert await kb_service.seed_for_user(test_settings, "demo") == first  # seeding again changes nothing
    assert conn.execute("SELECT COUNT(*) FROM kb_categories").fetchone()[0] == rows
    assert conn.execute("SELECT COUNT(*) FROM kb_documents WHERE content = 'my edit'").fetchone()[0] == 1


async def test_seed_for_user_can_target_one_agent_and_reset_it(test_settings, db, kb_db):
    assert await kb_service.seed_for_user(test_settings, "demo", ["code"]) == [("code", 2)]
    conn = sqlite3.connect(kb_db)
    conn.execute("DELETE FROM kb_categories")
    conn.commit()
    assert await kb_service.seed_for_user(test_settings, "demo", ["code"]) == [
        ("code", 0)
    ]  # seeded once: stays deleted
    assert await kb_service.seed_for_user(test_settings, "demo", ["code"], reset=True) == [("code", 2)]
    assert conn.execute("SELECT COUNT(*) FROM kb_categories").fetchone()[0] == 2  # only that agent was touched


async def test_seed_for_user_rejects_unknown_users_and_agents(test_settings, db):
    with pytest.raises(AppError, match="User not found"):
        await kb_service.seed_for_user(test_settings, "nobody")
    with pytest.raises(AppError, match="Unknown agent: nope"):
        await kb_service.seed_for_user(test_settings, "demo", ["nope"])


def load_script(test_settings, monkeypatch):
    spec = importlib.util.spec_from_file_location("seed_knowledge_script", ROOT / "scripts" / "seed_knowledge.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    monkeypatch.setattr(module, "settings", test_settings)
    return module


def test_the_seed_script_seeds_and_reports(test_settings, db, monkeypatch, capsys):
    script = load_script(test_settings, monkeypatch)
    assert script.main(["--agent", "research"]) == 0
    assert "demo / research: 10 categories (ready)" in capsys.readouterr().out
    assert script.main(["--agent", "research", "--reset"]) == 0
    assert "(reset to the defaults)" in capsys.readouterr().out


def test_the_seed_script_explains_a_bad_user_or_agent(test_settings, db, monkeypatch, capsys):
    script = load_script(test_settings, monkeypatch)
    assert script.main(["--username", "nobody"]) == 1
    assert "User not found" in capsys.readouterr().err
    assert script.main(["--agent", "nope"]) == 1
    assert "Unknown agent: nope" in capsys.readouterr().err
