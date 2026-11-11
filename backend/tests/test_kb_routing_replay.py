"""Knowledge-base routing in replay: each slot walks the knowledge base with its own model."""

import asyncio
import sqlite3

import pytest

from tests.routing_helpers import (
    ScriptedModel,
    answer_calls,
    build_kb,
    build_kb_async,
    connect,
    connect_async,
    level_of,
    options_of,
    provider_error,
    router_calls,
)


def make_run(client, prompts=("How do I segment my network?", "And what about logging?"), **extra):
    response = client.post(
        "/api/replay-runs", json={"prompts": list(prompts), "model_a": "m1", "model_b": "m2", **extra}
    )
    assert response.status_code == 201, response.text
    return response.json()


def step(client, run, request_id=None):
    body = {"expected_cursor": run["cursor"]}
    if request_id:
        body["request_id"] = request_id
    return client.post(f"/api/replay-runs/{run['replay_run_id']}/steps", json=body)


def rows(
    kb_db,
    sql="SELECT scope_id, ref, level, outcome, chosen_name, model FROM knowledge_base_choice ORDER BY ref, step_number",
):
    conn = sqlite3.connect(kb_db)
    try:
        return conn.execute(sql).fetchall()
    finally:
        conn.close()


@pytest.fixture
def replay(logged_in_client, routing_on, llm_stub):
    connect(logged_in_client)
    build_kb(logged_in_client)
    return logged_in_client, llm_stub


def names(trace):
    return [s["chosen"]["name"] if s["chosen"] else None for s in trace]


def test_each_slot_walks_the_knowledge_base_with_its_own_model(replay, kb_db):
    client, stub = replay
    ScriptedModel(stub, by_model={"m1": {"category": 1}, "m2": {"category": 2}})  # m1 picks Networks, m2 picks Cloud
    run = step(client, make_run(client)).json()
    a, b = run["results"]["a"][0], run["results"]["b"][0]
    assert names(a["decision_trace"]) == ["Networks", "Segmentation", "net.txt"]
    assert names(b["decision_trace"]) == ["Cloud", "IAM", "iam.txt"]
    assert {s["model"] for s in a["decision_trace"]} == {"m1"} and {s["model"] for s in b["decision_trace"]} == {"m2"}
    by_model = {c["model"]: c for c in answer_calls(stub)}
    assert "Segment the network by trust level." in by_model["m1"]["messages"][-1]["content"]
    assert "Use least privilege." in by_model["m2"]["messages"][-1]["content"]  # each answer got its own slot's file
    assert (
        by_model["m1"]["system"] == by_model["m2"]["system"]
    )  # the system prompt is the agent's own, with no file in it
    assert [(r[1], r[2], r[4]) for r in rows(kb_db)] == [
        ("a:0", "category", "Networks"), ("a:0", "subcategory", "Segmentation"), ("a:0", "file", "net.txt"),
        ("b:0", "category", "Cloud"), ("b:0", "subcategory", "IAM"), ("b:0", "file", "iam.txt"),
    ]  # fmt: skip


def test_the_recorded_choices_come_back_on_the_run_and_on_the_saved_replay(replay):
    client, stub = replay
    ScriptedModel(stub, by_model={"m1": {"category": 1}, "m2": {"category": 2}})
    run = make_run(client, prompts=["How do I segment my network?"])
    done = step(client, run).json()
    assert done["saved_at"] is not None  # a finished run is saved
    current = client.get("/api/replay-runs/current").json()
    assert names(current["results"]["b"][0]["decision_trace"]) == ["Cloud", "IAM", "iam.txt"]
    saved = client.get(f"/api/saved-replays/{run['replay_run_id']}:a").json()
    assert names(saved["responses"][0]["decision_trace"]) == ["Networks", "Segmentation", "net.txt"]
    assert saved["responses"][0]["decision_trace"][0]["outcome"] == "chosen"


def test_a_slot_that_chose_nothing_still_shows_what_it_was_offered(replay):
    client, stub = replay
    ScriptedModel(stub, by_model={"m1": {"category": None}, "m2": {}})
    run = step(client, make_run(client)).json()
    a = run["results"]["a"][0]["decision_trace"]
    assert [(s["step"], s["outcome"]) for s in a] == [("category", "none")]
    assert [o["name"] for o in a[0]["options"]] == ["Networks", "Cloud"]
    assert len(run["results"]["b"][0]["decision_trace"]) == 3


def test_each_slot_is_shown_only_its_own_earlier_selections(replay):
    client, stub = replay
    ScriptedModel(stub, by_model={"m1": {"category": 1}, "m2": {"category": 2}})
    run = step(client, make_run(client)).json()
    stub.calls.clear()
    step(client, run)
    hints = {}
    for call in router_calls(stub):
        hints.setdefault(call["model"], call["messages"][0]["content"])
    assert "Earlier in this conversation you chose: Networks > Segmentation > net.txt." in hints["m1"]
    assert "Earlier in this conversation you chose: Cloud > IAM > iam.txt." in hints["m2"]
    assert "Cloud" not in hints["m1"].split("Options")[0] and "Networks" not in hints["m2"].split("Options")[0]


