import asyncio
import sqlite3

import pytest

from services.llm_service import LLMError


def current(client):
    response = client.get("/api/conversations/current")
    assert response.status_code == 200, response.text
    return response.json()


def new(
    client, name="Test chat", agent_id="assistant", model="model-a", reasoning_level="default", kb_summary_tool=False
):
    """Start a conversation from the New conversation popup's five settings. Returns its id."""
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


def send(client, conversation_id, content="hello"):
    """The agent, model and reasoning level come from the conversation, so a message carries only its text."""
    return client.post(f"/api/conversations/{conversation_id}/messages", json={"content": content})


def connect(client, models=("m1", "m2")):
    """Add (or, when it exists, change) the API labelled "Default"."""
    body = {"label": "Default", "url": "https://api.example.com/v1", "api_key": "sk-secret", "models": list(models)}
    response = client.post("/api/connections", json=body)
    if response.status_code == 422:  # already there: change its models
        existing = next(c for c in client.get("/api/connections").json() if c["label"] == "Default")
        response = client.put(f"/api/connections/{existing['connection_id']}", json={"models": body["models"]})
        assert response.status_code == 200
        return
    assert response.status_code == 201


# ---- current / new
def test_requires_login(client):
    assert client.get("/api/conversations/current").status_code == 401


def test_a_new_user_starts_with_an_empty_conversation(logged_in_client):
    conversation = current(logged_in_client)
    assert conversation["is_sample"] is False
    assert conversation["messages"] == []
    assert current(logged_in_client)["conversation_id"] == conversation["conversation_id"]


def test_new_conversation_becomes_the_current_one(logged_in_client):
    sample = current(logged_in_client)
    created = logged_in_client.post(
        "/api/conversations",
        json={
            "name": "Launch",
            "agent_id": "code",
            "model": "model-b",
            "reasoning_level": "high",
            "kb_summary_tool": True,
        },
    )
    assert created.status_code == 201
    assert created.json()["messages"] == [] and created.json()["is_sample"] is False
    assert {k: created.json()[k] for k in ("name", "agent_id", "model", "reasoning_level", "kb_summary_tool")} == {
        "name": "Launch",
        "agent_id": "code",
        "model": "model-b",
        "reasoning_level": "high",
        "kb_summary_tool": True,
    }
    assert (
        current(logged_in_client)["conversation_id"] == created.json()["conversation_id"] != sample["conversation_id"]
    )


# ---- sending
def test_send_in_demo_mode_stores_both_messages(logged_in_client):
    cid = new(logged_in_client, model="model-b")
    response = send(logged_in_client, cid, "Plan my launch")
    assert response.status_code == 200
    user, assistant = response.json()["messages"]
    assert user["role"] == "user" and user["content"] == "Plan my launch" and user["status"] == "complete"
    assert assistant["role"] == "assistant" and assistant["demo"] is True and assistant["status"] == "complete"
    assert assistant["content"].startswith("Demo · model-b")
    assert assistant["agent"] == "General assistant" and assistant["model"] == "model-b"
    after = current(logged_in_client)
    assert len(after["messages"]) == 2 and after["is_sample"] is False
    assert after["messages"][-1]["message_id"] == assistant["message_id"]


def test_send_with_a_provider_calls_the_model_with_history_system_prompt_and_key(logged_in_client, llm_stub):
    connect(logged_in_client)
    cid = new(logged_in_client, model="m2", agent_id="code")
    response = send(logged_in_client, cid, "What next?")
    assert response.status_code == 200
    assert response.json()["messages"][1]["content"] == "stub reply from m2"
    assert (
        response.json()["messages"][1]["demo"] is False and response.json()["messages"][1]["agent"] == "Code assistant"
    )
    call = llm_stub.calls[0]
    assert call["model"] == "m2" and call["api_key"] == "sk-secret" and call["base_url"] == "https://api.example.com/v1"
    assert "software engineering assistant" in call["system"]
    assert [m["role"] for m in call["messages"]] == ["user"]
    assert call["messages"][-1]["content"] == "What next?"
    assert "reasoning_effort" not in call or call["reasoning_effort"] is None  # "default" leaves it out


