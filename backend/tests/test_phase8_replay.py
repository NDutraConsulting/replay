"""Phase 8 in replay: the run's KB-summary-tool switch, reasoning level, files carried by reference, summary-first
conversations, and deleted file versions."""

import pytest

from tests.routing_helpers import (
    ScriptedModel,
    answer_calls,
    build_kb,
    connect,
    router_calls,
    summary_calls,
)

FILE_TEXT = "Segment the network by trust level."


def new_chat(client, **config):
    body = {
        "name": "Source",
        "agent_id": "assistant",
        "model": "m2",
        "reasoning_level": "default",
        "kb_summary_tool": False,
    }
    response = client.post("/api/conversations", json={**body, **config})
    assert response.status_code == 201, response.text
    return response.json()["conversation_id"]


def make_run(client, prompts=("How do I segment my network?", "And what about logging?"), **extra):
    response = client.post("/api/replay-runs", json={"prompts": list(prompts), **extra})
    assert response.status_code == 201, response.text
    return response.json()


def step(client, run):
    response = client.post(f"/api/replay-runs/{run['replay_run_id']}/steps", json={"expected_cursor": run["cursor"]})
    assert response.status_code == 200, response.text
    return response.json()


@pytest.fixture
def replay(logged_in_client, routing_on, llm_stub):
    connect(logged_in_client)
    build_kb(logged_in_client)
    ScriptedModel(llm_stub)
    return logged_in_client, llm_stub


def answers_for(stub, model):
    return [c for c in answer_calls(stub) if c["model"] == model]


# ---- where a run's settings come from
def test_a_run_started_from_a_conversation_begins_from_its_settings(replay):
    client, _ = replay
    cid = new_chat(client, agent_id="research", model="m2", reasoning_level="high", kb_summary_tool=True)
    client.post(f"/api/conversations/{cid}/messages", json={"content": "first prompt"})
    run = client.post("/api/replay-runs", json={"conversation_id": cid}).json()
    assert run["agent_id"] == "research" and run["model_a"] == "m2" and run["model_b"] == "Default::m1"
    assert (
        run["reasoning_level"] == "none" and run["kb_summary_tool"] is True
    )  # reasoning always starts off on a replay
    assert run["prompts"] == ["first prompt"] and run["context_summary"] is None


def test_a_replay_starts_with_reasoning_none_even_when_its_chat_used_another_level(replay):
    client, _ = replay
    for level in ("default", "low", "xhigh"):
        cid = new_chat(client, reasoning_level=level)
        client.post(f"/api/conversations/{cid}/messages", json={"content": "p"})
        assert client.post("/api/replay-runs", json={"conversation_id": cid}).json()["reasoning_level"] == "none"


def test_the_request_can_override_the_conversations_settings(replay):
    client, _ = replay
    cid = new_chat(client, kb_summary_tool=True, reasoning_level="high")
    client.post(f"/api/conversations/{cid}/messages", json={"content": "p"})
    run = client.post(
        "/api/replay-runs",
        json={"conversation_id": cid, "kb_summary_tool": False, "reasoning_level": "low", "model_a": "m1"},
    ).json()
    assert run["kb_summary_tool"] is False and run["reasoning_level"] == "low" and run["model_a"] == "m1"


def test_a_run_from_plain_prompts_defaults_to_off_and_no_reasoning(replay):
    client, _ = replay
    run = make_run(client)
    assert run["kb_summary_tool"] is False and run["reasoning_level"] == "none"


def test_the_switch_can_change_until_the_run_starts_and_is_locked_after(replay):
    client, _ = replay
    run = make_run(client, model_a="m1", model_b="m2")
    url = f"/api/replay-runs/{run['replay_run_id']}"
    changed = client.patch(url, json={"kb_summary_tool": True, "reasoning_level": "medium"})
    assert changed.status_code == 200
    assert changed.json()["kb_summary_tool"] is True and changed.json()["reasoning_level"] == "medium"
    assert client.patch(url, json={"kb_summary_tool": False}).json()["kb_summary_tool"] is False
    started = step(client, run)
    locked = client.patch(url, json={"kb_summary_tool": True})
    assert locked.status_code == 409 and locked.json()["error"]["code"] == "replay_locked"
    assert started["kb_summary_tool"] is False


