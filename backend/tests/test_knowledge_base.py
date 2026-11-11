import sqlite3

RESEARCH = [
    "Networks", "Penetration Testing", "HIPAA", "SOC2", "Social Engineering",
    "Security Tools", "Certifications", "Agentic Security", "Security Monitoring", "Books",
]  # fmt: skip


def tree(client, agent="research"):
    response = client.get(f"/api/agents/{agent}/knowledge-base")
    assert response.status_code == 200, response.text
    return response.json()


def names(categories):
    return [c["name"] for c in categories]


def first_sub(client, agent="research"):
    return tree(client, agent)["categories"][0]["subcategories"][0]


def new_category(client, name, agent="research"):
    return client.post(f"/api/agents/{agent}/categories", json={"name": name})


# ---- seeding
def test_research_agent_is_seeded_with_the_ten_security_categories(logged_in_client):
    categories = tree(logged_in_client)["categories"]
    assert names(categories) == RESEARCH
    assert all(c["subcategories"] and all(s["documents"] for s in c["subcategories"]) for c in categories)


def test_code_agent_has_python_and_cpp_and_the_assistant_is_empty(logged_in_client):
    assert names(tree(logged_in_client, "code")["categories"]) == ["Python", "C++"]
    assert tree(logged_in_client, "assistant")["categories"] == []


def test_seed_documents_use_known_statuses_and_txt_names(logged_in_client):
    statuses = set()
    for category in tree(logged_in_client)["categories"]:
        for sub in category["subcategories"]:
            for doc in sub["documents"]:
                statuses.add(doc["status"])
                assert doc["title"].endswith((".txt",))
                assert doc["content"]
    assert statuses <= {"current", "pending-review", "malicious-active", "quarantined", "archived"}
    assert {"current", "pending-review", "archived"} <= statuses


def test_seeding_happens_once_so_deleted_data_stays_deleted(logged_in_client):
    for category in tree(logged_in_client)["categories"]:
        assert logged_in_client.delete(f"/api/categories/{category['category_id']}").status_code == 204
    assert tree(logged_in_client)["categories"] == []


def test_creating_first_still_seeds_the_defaults_once_and_keeps_the_new_category_last(logged_in_client):
    assert new_category(logged_in_client, "Created before ever opening the page").status_code == 201
    categories = names(tree(logged_in_client)["categories"])
    assert categories[:-1] == RESEARCH and categories[-1] == "Created before ever opening the page"
    assert names(tree(logged_in_client)["categories"]) == categories  # no second seeding


def test_unknown_agent_is_404(logged_in_client):
    assert logged_in_client.get("/api/agents/nope/knowledge-base").status_code == 404


def test_requires_login(client):
    assert client.get("/api/agents/research/knowledge-base").status_code == 401


# ---- categories / sub categories
def test_create_category_trims_and_rejects_empty_and_duplicates_case_insensitively(logged_in_client):
    created = new_category(logged_in_client, "  Cloud security ")
    assert created.status_code == 201 and created.json()["name"] == "Cloud security"
    assert tree(logged_in_client)["categories"][-1]["name"] == "Cloud security"
    empty = new_category(logged_in_client, "   ")
    assert empty.status_code == 422 and empty.json()["error"]["message"] == "Enter a category name."
    dup = new_category(logged_in_client, "cloud SECURITY")
    assert dup.status_code == 409
    assert dup.json()["error"] == {
        "code": "duplicate_name",
        "message": 'A category named "cloud SECURITY" already exists.',
    }


def test_the_same_category_name_is_fine_for_a_different_agent(logged_in_client):
    assert new_category(logged_in_client, "Shared name", "research").status_code == 201
    assert new_category(logged_in_client, "Shared name", "code").status_code == 201


def test_create_subcategory(logged_in_client):
    category = new_category(logged_in_client, "Cloud").json()
    url = f"/api/categories/{category['category_id']}/subcategories"
    created = logged_in_client.post(url, json={"name": " IAM "})
    assert created.status_code == 201 and created.json()["name"] == "IAM"
    assert logged_in_client.post(url, json={"name": "iam"}).status_code == 409
    assert logged_in_client.post(url, json={"name": ""}).json()["error"]["message"] == "Enter a sub category name."
    assert logged_in_client.post("/api/categories/missing/subcategories", json={"name": "x"}).status_code == 404