def test_model_failure_keeps_the_prompt_and_marks_it_failed(logged_in_client, llm_stub):
    connect(logged_in_client)
    conversation = current(logged_in_client)
    llm_stub.error = LLMError(
        502, "llm_http_error", "API returned HTTP 401. Check your key, model ID, and endpoint in Account."
    )
    response = send(logged_in_client, conversation["conversation_id"], "will fail")
    assert response.status_code == 502
    assert response.json()["error"]["code"] == "llm_http_error"
    last = current(logged_in_client)["messages"][-1]
    assert last["content"] == "will fail" and last["status"] == "failed"


def test_a_failed_prompt_is_still_part_of_the_next_requests_history(logged_in_client, llm_stub):
    connect(logged_in_client)
    conversation = current(logged_in_client)
    llm_stub.error = LLMError(502, "llm_unreachable", "Could not reach your API.")
    send(logged_in_client, conversation["conversation_id"], "first try")
    llm_stub.error = None
    assert send(logged_in_client, conversation["conversation_id"], "second try").status_code == 200
    assert [m["content"] for m in llm_stub.calls[-1]["messages"]][-2:] == ["first try", "second try"]


def test_send_validation(logged_in_client):
    cid = current(logged_in_client)["conversation_id"]
    assert send(logged_in_client, cid, "   ").status_code == 422
    assert send(logged_in_client, cid, "x" * 8001).status_code == 422
    assert send(logged_in_client, "missing").status_code == 404
    assert current(logged_in_client)["messages"] == []  # nothing was stored by the rejected requests
    body = {"name": "n", "agent_id": "assistant", "model": "model-a"}
    assert logged_in_client.post("/api/conversations", json={**body, "agent_id": "nope"}).status_code == 422
    assert logged_in_client.post("/api/conversations", json={**body, "model": "not-a-model"}).status_code == 422
    assert logged_in_client.post("/api/conversations", json={**body, "model": ""}).status_code == 422
    assert logged_in_client.post("/api/conversations", json={**body, "reasoning_level": "extreme"}).status_code == 422
    assert logged_in_client.post("/api/conversations").status_code == 422  # the settings are required


# ---- rewind
def test_rewind_removes_the_last_prompt_and_what_followed(logged_in_client):
    cid = current(logged_in_client)["conversation_id"]
    send(logged_in_client, cid, "second to last")
    send(logged_in_client, cid, "the last one")
    response = logged_in_client.post(f"/api/conversations/{cid}/rewind")
    assert response.status_code == 200
    assert response.json()["removed_prompt"] == "the last one"
    assert response.json()["messages"][-1]["content"].startswith("Demo ·")
    assert [m["content"] for m in response.json()["messages"]][-2] == "second to last"
    assert len(current(logged_in_client)["messages"]) == 2  # the first exchange is all that is left


def test_rewind_with_no_prompts_is_a_conflict(logged_in_client):
    cid = new(logged_in_client)
    response = logged_in_client.post(f"/api/conversations/{cid}/rewind")
    assert response.status_code == 409 and response.json()["error"]["code"] == "nothing_to_rewind"


# ---- ownership
def test_other_users_cannot_read_or_use_a_conversation(logged_in_client, other_client):
    cid = current(logged_in_client)["conversation_id"]
    assert send(other_client, cid).status_code == 404
    assert other_client.post(f"/api/conversations/{cid}/rewind").status_code == 404
    assert other_client.post(f"/api/conversations/{cid}/stop").status_code == 404
    assert current(other_client)["conversation_id"] != cid


# ---- stop command (a request is held in flight, so these run on the test's own event loop)
async def start_send(client, conversation_id, llm_stub, content="slow one"):
    llm_stub.gate = asyncio.Event()
    task = asyncio.create_task(
        client.post(
            f"/api/conversations/{conversation_id}/messages",
            json={"content": content, "model": "m1", "agent_id": "assistant"},
        )
    )
    for _ in range(300):
        if llm_stub.calls:
            return task
        await asyncio.sleep(0.01)
    raise AssertionError("the model call never started")


async def connect_async(client):
    response = await client.post(
        "/api/connections",
        json={"label": "Default", "url": "https://api.example.com/v1", "api_key": "sk-secret", "models": ["m1"]},
    )
    assert response.status_code == 201