# ---- switch off: the whole file
def test_with_the_switch_off_both_slots_are_sent_the_whole_file_and_earlier_files_again(replay, llm_stub):
    client, _ = replay
    run = make_run(client, model_a="m1", model_b="m2")
    run = step(client, run)
    assert summary_calls(llm_stub) == [] and all(r["kb_summary"] is None for s in "ab" for r in run["results"][s])
    llm_stub.calls.clear()
    step(client, run)
    for model in ("m1", "m2"):
        (call,) = answers_for(llm_stub, model)
        sent = call["messages"]
        assert [m["role"] for m in sent] == ["user", "assistant", "user"]
        assert FILE_TEXT in sent[0]["content"] and FILE_TEXT in sent[2]["content"]  # earlier turn's file is re-sent
        assert sent[0]["content"].endswith("How do I segment my network?")


# ---- switch on: a summary written by each slot's own model
def test_with_the_switch_on_each_slot_sends_the_summary_its_own_model_wrote(replay, llm_stub):
    client, _ = replay
    run = make_run(client, model_a="m1", model_b="m2", kb_summary_tool=True)
    run = step(client, run)
    assert sorted(c["model"] for c in summary_calls(llm_stub)) == ["m1", "m2"]
    by_slot = {s: run["results"][s][0] for s in "ab"}
    assert by_slot["a"]["kb_summary"] == "summary by m1" and by_slot["b"]["kb_summary"] == "summary by m2"
    for model in ("m1", "m2"):
        (call,) = answers_for(llm_stub, model)
        text = call["messages"][-1]["content"]
        assert f"summary by {model}" in text and FILE_TEXT not in text
        other = "m2" if model == "m1" else "m1"
        assert f"summary by {other}" not in text  # a slot never sees the other slot's summary
    prompt = summary_calls(llm_stub)[0]["messages"][0]["content"]
    assert "How do I segment my network?" in prompt and FILE_TEXT in prompt


def test_with_the_switch_on_a_later_step_resends_the_earlier_summary_and_writes_a_new_one(replay, llm_stub):
    client, _ = replay
    run = step(client, make_run(client, model_a="m1", model_b="m2", kb_summary_tool=True))
    llm_stub.calls.clear()
    ScriptedModel(llm_stub, summary=lambda call: f"second summary by {call['model']}")
    step(client, run)
    assert len(summary_calls(llm_stub)) == 2  # one per slot, for the new turn only
    (call,) = answers_for(llm_stub, "m1")
    sent = call["messages"]
    assert "summary by m1" in sent[0]["content"] and "second summary by m1" in sent[2]["content"]
    assert FILE_TEXT not in " ".join(m["content"] for m in sent)


def test_reasoning_level_reaches_the_answer_and_the_retrieval_steps_of_both_slots(replay, llm_stub):
    client, _ = replay
    step(client, make_run(client, model_a="m1", model_b="m2", reasoning_level="xhigh"))
    assert [c["reasoning_effort"] for c in answer_calls(llm_stub)] == ["xhigh", "xhigh"]
    routing = router_calls(llm_stub)
    assert routing and all(c["reasoning_effort"] == "xhigh" for c in routing)


def test_temperature_reaches_the_answer_and_the_retrieval_steps_of_both_slots(replay, llm_stub):
    client, _ = replay
    step(client, make_run(client, model_a="m1", model_b="m2", temperature=0.4))
    routing = router_calls(llm_stub)
    assert {c["model"] for c in routing} == {"m1", "m2"}
    assert all(c["temperature"] == 0.4 for c in [*routing, *answer_calls(llm_stub)])


def test_a_saved_replay_says_which_setting_it_used(replay):
    client, _ = replay
    run = make_run(client, prompts=("one",), model_a="m1", model_b="m2", kb_summary_tool=True, reasoning_level="low")
    step(client, run)  # the last prompt: the run completes and saves itself
    saved = client.get("/api/saved-replays").json()
    assert {s["slot"] for s in saved} == {"a", "b"}
    assert all(s["kb_summary_tool"] is True and s["reasoning_level"] == "low" for s in saved)
    detail = client.get(f"/api/saved-replays/{saved[0]['id']}").json()
    assert detail["responses"][0]["kb_summary"].startswith("summary by m")