def test_deleting_a_category_removes_its_sub_categories_and_documents(logged_in_client, kb_db):
    category = tree(logged_in_client)["categories"][0]
    assert logged_in_client.delete(f"/api/categories/{category['category_id']}").status_code == 204
    conn = sqlite3.connect(kb_db)
    for sub in category["subcategories"]:
        assert (
            conn.execute(
                "SELECT COUNT(*) FROM kb_subcategories WHERE subcategory_id=?", (sub["subcategory_id"],)
            ).fetchone()[0]
            == 0
        )
        for doc in sub["documents"]:
            assert (
                conn.execute("SELECT COUNT(*) FROM kb_documents WHERE document_id=?", (doc["document_id"],)).fetchone()[
                    0
                ]
                == 0
            )
    assert logged_in_client.delete(f"/api/categories/{category['category_id']}").status_code == 404


def test_deleting_a_sub_category(logged_in_client):
    sub = first_sub(logged_in_client)
    assert logged_in_client.delete(f"/api/subcategories/{sub['subcategory_id']}").status_code == 204
    assert sub["name"] not in [s["name"] for s in tree(logged_in_client)["categories"][0]["subcategories"]]


# ---- documents
def test_create_document_defaults_to_pending_review_and_adds_txt(logged_in_client):
    sub = first_sub(logged_in_client)
    created = logged_in_client.post(f"/api/subcategories/{sub['subcategory_id']}/documents", json={"title": "my notes"})
    assert created.status_code == 201
    body = created.json()
    assert body["title"] == "my notes.txt" and body["status"] == "pending-review" and body["content"] == ""


def test_file_name_normalization(logged_in_client):
    sub = first_sub(logged_in_client)
    url = f"/api/subcategories/{sub['subcategory_id']}/documents"
    assert logged_in_client.post(url, json={"title": "readme.md"}).json()["title"] == "readme.md"
    assert logged_in_client.post(url, json={"title": "a/b\\c"}).json()["title"] == "a-b-c.txt"


def test_document_validation_and_duplicates(logged_in_client):
    sub = first_sub(logged_in_client)
    url = f"/api/subcategories/{sub['subcategory_id']}/documents"
    existing = sub["documents"][0]["title"]
    dup = logged_in_client.post(url, json={"title": existing.upper()})
    assert dup.status_code == 409 and "already exists in this sub category" in dup.json()["error"]["message"]
    assert logged_in_client.post(url, json={"title": "  "}).json()["error"]["message"] == "Enter a file name."
    assert logged_in_client.post(url, json={"title": "x", "status": "bogus"}).status_code == 422
    too_big = logged_in_client.post(url, json={"title": "big", "content": "é" * 150_000})
    assert too_big.status_code == 422 and too_big.json()["error"]["code"] == "kb_document_too_large"
    assert "larger than 10 KB" in too_big.json()["error"]["message"]


def test_update_document_status_and_content(logged_in_client):
    doc = first_sub(logged_in_client)["documents"][0]
    url = f"/api/documents/{doc['document_id']}"
    updated = logged_in_client.patch(url, json={"status": "quarantined", "content": "new text"})
    assert updated.status_code == 200
    body = updated.json()
    assert body["status"] == "quarantined" and body["content"] == "new text" and body["title"] == doc["title"]
    assert body["updated_at"] >= doc["updated_at"]
    assert logged_in_client.get(url).json()["status"] == "quarantined"
    assert logged_in_client.patch(url, json={"status": "nope"}).status_code == 422


def test_rename_to_an_existing_name_conflicts_but_keeping_your_own_name_is_fine(logged_in_client):
    sub = [s for c in tree(logged_in_client)["categories"] for s in c["subcategories"] if len(s["documents"]) >= 2]
    a, b = sub[0]["documents"][:2]
    assert logged_in_client.patch(f"/api/documents/{a['document_id']}", json={"title": b["title"]}).status_code == 409
    assert logged_in_client.patch(f"/api/documents/{a['document_id']}", json={"title": a["title"]}).status_code == 200


def test_delete_document(logged_in_client):
    doc = first_sub(logged_in_client)["documents"][0]
    url = f"/api/documents/{doc['document_id']}"
    assert logged_in_client.delete(url).status_code == 204
    assert logged_in_client.get(url).status_code == 404


def test_html_in_content_is_stored_verbatim_not_interpreted(logged_in_client):
    sub = first_sub(logged_in_client)
    url = f"/api/subcategories/{sub['subcategory_id']}/documents"
    body = logged_in_client.post(url, json={"title": "x", "content": "<script>alert(1)</script>"}).json()
    assert body["content"] == "<script>alert(1)</script>"


# ---- upload
def upload(client, sub_id, files, status=None):
    data = {"status": status} if status else {}
    return client.post(f"/api/subcategories/{sub_id}/documents:upload", files=files, data=data)