async def test_stop_before_the_reply_marks_the_prompt_stopped_and_ignores_the_late_reply(async_client, llm_stub, db):
    await connect_async(async_client)
    cid = (await async_client.get("/api/conversations/current")).json()["conversation_id"]
    task = await start_send(async_client, cid, llm_stub)

    stop = await async_client.post(f"/api/conversations/{cid}/stop")
    assert stop.json() == {"stopped": True}

    llm_stub.gate.set()  # the provider answers after the stop
    response = await task
    assert response.status_code == 409 and response.json()["error"]["code"] == "stopped"

    messages = (await async_client.get("/api/conversations/current")).json()["messages"]
    assert messages[-1]["content"] == "slow one" and messages[-1]["status"] == "stopped"
    assert all(m["status"] != "ignored" for m in messages) and messages[-1]["role"] == "user"
    stored = (
        sqlite3.connect(db)
        .execute(
            "SELECT status, content FROM messages WHERE conversation_id = ? AND role = 'assistant' ORDER BY sequence_number DESC LIMIT 1",
            (cid,),
        )
        .fetchone()
    )
    assert stored == ("ignored", "stub reply from m1")

    # the ignored reply is never sent back to the model on the next turn
    llm_stub.gate = None
    llm_stub.calls.clear()
    assert (
        await async_client.post(
            f"/api/conversations/{cid}/messages", json={"content": "again", "model": "m1", "agent_id": "assistant"}
        )
    ).status_code == 200
    sent = [m["content"] for m in llm_stub.calls[0]["messages"]]
    assert "stub reply from m1" not in sent and sent[-2:] == ["slow one", "again"]


async def test_stop_then_a_provider_error_still_reports_stopped(async_client, llm_stub):
    await connect_async(async_client)
    cid = (await async_client.get("/api/conversations/current")).json()["conversation_id"]
    task = await start_send(async_client, cid, llm_stub)
    await async_client.post(f"/api/conversations/{cid}/stop")
    llm_stub.error = LLMError(502, "llm_unreachable", "Could not reach your API.")
    llm_stub.gate.set()
    response = await task
    assert response.status_code == 409 and response.json()["error"]["code"] == "stopped"
    assert (await async_client.get("/api/conversations/current")).json()["messages"][-1]["status"] == "stopped"


async def test_stop_is_idempotent_and_a_no_op_when_nothing_is_pending(async_client):
    cid = (await async_client.get("/api/conversations/current")).json()["conversation_id"]
    assert (await async_client.post(f"/api/conversations/{cid}/stop")).json() == {"stopped": False}
    assert (await async_client.post(f"/api/conversations/{cid}/stop")).json() == {"stopped": False}


async def test_a_reply_that_arrives_before_any_stop_is_stored_normally(async_client, llm_stub):
    await connect_async(async_client)
    cid = (await async_client.get("/api/conversations/current")).json()["conversation_id"]
    task = await start_send(async_client, cid, llm_stub)
    llm_stub.gate.set()
    assert (await task).status_code == 200
    assert (await async_client.post(f"/api/conversations/{cid}/stop")).json() == {"stopped": False}


async def test_rewinding_while_a_reply_is_in_flight_drops_the_late_reply(async_client, llm_stub):
    await connect_async(async_client)
    cid = (await async_client.get("/api/conversations/current")).json()["conversation_id"]
    task = await start_send(async_client, cid, llm_stub)
    rewound = await async_client.post(f"/api/conversations/{cid}/rewind")
    assert rewound.json()["removed_prompt"] == "slow one"
    llm_stub.gate.set()
    response = await task
    assert response.status_code == 409 and response.json()["error"]["code"] == "prompt_removed"
    assert (await async_client.get("/api/conversations/current")).json()["messages"] == []


# ---- chat records
def test_chat_records_save_the_prompts_and_number_themselves(logged_in_client):
    cid = current(logged_in_client)["conversation_id"]
    for prompt in ("one", "two", "three"):
        send(logged_in_client, cid, prompt)
    first = logged_in_client.post("/api/chat-records", json={"conversation_id": cid})
    assert first.status_code == 201
    body = first.json()
    assert body["name"] == "Chat record 1" and body["prompts"] == ["one", "two", "three"]
    second = logged_in_client.post("/api/chat-records", json={"conversation_id": cid}).json()
    assert second["name"] == "Chat record 2"
    listed = logged_in_client.get("/api/chat-records").json()
    assert [r["name"] for r in listed] == ["Chat record 1", "Chat record 2"]


