"""Phase 8 in chat: the fixed conversation configuration, files stored by reference, the KB-summary-tool,
reasoning, deletion of used files, and Compact."""

import sqlite3

import pytest

from tests.routing_helpers import (
    ScriptedModel,
    answer_calls,
    build_kb,
    connect,
    provider_error,
    router_calls,
    summary_calls,
)

CONFIG_FIELDS = ("name", "agent_id", "model", "reasoning_level", "kb_summary_tool")
FILE_TEXT = "Segment the network by trust level."  # net.txt in tests.routing_helpers.build_kb


def new(client, name="Chat", agent_id="assistant", model="m1", reasoning_level="default", kb_summary_tool=False):
    response = client.post(
        "/api/conversations",
        json={
            "name": name,
            "agent_id": agent_id,
            "model": model,
            "reasoning_level": reasoning_level,
            "kb_summary_tool": kb_summary_tool,
        },
    )
    assert response.status_code == 201, response.text
    return response.json()["conversation_id"]


def send(client, cid, content="How should I segment my network?", **extra):
    return client.post(f"/api/conversations/{cid}/messages", json={"content": content, **extra})


def view(client, cid):
    response = client.get(f"/api/conversations/{cid}")
    assert response.status_code == 200, response.text
    return response.json()


def app_rows(db, sql, args=()):
    conn = sqlite3.connect(db)
    try:
        return conn.execute(sql, args).fetchall()
    finally:
        conn.close()


@pytest.fixture
def chat(logged_in_client, routing_on, llm_stub):
    connect(logged_in_client)
    build_kb(logged_in_client)
    ScriptedModel(llm_stub)
    return logged_in_client, llm_stub


# ---- the fixed configuration
def test_a_conversation_keeps_the_settings_it_was_started_with(chat):
    client, _ = chat
    cid = new(client, name="Fixed", agent_id="code", model="m2", reasoning_level="low", kb_summary_tool=True)
    got = view(client, cid)
    assert {k: got[k] for k in CONFIG_FIELDS} == {
        "name": "Fixed",
        "agent_id": "code",
        "model": "m2",
        "reasoning_level": "low",
        "kb_summary_tool": True,
    }
    assert got["source_conversation_id"] is None


def test_a_message_cannot_change_the_agent_or_model(chat, llm_stub):
    client, _ = chat
    cid = new(client, agent_id="code", model="m2")
    response = send(client, cid, "hi", model="m1", agent_id="assistant")
    assert response.status_code == 200
    assert llm_stub.calls[-1]["model"] == "m2" and "software engineering" in llm_stub.calls[-1]["system"]
    assert (
        response.json()["messages"][1]["model"] == "m2" and response.json()["messages"][1]["agent"] == "Code assistant"
    )


@pytest.mark.parametrize("field", ["agent_id", "model", "reasoning_level", "kb_summary_tool"])
def test_the_configuration_cannot_be_changed_afterwards(chat, field):
    client, _ = chat
    cid = new(client)
    value = {"agent_id": "code", "model": "m2", "reasoning_level": "high", "kb_summary_tool": True}[field]
    response = client.patch(f"/api/conversations/{cid}", json={field: value})
    assert response.status_code == 409 and response.json()["error"]["code"] == "configuration_fixed"
    assert view(client, cid)[field] != value


def test_the_name_is_only_a_label_it_can_repeat_and_be_renamed(chat):
    client, _ = chat
    first, second = new(client, name="Same name"), new(client, name="Same name")
    assert first != second  # the uuid is the only identity
    renamed = client.patch(f"/api/conversations/{first}", json={"name": "  A new   label  "})
    assert renamed.status_code == 200 and renamed.json()["name"] == "A new label"
    assert view(client, second)["name"] == "Same name"
    assert client.patch(f"/api/conversations/{first}", json={"name": "Same name"}).status_code == 200  # duplicates fine
    assert client.patch(f"/api/conversations/{first}", json={}).status_code == 422


def test_a_blank_name_is_generated_and_a_long_one_is_trimmed(chat):
    client, _ = chat
    blank = view(client, new(client, name="   "))["name"]
    assert blank.startswith("General assistant 20")
    assert len(view(client, new(client, name="x" * 300))["name"]) == 80