def test_a_failing_summary_call_discards_the_whole_step(replay, llm_stub):
    client, _ = replay
    from tests.routing_helpers import provider_error

    def failing(call):
        if call["model"] == "m2":
            raise provider_error()
        return "fine"

    ScriptedModel(llm_stub, summary=failing)
    run = make_run(client, model_a="m1", model_b="m2", kb_summary_tool=True)
    response = client.post(f"/api/replay-runs/{run['replay_run_id']}/steps", json={"expected_cursor": 0})
    assert response.status_code == 502
    current = client.get("/api/replay-runs/current").json()
    assert current["cursor"] == 0 and current["results"] == {"a": [], "b": []}


# ---- a conversation that started from a summary
def test_a_run_from_a_summary_first_conversation_starts_from_its_summary(replay, llm_stub):
    client, _ = replay
    cid = new_chat(client, model="m1")
    client.post(f"/api/conversations/{cid}/messages", json={"content": "first"})
    ScriptedModel(llm_stub, summary="EARLIER SUMMARY")
    second = client.post(f"/api/conversations/{cid}/compact").json()["conversation_id"]
    ScriptedModel(llm_stub, choices={"category": None})
    client.post(f"/api/conversations/{second}/messages", json={"content": "after the summary"})
    run = client.post("/api/replay-runs", json={"conversation_id": second, "model_a": "m1", "model_b": "m2"}).json()
    assert run["prompts"] == ["after the summary"] and run["context_summary"] == "EARLIER SUMMARY"
    llm_stub.calls.clear()
    step(client, run)
    for call in answer_calls(llm_stub):
        assert [m["role"] for m in call["messages"]] == ["user"]
        assert "EARLIER SUMMARY" in call["messages"][0]["content"]
        assert "first" not in call["messages"][0]["content"]
    # the earlier conversation replays by itself, without a summary
    older = client.post("/api/replay-runs", json={"conversation_id": cid}).json()
    assert older["prompts"] == ["first"] and older["context_summary"] is None


# ---- deleted file versions
def _net(client):
    tree = client.get("/api/agents/assistant/knowledge-base").json()
    return next(
        d for c in tree["categories"] for s in c["subcategories"] for d in s["documents"] if d["title"] == "net.txt"
    )


def test_deleting_a_file_a_replay_used_flags_the_replay_or_removes_it(replay):
    client, _ = replay
    run = step(client, make_run(client, model_a="m1", model_b="m2"))
    url = f"/api/documents/{_net(client)['document_id']}"
    asked = client.delete(url)
    assert asked.status_code == 409 and asked.json()["error"]["details"] == {"conversations": 0, "replays": 1}
    assert client.delete(url + "?delete_conversations=false").status_code == 204
    current = client.get("/api/replay-runs/current").json()
    for slot in "ab":
        result = current["results"][slot][0]
        assert result["kb_version_deleted"] is True and result["decision_trace"][2]["kb_version_deleted"] is True
        assert result["decision_trace"][2]["chosen"]["name"] == "net.txt"
    assert run["replay_run_id"] == current["replay_run_id"]


def test_a_later_replay_step_names_a_deleted_file_instead_of_sending_text(replay, llm_stub):
    client, _ = replay
    run = step(client, make_run(client, model_a="m1", model_b="m2"))
    client.delete(f"/api/documents/{_net(client)['document_id']}?delete_conversations=false")
    ScriptedModel(llm_stub, choices={"category": None})
    llm_stub.calls.clear()
    step(client, run)
    sent = answers_for(llm_stub, "m1")[0]["messages"]
    assert "has since been deleted" in sent[0]["content"] and FILE_TEXT not in " ".join(m["content"] for m in sent)


def test_deleting_the_records_removes_the_replay_run(replay):
    client, _ = replay
    run = step(client, make_run(client, model_a="m1", model_b="m2"))
    url = f"/api/documents/{_net(client)['document_id']}?delete_conversations=true"
    assert client.delete(url).status_code == 204
    assert client.get("/api/replay-runs/current").status_code == 404
    assert run["replay_run_id"]