def test_chat_record_needs_prompts_and_an_owned_conversation(logged_in_client, other_client):
    empty = new(logged_in_client)
    response = logged_in_client.post("/api/chat-records", json={"conversation_id": empty})
    assert response.status_code == 422 and "Send a chat message" in response.json()["error"]["message"]
    cid = current(logged_in_client)["conversation_id"]
    assert other_client.post("/api/chat-records", json={"conversation_id": cid}).status_code == 404
    assert logged_in_client.post("/api/chat-records", json={"conversation_id": "missing"}).status_code == 404


def test_chat_records_are_per_user(logged_in_client, other_client):
    logged_in_client.post("/api/chat-records", json={"conversation_id": current(logged_in_client)["conversation_id"]})
    assert other_client.get("/api/chat-records").json() == []


# ---- a stop command can reach the server before the prompt it cancels (found by the live frontend test)
def send_with_id(client, conversation_id, request_id, content="early stop"):
    return client.post(
        f"/api/conversations/{conversation_id}/messages",
        json={"content": content, "model": "m1", "agent_id": "assistant", "request_id": request_id},
    )


def test_a_stop_that_arrives_before_its_prompt_is_honored_when_the_prompt_arrives(logged_in_client, llm_stub):
    connect(logged_in_client)
    cid = current(logged_in_client)["conversation_id"]
    stop = logged_in_client.post(f"/api/conversations/{cid}/stop", json={"request_id": "req-early-0001"})
    assert stop.json() == {"stopped": True}

    response = send_with_id(logged_in_client, cid, "req-early-0001")
    assert response.status_code == 409 and response.json()["error"]["code"] == "stopped"
    assert llm_stub.calls == []  # the model was never called
    last = current(logged_in_client)["messages"][-1]
    assert last["content"] == "early stop" and last["status"] == "stopped"  # the prompt is saved, unanswered


def test_a_stop_marker_is_used_once_and_only_by_its_own_request(logged_in_client, llm_stub):
    connect(logged_in_client)
    cid = current(logged_in_client)["conversation_id"]
    logged_in_client.post(f"/api/conversations/{cid}/stop", json={"request_id": "req-early-0002"})
    assert send_with_id(logged_in_client, cid, "req-different-9999", "other prompt").status_code == 200
    assert send_with_id(logged_in_client, cid, "req-early-0002").status_code == 409
    assert send_with_id(logged_in_client, cid, "req-later-0003", "later prompt").status_code == 200


def test_stopping_a_send_that_already_finished_does_nothing(logged_in_client, llm_stub):
    connect(logged_in_client)
    cid = current(logged_in_client)["conversation_id"]
    assert send_with_id(logged_in_client, cid, "req-done-0004", "answered").status_code == 200
    assert logged_in_client.post(f"/api/conversations/{cid}/stop", json={"request_id": "req-done-0004"}).json() == {
        "stopped": False
    }
    assert current(logged_in_client)["messages"][-2]["status"] == "complete"


def test_messages_carry_the_request_id_so_the_page_can_recognize_its_own_prompt(logged_in_client):
    connect(logged_in_client)
    cid = current(logged_in_client)["conversation_id"]
    user, assistant = send_with_id(logged_in_client, cid, "req-mine-00006", "hello").json()["messages"]
    assert user["request_id"] == "req-mine-00006" and assistant["request_id"] is None
    assert current(logged_in_client)["messages"][-2]["request_id"] == "req-mine-00006"


def test_stop_request_ids_are_validated(logged_in_client):
    cid = current(logged_in_client)["conversation_id"]
    assert logged_in_client.post(f"/api/conversations/{cid}/stop", json={"request_id": "x"}).status_code == 422
    assert (
        logged_in_client.post(f"/api/conversations/{cid}/stop", json={"request_id": "bad id with spaces!"}).status_code
        == 422
    )
    assert logged_in_client.post(f"/api/conversations/{cid}/stop", json={}).json() == {"stopped": False}
    assert logged_in_client.post(f"/api/conversations/{cid}/stop").json() == {"stopped": False}  # no body at all