def test_other_users_cannot_read_or_rename_a_conversation(chat, other_client):
    client, _ = chat
    cid = new(client)
    assert other_client.get(f"/api/conversations/{cid}").status_code == 404
    assert other_client.patch(f"/api/conversations/{cid}", json={"name": "mine now"}).status_code == 404
    assert other_client.post(f"/api/conversations/{cid}/compact").status_code == 404


# ---- reasoning
@pytest.mark.parametrize("level", ["none", "minimal", "low", "medium", "high", "xhigh"])
def test_the_reasoning_level_is_sent_to_the_model_as_reasoning_effort(chat, llm_stub, level):
    client, _ = chat
    cid = new(client, reasoning_level=level)
    send(client, cid)
    assert answer_calls(llm_stub)[0]["reasoning_effort"] == level
    routing = router_calls(llm_stub)
    assert routing and all(
        call["reasoning_effort"] == level for call in routing
    )  # the retrieval steps use the same level


def test_the_default_reasoning_level_leaves_the_field_out(chat, llm_stub):
    client, _ = chat
    send(client, new(client))
    assert answer_calls(llm_stub)[0]["reasoning_effort"] is None
    assert all(call["reasoning_effort"] is None for call in router_calls(llm_stub))


@pytest.mark.parametrize("temperature", [0, 0.6, 2])
def test_the_temperature_reaches_the_answer_and_every_retrieval_step(chat, llm_stub, temperature):
    client, _ = chat
    cid = client.post(
        "/api/conversations",
        json={"name": "T", "agent_id": "assistant", "model": "m1", "temperature": temperature},
    ).json()["conversation_id"]
    send(client, cid)
    routing = router_calls(llm_stub)
    assert routing and [c["purpose"] for c in routing][:3] == [
        "kb_route:category",
        "kb_route:subcategory",
        "kb_route:file",
    ]
    assert all(call["temperature"] == temperature for call in [*routing, *answer_calls(llm_stub)])


# ---- files by reference
def test_the_conversation_stores_a_reference_never_the_file_text(chat, db, kb_db):
    client, _ = chat
    cid = new(client)
    user, assistant = send(client, cid, request_id="req-ref-000001").json()["messages"]
    kinds = app_rows(
        db,
        "SELECT message_type, content, kb_version_id, kb_label FROM messages WHERE conversation_id = ? ORDER BY sequence_number",
        (cid,),
    )
    assert [k[0] for k in kinds] == ["chat", "kb_reference", "chat"]
    _, content, version_id, label = kinds[1]
    assert FILE_TEXT not in content and label == "Networks / Segmentation / net.txt"
    assert FILE_TEXT not in " ".join(str(c) for row in kinds for c in row[1:2] if row[0] == "chat")
    assert app_rows(kb_db, "SELECT content FROM kb_document_versions WHERE version_id = ?", (version_id,)) == [
        (FILE_TEXT,)
    ]
    # the page sees two turns, not the internal row, and the answer says which version it was built from
    assert [m["role"] for m in view(client, cid)["messages"]] == ["user", "assistant"]
    file_step = assistant["decision_trace"][2]
    assert (
        file_step["version_id"] == version_id
        and file_step["version_number"] == 1
        and not file_step["kb_version_deleted"]
    )
    assert assistant["kb_summary"] is None and assistant["kb_version_deleted"] is False


def test_each_turn_is_resent_with_the_exact_version_it_was_answered_with(chat, llm_stub):
    client, _ = chat
    cid = new(client)
    send(client, cid, "first question")
    tree = client.get("/api/agents/assistant/knowledge-base").json()
    net = next(
        d for c in tree["categories"] for s in c["subcategories"] for d in s["documents"] if d["title"] == "net.txt"
    )
    assert client.patch(f"/api/documents/{net['document_id']}", json={"content": "REVISED TEXT"}).status_code == 200
    llm_stub.calls.clear()
    send(client, cid, "second question")
    sent = answer_calls(llm_stub)[0]["messages"]
    assert [m["role"] for m in sent] == ["user", "assistant", "user"]
    assert FILE_TEXT in sent[0]["content"] and "REVISED TEXT" not in sent[0]["content"]  # what turn 1 was shown
    assert "REVISED TEXT" in sent[2]["content"] and FILE_TEXT not in sent[2]["content"]  # what turn 2 is shown