def test_upload_accepts_text_files_with_the_chosen_status(logged_in_client):
    sub = first_sub(logged_in_client)
    response = upload(
        logged_in_client,
        sub["subcategory_id"],
        [("files", ("uploaded.txt", b"hello world", "text/plain")), ("files", ("notes.md", b"# hi", "text/markdown"))],
        status="current",
    )
    assert response.status_code == 200
    results = response.json()["results"]
    assert [r["ok"] for r in results] == [True, True]
    assert results[0]["document"]["content"] == "hello world" and results[0]["document"]["status"] == "current"
    assert results[1]["document"]["title"] == "notes.md"


def test_upload_reports_each_rejected_file_but_keeps_the_good_ones(logged_in_client):
    sub = first_sub(logged_in_client)
    existing = sub["documents"][0]["title"]
    response = upload(
        logged_in_client,
        sub["subcategory_id"],
        [
            ("files", ("good.txt", b"ok", "text/plain")),
            ("files", ("bad.png", b"\x89PNG", "image/png")),
            ("files", ("big.txt", b"x" * (10 * 1024 + 1), "text/plain")),
            ("files", ("binary.txt", b"\xff\xfe\x00\x01", "text/plain")),
            ("files", (existing, b"dup", "text/plain")),
        ],
    )
    results = response.json()["results"]
    assert [r["ok"] for r in results] == [True, False, False, False, False]
    assert "is not a text file" in results[1]["error"]
    assert "larger than 10 KB" in results[2]["error"] and results[2]["error_code"] == "kb_document_too_large"
    assert "not valid UTF-8" in results[3]["error"]
    assert "already exists" in results[4]["error"]
    titles = [d["title"] for d in first_sub(logged_in_client)["documents"]]
    assert "good.txt" in titles and "bad.png" not in titles


def test_upload_defaults_to_pending_review_and_validates_status(logged_in_client):
    sub = first_sub(logged_in_client)
    ok = upload(logged_in_client, sub["subcategory_id"], [("files", ("a.txt", b"x", "text/plain"))])
    assert ok.json()["results"][0]["document"]["status"] == "pending-review"
    bad = upload(logged_in_client, sub["subcategory_id"], [("files", ("b.txt", b"x", "text/plain"))], status="bogus")
    assert bad.status_code == 422


def test_upload_limits_file_count_and_needs_a_real_sub_category(logged_in_client):
    sub = first_sub(logged_in_client)
    many = [("files", (f"f{i}.txt", b"x", "text/plain")) for i in range(21)]
    assert upload(logged_in_client, sub["subcategory_id"], many).status_code == 422
    assert upload(logged_in_client, "missing", [("files", ("a.txt", b"x", "text/plain"))]).status_code == 404


# ---- reset
def test_reset_restores_the_defaults_for_that_agent_only(logged_in_client):
    new_category(logged_in_client, "Extra")
    new_category(logged_in_client, "Extra code", "code")
    reset = logged_in_client.post("/api/agents/research/knowledge-base/reset")
    assert reset.status_code == 200 and names(reset.json()["categories"]) == RESEARCH
    assert "Extra code" in names(tree(logged_in_client, "code")["categories"])


def test_reset_brings_back_a_knowledge_base_that_was_emptied(logged_in_client):
    for category in tree(logged_in_client)["categories"]:
        logged_in_client.delete(f"/api/categories/{category['category_id']}")
    assert names(logged_in_client.post("/api/agents/research/knowledge-base/reset").json()["categories"]) == RESEARCH


# ---- ownership
def test_users_have_separate_knowledge_bases(logged_in_client, other_client):
    new_category(logged_in_client, "Mine only")
    assert "Mine only" not in names(tree(other_client)["categories"])
    assert names(tree(other_client)["categories"]) == RESEARCH


def test_users_cannot_touch_each_others_items(logged_in_client, other_client):
    category = tree(logged_in_client)["categories"][0]
    sub = category["subcategories"][0]
    doc = sub["documents"][0]
    tree(other_client)  # make sure the other user has their own data too
    assert other_client.delete(f"/api/categories/{category['category_id']}").status_code == 404
    assert (
        other_client.post(f"/api/categories/{category['category_id']}/subcategories", json={"name": "x"}).status_code
        == 404
    )
    assert other_client.delete(f"/api/subcategories/{sub['subcategory_id']}").status_code == 404
    assert (
        other_client.post(f"/api/subcategories/{sub['subcategory_id']}/documents", json={"title": "x"}).status_code
        == 404
    )
    assert other_client.get(f"/api/documents/{doc['document_id']}").status_code == 404
    assert other_client.patch(f"/api/documents/{doc['document_id']}", json={"status": "archived"}).status_code == 404
    assert other_client.delete(f"/api/documents/{doc['document_id']}").status_code == 404
    assert upload(other_client, sub["subcategory_id"], [("files", ("a.txt", b"x", "text/plain"))]).status_code == 404
    assert logged_in_client.get(f"/api/documents/{doc['document_id']}").status_code == 200