async def test_a_stop_by_request_id_marks_that_pending_prompt(async_client, llm_stub):
    await connect_async(async_client)
    cid = (await async_client.get("/api/conversations/current")).json()["conversation_id"]
    llm_stub.gate = asyncio.Event()
    task = asyncio.create_task(
        async_client.post(
            f"/api/conversations/{cid}/messages",
            json={"content": "slow", "model": "m1", "agent_id": "assistant", "request_id": "req-slow-0005"},
        )
    )
    for _ in range(300):
        if llm_stub.calls:
            break
        await asyncio.sleep(0.01)
    assert (await async_client.post(f"/api/conversations/{cid}/stop", json={"request_id": "req-slow-0005"})).json() == {
        "stopped": True
    }
    llm_stub.gate.set()
    assert (await task).json()["error"]["code"] == "stopped"
    assert (await async_client.get("/api/conversations/current")).json()["messages"][-1]["status"] == "stopped"


# ---- File > Open: the list of chats, and making one current
def test_listing_requires_login(client):
    assert client.get("/api/conversations").status_code == 401
    assert client.post("/api/conversations/x/open").status_code == 401


def test_the_list_holds_the_chats_with_their_prompt_counts_most_recent_first(logged_in_client):
    first = new(logged_in_client, name="First")
    second = new(logged_in_client, name="Second", agent_id="code", model="model-b", reasoning_level="high")
    send(logged_in_client, first, "one")
    send(logged_in_client, first, "two")
    listed = logged_in_client.get("/api/conversations").json()
    assert [c["conversation_id"] for c in listed] == [first, second]  # sending touched the first
    assert [(c["name"], c["prompt_count"]) for c in listed] == [("First", 2), ("Second", 0)]
    assert (
        listed[1]["agent_id"] == "code" and listed[1]["model"] == "model-b" and listed[1]["reasoning_level"] == "high"
    )
    assert all("messages" not in c for c in listed)


def test_replays_never_appear_in_the_chat_list(logged_in_client):
    cid = new(logged_in_client, name="Source")
    send(logged_in_client, cid, "a prompt")
    run = logged_in_client.post("/api/replay-runs", json={"conversation_id": cid})
    assert run.status_code == 201
    assert [c["conversation_id"] for c in logged_in_client.get("/api/conversations").json()] == [cid]


def test_the_list_is_per_user(logged_in_client, other_client):
    new(logged_in_client, name="Mine")
    assert other_client.get("/api/conversations").json() == []


def test_opening_a_chat_makes_it_the_current_one(logged_in_client):
    older = new(logged_in_client, name="Older")
    newer = new(logged_in_client, name="Newer")
    assert current(logged_in_client)["conversation_id"] == newer
    response = logged_in_client.post(f"/api/conversations/{older}/open")
    assert response.status_code == 200
    assert response.json()["conversation_id"] == older and response.json()["name"] == "Older"
    assert current(logged_in_client)["conversation_id"] == older


def test_opening_needs_an_owned_chat(logged_in_client, other_client):
    cid = new(logged_in_client)
    assert other_client.post(f"/api/conversations/{cid}/open").status_code == 404
    assert logged_in_client.post("/api/conversations/missing/open").status_code == 404


# ---- temperature (0 to 2, default 0, fixed with the conversation)
def test_temperature_defaults_to_zero_and_is_fixed_with_the_conversation(logged_in_client):
    assert current(logged_in_client)["temperature"] == 0
    cid = new(logged_in_client)
    assert logged_in_client.get(f"/api/conversations/{cid}").json()["temperature"] == 0
    created = logged_in_client.post(
        "/api/conversations",
        json={"name": "Warm", "agent_id": "assistant", "model": "model-a", "temperature": 0.7},
    )
    assert created.status_code == 201 and created.json()["temperature"] == 0.7
    warm = created.json()["conversation_id"]
    assert logged_in_client.get(f"/api/conversations/{warm}").json()["temperature"] == 0.7
    fixed = logged_in_client.patch(f"/api/conversations/{warm}", json={"temperature": 1})
    assert fixed.status_code == 409 and fixed.json()["error"]["code"] == "configuration_fixed"
    listed = {c["conversation_id"]: c for c in logged_in_client.get("/api/conversations").json()}
    assert listed[warm]["temperature"] == 0.7 and listed[cid]["temperature"] == 0