def test_a_failed_turn_leaves_no_file_to_be_sent_again(chat, llm_stub, db):
    client, _ = chat
    cid = new(client)
    ScriptedModel(llm_stub, answer_error={"m1": provider_error()})
    assert send(client, cid, "will fail").status_code == 502
    assert app_rows(
        db, "SELECT COUNT(*) FROM messages WHERE conversation_id = ? AND message_type = 'kb_reference'", (cid,)
    ) == [(0,)]
    ScriptedModel(llm_stub)
    llm_stub.calls.clear()
    send(client, cid, "second try")
    sent = answer_calls(llm_stub)[0]["messages"]
    assert sum("reference_document" in m["content"] for m in sent) == 1  # only the turn that is being answered


def test_a_question_that_reaches_no_file_stores_no_reference(chat, llm_stub, db):
    client, _ = chat
    cid = new(client)
    ScriptedModel(llm_stub, choices={"category": None})
    send(client, cid, "nothing relevant")
    assert app_rows(
        db, "SELECT COUNT(*) FROM messages WHERE conversation_id = ? AND message_type != 'chat'", (cid,)
    ) == [(0,)]


# ---- the KB-summary-tool
def test_with_the_tool_on_a_summary_is_sent_instead_of_the_file(chat, llm_stub, db):
    client, _ = chat
    cid = new(client, kb_summary_tool=True)
    ScriptedModel(llm_stub, summary="THE SUMMARY OF THE FILE")
    user, assistant = send(client, cid, "How should I segment my network?").json()["messages"]
    (summary_call,) = summary_calls(llm_stub)
    prompt = summary_call["messages"][0]["content"]
    assert summary_call["model"] == "m1" and len(summary_call["messages"]) == 1
    assert "How should I segment my network?" in prompt and FILE_TEXT in prompt  # the conversation and the file
    assert "less than 1000 words" in prompt and "Considering the current conversation" in prompt
    (answer,) = answer_calls(llm_stub)
    text = answer["messages"][-1]["content"]
    assert "THE SUMMARY OF THE FILE" in text and FILE_TEXT not in text and "<reference_document" not in text
    assert text.endswith("The user's message:\nHow should I segment my network?")
    assert assistant["kb_summary"] == "THE SUMMARY OF THE FILE"
    rows = app_rows(
        db,
        "SELECT message_type, content, kb_version_id FROM messages WHERE conversation_id = ? AND message_type != 'chat'",
        (cid,),
    )
    assert [(r[0], r[1]) for r in rows] == [("kb_summary_tool", "THE SUMMARY OF THE FILE")] and rows[0][2]


def test_with_the_tool_on_earlier_summaries_are_resent_without_new_calls(chat, llm_stub):
    client, _ = chat
    cid = new(client, kb_summary_tool=True)
    ScriptedModel(llm_stub, summary=lambda call: f"summary #{len(summary_calls(llm_stub))}")
    send(client, cid, "first question")
    llm_stub.calls.clear()
    ScriptedModel(llm_stub, summary="second summary")
    send(client, cid, "second question")
    assert len(summary_calls(llm_stub)) == 1  # only the new turn is summarised
    sent = answer_calls(llm_stub)[0]["messages"]
    assert [m["role"] for m in sent] == ["user", "assistant", "user"]
    assert "summary #1" in sent[0]["content"] and "second summary" in sent[2]["content"]


def test_with_the_tool_off_no_summary_call_is_made(chat, llm_stub):
    client, _ = chat
    send(client, new(client))
    assert summary_calls(llm_stub) == []


def test_a_failing_summary_call_fails_the_request_and_keeps_the_prompt(chat, llm_stub, db):
    client, _ = chat
    cid = new(client, kb_summary_tool=True)

    def failing(call):
        raise provider_error()

    ScriptedModel(llm_stub, summary=failing)
    assert send(client, cid, "will fail").status_code == 502
    assert answer_calls(llm_stub) == []
    assert [m["status"] for m in view(client, cid)["messages"]] == ["failed"]
    assert app_rows(
        db, "SELECT COUNT(*) FROM messages WHERE conversation_id = ? AND message_type != 'chat'", (cid,)
    ) == [(0,)]


def test_the_tool_works_in_demo_mode_too(logged_in_client, routing_on):
    cid = new(logged_in_client, model="model-a", kb_summary_tool=True)
    build_kb(logged_in_client)
    response = send(logged_in_client, cid)
    assert response.status_code == 200
    assert response.json()["messages"][1]["kb_summary"].startswith("Demo summary of Networks / Segmentation / net.txt")