def test_the_first_turn_has_no_hint(replay):
    client, stub = replay
    ScriptedModel(stub)
    step(client, make_run(client))
    assert not any("Earlier in this conversation" in c["messages"][0]["content"] for c in router_calls(stub))


def test_a_failed_step_records_nothing_and_a_retry_records_one_clean_path(replay, kb_db):
    client, stub = replay
    ScriptedModel(stub, answer_error={"m2": provider_error()})  # slot A succeeds, slot B's answer fails
    run = make_run(client)
    assert step(client, run).status_code == 502
    assert rows(kb_db) == []  # nothing is recorded for a step that did not commit
    ScriptedModel(stub)
    assert step(client, run).status_code == 200
    assert [r[1] for r in rows(kb_db)] == ["a:0"] * 3 + [
        "b:0"
    ] * 3  # exactly one path per slot, none left from the failure


def test_a_step_stopped_before_it_arrives_asks_no_one_and_records_nothing(replay, kb_db):
    client, stub = replay
    ScriptedModel(stub)
    run = make_run(client)
    client.post(f"/api/replay-runs/{run['replay_run_id']}/stop", json={"request_id": "step-early-0001"})
    assert step(client, run, "step-early-0001").status_code == 409
    assert stub.calls == [] and rows(kb_db) == []


def test_demo_mode_replay_shows_a_keyword_routed_tree_for_both_slots(logged_in_client, routing_on, llm_stub, kb_db):
    build_kb(logged_in_client)
    run = make_run(
        logged_in_client,
        prompts=["How do I use IAM with least privilege in the cloud?"],
        model_a="model-a",
        model_b="model-b",
    )
    done = step(logged_in_client, run).json()
    for slot in ("a", "b"):
        trace = done["results"][slot][0]["decision_trace"]
        assert names(trace) == ["Cloud", "IAM", "iam.txt"] and {s["model"] for s in trace} == {"demo"}
        assert done["results"][slot][0]["content"].endswith("Knowledge base: Cloud / IAM / iam.txt")
    assert llm_stub.calls == []


def test_a_replay_with_no_usable_files_has_no_traces(logged_in_client, routing_on, llm_stub):
    connect(logged_in_client)
    ScriptedModel(llm_stub)
    done = step(logged_in_client, make_run(logged_in_client)).json()  # the assistant's knowledge base is empty
    assert done["results"]["a"][0]["decision_trace"] is None and router_calls(llm_stub) == []


def test_the_walk_offers_only_current_files_in_a_replay_too(replay):
    client, stub = replay
    ScriptedModel(stub)
    step(client, make_run(client))
    first = [c for c in router_calls(stub) if c["model"] == "m1"]
    assert [level_of(c) for c in first] == ["category", "subcategory", "file"]
    assert options_of(first[0]) == ["Networks", "Cloud"] and options_of(first[2]) == ["net.txt"]


def test_choices_belong_to_the_run_and_the_user(replay, other_client, kb_db):
    client, stub = replay
    ScriptedModel(stub)
    run = step(client, make_run(client)).json()
    assert rows(kb_db, "SELECT COUNT(DISTINCT scope_id) FROM knowledge_base_choice")[0][0] == 1
    assert other_client.get(f"/api/saved-replays/{run['replay_run_id']}:a").status_code == 404


async def test_a_step_stopped_while_the_agents_are_choosing_records_nothing(async_client, routing_on, llm_stub, kb_db):
    await connect_async(async_client)
    await build_kb_async(async_client)
    ScriptedModel(llm_stub)
    created = await async_client.post(
        "/api/replay-runs", json={"prompts": ["segment?"], "model_a": "m1", "model_b": "m2"}
    )
    run = created.json()
    rid = run["replay_run_id"]
    llm_stub.gate = asyncio.Event()
    task = asyncio.create_task(
        async_client.post(
            f"/api/replay-runs/{rid}/steps", json={"expected_cursor": 0, "request_id": "step-running-001"}
        )
    )
    for _ in range(300):
        if len(llm_stub.calls) >= 2:  # both slots are asking their first routing question
            break
        await asyncio.sleep(0.01)
    assert (
        await async_client.post(f"/api/replay-runs/{rid}/stop", json={"request_id": "step-running-001"})
    ).json() == {"stopped": True}
    llm_stub.gate.set()
    response = await task
    assert response.status_code == 409 and response.json()["error"]["code"] == "stopped"
    assert rows(kb_db) == []  # the discarded step left no recorded choices
    assert (await async_client.get("/api/replay-runs/current")).json()["cursor"] == 0