@pytest.mark.parametrize("value", [-0.1, 2.1, "hot"])
def test_temperature_outside_zero_to_two_is_refused(logged_in_client, value):
    body = {"name": "n", "agent_id": "assistant", "model": "model-a", "temperature": value}
    assert logged_in_client.post("/api/conversations", json=body).status_code == 422


def test_the_temperature_goes_to_the_model_with_every_answer(logged_in_client, llm_stub):
    connect(logged_in_client)
    cid = logged_in_client.post(
        "/api/conversations", json={"name": "T", "agent_id": "assistant", "model": "m1", "temperature": 0.4}
    ).json()["conversation_id"]
    assert send(logged_in_client, cid, "hello").status_code == 200
    assert llm_stub.calls[-1]["temperature"] == 0.4
    default = new(logged_in_client, model="m1")
    send(logged_in_client, default, "hello")
    assert llm_stub.calls[-1]["temperature"] == 0


def test_a_compacted_conversation_keeps_the_temperature(logged_in_client):
    connect(logged_in_client)
    cid = logged_in_client.post(
        "/api/conversations", json={"name": "T", "agent_id": "assistant", "model": "m1", "temperature": 1.2}
    ).json()["conversation_id"]
    send(logged_in_client, cid, "hello")
    compacted = logged_in_client.post(f"/api/conversations/{cid}/compact")
    assert compacted.status_code == 201 and compacted.json()["temperature"] == 1.2


# ---- brief replies (append "Respond in 100 words or less." to each request; fixed with the conversation)
BRIEF = "Respond in 100 words or less."


def brief_chat(client, brief=True):
    return client.post(
        "/api/conversations",
        json={"name": "B", "agent_id": "assistant", "model": "m1", "brief_replies": brief},
    ).json()["conversation_id"]


def test_brief_replies_default_to_off_and_are_fixed_with_the_conversation(logged_in_client):
    connect(logged_in_client)
    cid = new(logged_in_client, model="m1")
    assert logged_in_client.get(f"/api/conversations/{cid}").json()["brief_replies"] is False
    briefly = brief_chat(logged_in_client)
    assert logged_in_client.get(f"/api/conversations/{briefly}").json()["brief_replies"] is True
    fixed = logged_in_client.patch(f"/api/conversations/{briefly}", json={"brief_replies": False})
    assert fixed.status_code == 409 and fixed.json()["error"]["code"] == "configuration_fixed"
    listed = {c["conversation_id"]: c for c in logged_in_client.get("/api/conversations").json()}
    assert listed[briefly]["brief_replies"] is True and listed[cid]["brief_replies"] is False


def test_the_instruction_ends_every_user_message_sent_to_the_model_but_is_not_stored(logged_in_client, llm_stub):
    connect(logged_in_client)
    cid = brief_chat(logged_in_client)
    send(logged_in_client, cid, "first")
    send(logged_in_client, cid, "second")
    users = [m["content"] for m in llm_stub.calls[-1]["messages"] if m["role"] == "user"]
    assert users == [f"first\n\n{BRIEF}", f"second\n\n{BRIEF}"]  # every request carries it, history included
    stored = [m["content"] for m in logged_in_client.get(f"/api/conversations/{cid}").json()["messages"]]
    assert not any(BRIEF in text for text in stored)  # the transcript shows only what the user wrote


def test_the_view_carries_the_exact_instruction_so_the_page_can_show_what_is_sent(logged_in_client):
    connect(logged_in_client)
    cid = brief_chat(logged_in_client)
    assert logged_in_client.get(f"/api/conversations/{cid}").json()["brief_instruction"] == BRIEF


def test_nothing_is_appended_when_the_switch_is_off(logged_in_client, llm_stub):
    connect(logged_in_client)
    cid = brief_chat(logged_in_client, brief=False)
    send(logged_in_client, cid, "plain")
    assert all(BRIEF not in m["content"] for m in llm_stub.calls[-1]["messages"])