# ---- deleting a file that conversations used
def _net_document(client):
    tree = client.get("/api/agents/assistant/knowledge-base").json()
    return next(
        d for c in tree["categories"] for s in c["subcategories"] for d in s["documents"] if d["title"] == "net.txt"
    )


def test_deleting_a_used_file_asks_first_and_then_flags_the_records(chat, llm_stub):
    client, _ = chat
    cid = new(client)
    send(client, cid, "first")
    document = _net_document(client)
    url = f"/api/documents/{document['document_id']}"
    asked = client.delete(url)
    assert asked.status_code == 409
    error = asked.json()["error"]
    assert error["code"] == "kb_version_in_use" and error["details"] == {"conversations": 1, "replays": 0}
    assert _net_document(client)  # nothing was deleted by the question
    assert client.delete(url + "?delete_conversations=false").status_code == 204  # the files go, the records stay
    kept = view(client, cid)
    assert kept["messages"][1]["kb_version_deleted"] is True
    assert kept["messages"][1]["decision_trace"][2]["kb_version_deleted"] is True
    assert kept["messages"][1]["decision_trace"][2]["chosen"]["name"] == "net.txt"  # still readable by name
    # the next request names the deleted file instead of sending text
    ScriptedModel(llm_stub, choices={"category": None})
    llm_stub.calls.clear()
    send(client, cid, "second")
    first_turn = answer_calls(llm_stub)[0]["messages"][0]["content"]
    assert "has since been deleted" in first_turn and "Networks / Segmentation / net.txt" in first_turn
    assert FILE_TEXT not in first_turn


def test_deleting_a_used_file_can_delete_the_records_too(chat, kb_db):
    client, _ = chat
    cid = new(client)
    send(client, cid)
    keep = new(client, name="never used it")
    document = _net_document(client)
    assert client.delete(f"/api/documents/{document['document_id']}?delete_conversations=true").status_code == 204
    assert client.get(f"/api/conversations/{cid}").status_code == 404
    assert client.get(f"/api/conversations/{keep}").status_code == 200
    assert app_rows(kb_db, "SELECT COUNT(*) FROM knowledge_base_choice WHERE scope_id = ?", (cid,)) == [(0,)]


def test_deleting_an_unused_file_does_not_ask(chat):
    client, _ = chat
    tree = client.get("/api/agents/assistant/knowledge-base").json()
    iam = next(
        d for c in tree["categories"] for s in c["subcategories"] for d in s["documents"] if d["title"] == "iam.txt"
    )
    assert client.delete(f"/api/documents/{iam['document_id']}").status_code == 204


def test_deleting_a_category_or_sub_category_that_held_a_used_file_asks_too(chat):
    client, _ = chat
    send(client, new(client))
    tree = client.get("/api/agents/assistant/knowledge-base").json()
    category = next(c for c in tree["categories"] if c["name"] == "Networks")
    sub = category["subcategories"][0]
    assert client.delete(f"/api/subcategories/{sub['subcategory_id']}").status_code == 409
    assert client.delete(f"/api/categories/{category['category_id']}").status_code == 409
    assert client.post("/api/agents/assistant/knowledge-base/reset").status_code == 409
    assert client.delete(f"/api/categories/{category['category_id']}?delete_conversations=false").status_code == 204


# ---- Compact
def test_compact_needs_an_answered_prompt(chat):
    client, _ = chat
    cid = new(client)
    response = client.post(f"/api/conversations/{cid}/compact")
    assert response.status_code == 409 and response.json()["error"]["code"] == "nothing_to_compact"


