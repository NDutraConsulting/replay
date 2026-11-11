"""Document versions (knowledgebase.db) and the 10 KB size limit."""

import json
import sqlite3
from pathlib import Path

from db.kb_versions import backfill, content_hash
from services import knowledge_base_service

LIMIT = 10 * 1024


def _versions(kb_path: str, document_id: str) -> list[tuple]:
    conn = sqlite3.connect(kb_path)
    try:
        return conn.execute(
            "SELECT version_number, content, content_hash FROM kb_document_versions WHERE document_id = ? "
            "ORDER BY version_number",
            (document_id,),
        ).fetchall()
    finally:
        conn.close()


def _document(client, agent="code"):
    """A fresh file in a fresh category and sub category."""
    category = client.post(f"/api/agents/{agent}/categories", json={"name": "Versions"}).json()["category_id"]
    sub = client.post(f"/api/categories/{category}/subcategories", json={"name": "Notes"}).json()["subcategory_id"]
    return client.post(
        f"/api/subcategories/{sub}/documents", json={"title": "note.txt", "content": "first text", "status": "current"}
    ).json()


def test_a_new_file_gets_version_one_with_a_uuid_and_a_hash(logged_in_client, kb_db):
    document = _document(logged_in_client)
    assert document["version_number"] == 1 and len(document["version_id"]) == 36
    assert document["size_bytes"] == len(b"first text")
    assert _versions(kb_db, document["document_id"]) == [(1, "first text", content_hash("first text"))]


def test_a_new_version_is_made_only_when_the_text_really_changes(logged_in_client, kb_db):
    document = _document(logged_in_client)
    url = f"/api/documents/{document['document_id']}"
    assert logged_in_client.patch(url, json={"status": "archived"}).json()["version_number"] == 1  # status only
    assert logged_in_client.patch(url, json={"content": "first text"}).json()["version_number"] == 1  # same text
    changed = logged_in_client.patch(url, json={"content": "second text"}).json()
    assert changed["version_number"] == 2 and changed["version_id"] != document["version_id"]
    assert logged_in_client.patch(url, json={"content": "first text"}).json()["version_number"] == 3  # back, but new
    assert [v[:2] for v in _versions(kb_db, document["document_id"])] == [
        (1, "first text"),
        (2, "second text"),
        (3, "first text"),
    ]


def test_the_tree_shows_each_files_current_version_and_size(logged_in_client):
    document = _document(logged_in_client)
    logged_in_client.patch(f"/api/documents/{document['document_id']}", json={"content": "é" * 10})
    tree = logged_in_client.get("/api/agents/code/knowledge-base").json()
    found = next(
        d for c in tree["categories"] for s in c["subcategories"] for d in s["documents"] if d["title"] == "note.txt"
    )
    assert found["version_number"] == 2 and found["size_bytes"] == 20


def test_deleting_a_file_deletes_its_versions(logged_in_client, kb_db):
    document = _document(logged_in_client)
    logged_in_client.patch(f"/api/documents/{document['document_id']}", json={"content": "more"})
    assert logged_in_client.delete(f"/api/documents/{document['document_id']}").status_code == 204
    assert _versions(kb_db, document["document_id"]) == []


def test_seeded_files_have_a_version_and_the_seeds_fit_the_limit(logged_in_client, kb_db):
    tree = logged_in_client.get("/api/agents/research/knowledge-base").json()
    documents = [d for c in tree["categories"] for s in c["subcategories"] for d in s["documents"]]
    assert documents and all(d["version_number"] == 1 for d in documents)
    seeds = json.loads((Path(__file__).parent.parent / "db" / "kb_seeds" / "knowledge_bases.json").read_text())
    sizes = [
        len(doc["content"].encode())
        for categories in seeds.values()
        for category in categories
        for sub in category["subcategories"]
        for doc in sub["documents"]
    ]
    assert sizes and max(sizes) <= LIMIT


def test_the_backfill_gives_old_files_a_version_once(logged_in_client, kb_db):
    document = _document(logged_in_client)
    conn = sqlite3.connect(kb_db)
    conn.execute("DELETE FROM kb_document_versions WHERE document_id = ?", (document["document_id"],))
    conn.commit()
    conn.close()
    assert backfill(kb_db) == 1
    assert [v[:2] for v in _versions(kb_db, document["document_id"])] == [(1, "first text")]
    assert backfill(kb_db) == 0  # idempotent


# ---- the 10 KB limit
def _sub(client):
    category = client.post("/api/agents/code/categories", json={"name": "Big"}).json()["category_id"]
    return client.post(f"/api/categories/{category}/subcategories", json={"name": "Files"}).json()["subcategory_id"]


def test_a_file_of_exactly_ten_kb_is_accepted_and_one_byte_more_is_not(logged_in_client):
    sub = _sub(logged_in_client)
    url = f"/api/subcategories/{sub}/documents"
    assert logged_in_client.post(url, json={"title": "ok", "content": "x" * LIMIT}).status_code == 201
    response = logged_in_client.post(url, json={"title": "no", "content": "x" * (LIMIT + 1)})
    assert response.status_code == 422
    error = response.json()["error"]
    assert error["code"] == "kb_document_too_large"
    assert "split your content into smaller documents" in error["message"]
    assert "does not currently support semantic search" in error["message"]


def test_the_limit_counts_utf8_bytes_not_characters(logged_in_client):
    sub = _sub(logged_in_client)
    url = f"/api/subcategories/{sub}/documents"
    assert logged_in_client.post(url, json={"title": "a", "content": "é" * (LIMIT // 2)}).status_code == 201
    assert logged_in_client.post(url, json={"title": "b", "content": "é" * (LIMIT // 2 + 1)}).status_code == 422


def test_editing_a_file_past_the_limit_is_refused_and_keeps_the_old_text(logged_in_client, kb_db):
    document = _document(logged_in_client)
    response = logged_in_client.patch(f"/api/documents/{document['document_id']}", json={"content": "x" * (LIMIT + 1)})
    assert response.status_code == 422 and response.json()["error"]["code"] == "kb_document_too_large"
    assert logged_in_client.get(f"/api/documents/{document['document_id']}").json()["content"] == "first text"
    assert len(_versions(kb_db, document["document_id"])) == 1


def test_an_upload_over_the_limit_reports_the_code_but_keeps_the_good_files(logged_in_client):
    sub = _sub(logged_in_client)
    response = logged_in_client.post(
        f"/api/subcategories/{sub}/documents:upload",
        files=[("files", ("ok.txt", b"fine", "text/plain")), ("files", ("big.txt", b"x" * (LIMIT + 1), "text/plain"))],
    )
    ok, big = response.json()["results"]
    assert ok["ok"] and not big["ok"] and big["error_code"] == "kb_document_too_large"
    assert "split your content" in big["error"]


def test_the_service_message_names_the_limit(test_settings):
    assert "larger than 10 KB" in knowledge_base_service.too_large_message(test_settings)