def test_a_compacted_conversation_keeps_brief_replies(logged_in_client):
    connect(logged_in_client)
    cid = brief_chat(logged_in_client)
    send(logged_in_client, cid, "hello")
    compacted = logged_in_client.post(f"/api/conversations/{cid}/compact")
    assert compacted.status_code == 201 and compacted.json()["brief_replies"] is True


# ---- the chat's API log (Log.db): exactly what was sent to the provider for each prompt
def api_log(client, cid):
    return client.get(f"/api/conversations/{cid}/api-log")


def test_the_chat_api_log_needs_login(client):
    assert client.get("/api/conversations/anything/api-log").status_code == 401


def test_the_chat_api_log_belongs_to_the_owner(logged_in_client, other_client):
    cid = new(logged_in_client)
    assert api_log(logged_in_client, "missing").status_code == 404
    assert api_log(other_client, cid).status_code == 404


def test_the_chat_api_log_keeps_the_exact_request_for_each_prompt(logged_in_client, llm_stub):
    connect(logged_in_client)
    cid = brief_chat(logged_in_client)
    send(logged_in_client, cid, "first")
    send(logged_in_client, cid, "second")
    log = api_log(logged_in_client, cid).json()
    assert log["recorded"] is True and log["model"] == "m1"
    assert [t["prompt"] for t in log["turns"]] == ["first", "second"]
    answers = [c for t in log["turns"] for c in t["calls"] if c["purpose"] == "answer"]
    assert len(answers) == 2
    sent = [m["content"] for m in answers[-1]["request"]["body"]["messages"] if m["role"] == "user"]
    assert sent == [f"first\n\n{BRIEF}", f"second\n\n{BRIEF}"]  # what went over the wire, appended text included
    assert "sk-secret" not in str(log)  # the key is never kept


def test_the_chat_api_log_is_not_kept_in_app_db(logged_in_client, llm_stub, test_settings):
    import sqlite3

    connect(logged_in_client)
    cid = new(logged_in_client, model="m1")
    send(logged_in_client, cid, "hello")
    with sqlite3.connect(test_settings.DATABASE_PATH) as conn:
        names = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
    assert "chat_api_calls" not in names
    with sqlite3.connect(test_settings.LOG_DB_PATH) as conn:
        assert conn.execute("SELECT COUNT(*) FROM chat_api_calls").fetchone()[0] >= 1


def test_a_failed_prompt_still_has_its_call_in_the_log(logged_in_client, llm_stub):
    connect(logged_in_client)
    cid = new(logged_in_client, model="m1")
    llm_stub.error = RuntimeError("provider down")
    try:
        send(logged_in_client, cid, "boom")
    except RuntimeError:
        pass
    log = api_log(logged_in_client, cid).json()
    assert log["turns"] and log["turns"][0]["calls"]  # the request that failed is the one worth reading


def test_demo_mode_is_recorded_with_no_calls_and_an_older_chat_is_not(logged_in_client):
    cid = new(logged_in_client)  # no API connected: a demo reply, no REST call
    send(logged_in_client, cid, "hello")
    log = api_log(logged_in_client, cid).json()
    assert log["recorded"] is True and log["turns"][0]["calls"] == []
    older = new(logged_in_client)
    assert api_log(logged_in_client, older).json()["recorded"] is False


def test_rewinding_a_prompt_removes_its_calls_from_the_log(logged_in_client, llm_stub, test_settings):
    connect(logged_in_client)
    cid = new(logged_in_client, model="m1")
    send(logged_in_client, cid, "keep")
    send(logged_in_client, cid, "drop")
    assert logged_in_client.post(f"/api/conversations/{cid}/rewind").status_code == 200
    log = api_log(logged_in_client, cid).json()
    assert [t["prompt"] for t in log["turns"]] == ["keep"]
    import sqlite3

    with sqlite3.connect(test_settings.LOG_DB_PATH) as conn:
        left = conn.execute("SELECT COUNT(*) FROM chat_api_requests WHERE conversation_id = ?", (cid,)).fetchone()[0]
    assert left == 1