def test_compact_starts_a_new_conversation_from_a_summary_and_leaves_the_old_one_alone(chat, llm_stub, db):
    client, _ = chat
    cid = new(client, name="Network design", model="m2", reasoning_level="medium", kb_summary_tool=False)
    send(client, cid, "How should I segment my network?")
    before = view(client, cid)
    ScriptedModel(llm_stub, summary="WE TALKED ABOUT SEGMENTATION")
    llm_stub.calls.clear()
    response = client.post(f"/api/conversations/{cid}/compact")
    assert response.status_code == 201
    started = response.json()
    (call,) = summary_calls(llm_stub)
    assert call["model"] == "m2" and call["reasoning_effort"] == "medium"
    assert "How should I segment my network?" in call["messages"][0]["content"]
    assert FILE_TEXT in call["messages"][0]["content"]  # the summariser is given the files the conversation used
    assert started["conversation_id"] != cid and started["source_conversation_id"] == cid
    assert started["name"] == "Network design (summary)"
    assert {k: started[k] for k in CONFIG_FIELDS[1:]} == {k: before[k] for k in CONFIG_FIELDS[1:]}
    (opening,) = started["messages"]
    assert opening["role"] == "assistant" and opening["message_type"] == "compacted_summary"
    assert opening["content"] == "WE TALKED ABOUT SEGMENTATION" and opening["model"] == "m2"
    assert view(client, cid) == before  # the earlier conversation is untouched
    assert client.get("/api/conversations/current").json()["conversation_id"] == started["conversation_id"]

    # the new conversation continues from the summary, not from the earlier turns
    llm_stub.calls.clear()
    ScriptedModel(llm_stub, choices={"category": None})
    assert send(client, started["conversation_id"], "What about logging?").status_code == 200
    sent = answer_calls(llm_stub)[0]["messages"]
    assert [m["role"] for m in sent] == ["user"]
    assert "WE TALKED ABOUT SEGMENTATION" in sent[0]["content"] and sent[0]["content"].endswith("What about logging?")
    assert "How should I segment my network?" not in sent[0]["content"]
    assert [m["message_type"] for m in view(client, started["conversation_id"])["messages"]] == [
        "compacted_summary",
        "chat",
        "chat",
    ]


def test_compacting_a_summary_first_conversation_includes_its_summary(chat, llm_stub):
    client, _ = chat
    cid = new(client)
    send(client, cid, "first")
    ScriptedModel(llm_stub, summary="SUMMARY ONE")
    second = client.post(f"/api/conversations/{cid}/compact").json()["conversation_id"]
    ScriptedModel(llm_stub, choices={"category": None})
    send(client, second, "continue please")
    ScriptedModel(llm_stub, summary="SUMMARY TWO")
    llm_stub.calls.clear()
    third = client.post(f"/api/conversations/{second}/compact").json()
    assert "SUMMARY ONE" in summary_calls(llm_stub)[0]["messages"][0]["content"]
    assert third["source_conversation_id"] == second and third["name"].endswith("(summary) (summary)")


def test_an_older_conversation_without_a_model_gets_one_when_opened(chat, db):
    client, _ = chat
    cid = new(client, model="m2")
    conn = sqlite3.connect(db)
    conn.execute(
        "UPDATE conversations SET model = '' WHERE conversation_id = ?", (cid,)
    )  # how migration 0006 leaves it
    conn.commit()
    conn.close()
    assert (
        view(client, cid)["model"] == "Default::m1"
    )  # the user's first model (as "<API label>::<model>"); from now on it is fixed like any other
    assert app_rows(db, "SELECT model FROM conversations WHERE conversation_id = ?", (cid,)) == [("Default::m1",)]


async def test_a_stopped_send_leaves_no_file_reference_behind(async_client, routing_on, llm_stub, db):
    import asyncio

    from tests.routing_helpers import build_kb_async, connect_async

    await connect_async(async_client)
    await build_kb_async(async_client)
    ScriptedModel(llm_stub)
    created = await async_client.post("/api/conversations", json={"name": "s", "agent_id": "assistant", "model": "m1"})
    cid = created.json()["conversation_id"]
    llm_stub.gate = asyncio.Event()
    task = asyncio.create_task(
        async_client.post(
            f"/api/conversations/{cid}/messages", json={"content": "slow", "request_id": "req-stop-00001"}
        )
    )
    for _ in range(300):
        if any(not c["system"].startswith("You are the retrieval step") for c in llm_stub.calls):
            break
        await asyncio.sleep(0.01)
    assert (
        await async_client.post(f"/api/conversations/{cid}/stop", json={"request_id": "req-stop-00001"})
    ).json() == {"stopped": True}
    llm_stub.gate.set()
    assert (await task).status_code == 409
    assert app_rows(
        db, "SELECT COUNT(*) FROM messages WHERE conversation_id = ? AND message_type = 'kb_reference'", (cid,)
    ) == [(0,)]