# ---- the most prompts a conversation may hold (MAX_USER_PROMPTS)
def test_the_default_limit_is_ten_and_the_view_says_so(logged_in_client, test_settings):
    from config import Settings

    assert Settings(_env_file=None).MAX_USER_PROMPTS == 10
    assert current(logged_in_client)["max_user_prompts"] == test_settings.MAX_USER_PROMPTS
    cid = new(logged_in_client)
    assert (
        logged_in_client.get(f"/api/conversations/{cid}").json()["max_user_prompts"] == test_settings.MAX_USER_PROMPTS
    )


def test_a_conversation_takes_prompts_up_to_the_limit_and_then_says_to_start_a_new_one(
    logged_in_client, monkeypatch, test_settings
):
    monkeypatch.setattr(test_settings, "MAX_USER_PROMPTS", 3)
    cid = new(logged_in_client)
    for i in range(3):
        assert send(logged_in_client, cid, f"prompt {i}").status_code == 200
    blocked = send(logged_in_client, cid, "one too many")
    assert blocked.status_code == 409
    assert blocked.json()["error"]["code"] == "prompt_limit_reached"
    assert (
        "limit of 3 prompts" in blocked.json()["error"]["message"]
        and "File > New" in blocked.json()["error"]["message"]
    )
    messages = logged_in_client.get(f"/api/conversations/{cid}").json()["messages"]
    assert [m["content"] for m in messages if m["role"] == "user"] == [
        "prompt 0",
        "prompt 1",
        "prompt 2",
    ]  # nothing was stored


def test_the_limit_is_per_conversation_and_a_new_one_starts_empty(logged_in_client, monkeypatch, test_settings):
    monkeypatch.setattr(test_settings, "MAX_USER_PROMPTS", 1)
    first = new(logged_in_client, name="First")
    assert send(logged_in_client, first, "only one").status_code == 200
    assert send(logged_in_client, first, "second").status_code == 409
    second = new(logged_in_client, name="Second")
    assert send(logged_in_client, second, "fresh start").status_code == 200


def test_rewinding_frees_a_slot(logged_in_client, monkeypatch, test_settings):
    monkeypatch.setattr(test_settings, "MAX_USER_PROMPTS", 2)
    cid = new(logged_in_client)
    send(logged_in_client, cid, "one")
    send(logged_in_client, cid, "two")
    assert send(logged_in_client, cid, "three").status_code == 409
    assert logged_in_client.post(f"/api/conversations/{cid}/rewind").status_code == 200
    assert send(logged_in_client, cid, "three").status_code == 200


def test_a_compacted_conversation_starts_with_no_prompts_used(logged_in_client, monkeypatch, test_settings):
    monkeypatch.setattr(test_settings, "MAX_USER_PROMPTS", 1)
    cid = new(logged_in_client)
    send(logged_in_client, cid, "the only prompt")
    assert send(logged_in_client, cid, "more").status_code == 409
    compacted = logged_in_client.post(f"/api/conversations/{cid}/compact")
    assert compacted.status_code == 201
    assert send(logged_in_client, compacted.json()["conversation_id"], "a prompt in the new one").status_code == 200


def test_a_stopped_or_failed_prompt_still_counts(logged_in_client, monkeypatch, test_settings, llm_stub):
    monkeypatch.setattr(test_settings, "MAX_USER_PROMPTS", 1)
    connect(logged_in_client)
    cid = new(logged_in_client, model="m1")
    llm_stub.error = LLMError(502, "llm_http_error", "API returned HTTP 500.")
    assert send(logged_in_client, cid, "this one fails").status_code == 502
    llm_stub.error = None
    assert send(logged_in_client, cid, "retry").status_code == 409  # the failed prompt is still in the conversation


def test_the_limit_comes_from_the_setting_not_a_fixed_number(logged_in_client, monkeypatch, test_settings):
    monkeypatch.setattr(test_settings, "MAX_USER_PROMPTS", 12)
    cid = new(logged_in_client)
    for i in range(12):
        assert send(logged_in_client, cid, f"p{i}").status_code == 200
    assert send(logged_in_client, cid, "p12").status_code == 409
    assert logged_in_client.get(f"/api/conversations/{cid}").json()["max_user_prompts"] == 12
