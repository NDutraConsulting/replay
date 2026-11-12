import asyncio
import sqlite3

from services.llm_service import LLMError


def create(client, **body):
    return client.post("/api/replay-runs", json=body)


def run_of(response):
    assert response.status_code in (200, 201), response.text
    return response.json()


def step(client, run):
    return client.post(f"/api/replay-runs/{run['replay_run_id']}/steps", json={"expected_cursor": run["cursor"]})


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


def current_chat(client, *prompts):
    """The user's current conversation (created empty on first use), with these prompts already sent."""
    cid = client.get("/api/conversations/current").json()["conversation_id"]
    for prompt in prompts:
        assert client.post(f"/api/conversations/{cid}/messages", json={"content": prompt}).status_code == 200
    return cid


def play_all(client, run):
    while run["cursor"] < len(run["prompts"]):
        run = run_of(step(client, run))
    return run


# ---- create / current
def test_requires_login(client):
    assert client.get("/api/replay-runs/current").status_code == 401
    assert client.get("/api/saved-replays").status_code == 401


def test_no_run_yet_is_404_then_create_uses_the_current_conversation(logged_in_client):
    assert logged_in_client.get("/api/replay-runs/current").status_code == 404
    current_chat(logged_in_client, "plan a site", "add pricing", "write copy")
    run = run_of(create(logged_in_client))
    assert run["prompts"] == ["plan a site", "add pricing", "write copy"]
    assert (run["model_a"], run["model_b"], run["agent_id"]) == ("model-a", "model-b", "assistant")
    assert run["cursor"] == 0 and run["results"] == {"a": [], "b": []} and run["step_running"] is False
    assert run_of(logged_in_client.get("/api/replay-runs/current"))["replay_run_id"] == run["replay_run_id"]


def test_create_with_no_conversation_gives_an_empty_run(logged_in_client):
    assert run_of(create(logged_in_client))["prompts"] == []


def test_create_from_explicit_prompts_a_conversation_or_a_chat_record(logged_in_client):
    assert run_of(create(logged_in_client, prompts=[" one ", "two"]))["prompts"] == ["one", "two"]
    conversation = current_chat(logged_in_client, "one", "two", "three")
    assert len(run_of(create(logged_in_client, conversation_id=conversation))["prompts"]) == 3
    record = logged_in_client.post("/api/chat-records", json={"conversation_id": conversation}).json()
    assert run_of(create(logged_in_client, chat_record_id=record["chat_record_id"]))["prompts"] == record["prompts"]


def test_create_validation(logged_in_client, other_client):
    assert create(logged_in_client, prompts=["a"], conversation_id="x").status_code == 422
    assert create(logged_in_client, prompts=["a", "  "]).status_code == 422
    assert create(logged_in_client, prompts=["a"], model_a="nope").status_code == 422
    assert create(logged_in_client, prompts=["a"], agent_id="nope").status_code == 422
    assert create(logged_in_client, conversation_id="missing").status_code == 404
    assert create(logged_in_client, chat_record_id="missing").status_code == 404
    conversation = logged_in_client.get("/api/conversations/current").json()["conversation_id"]
    assert create(other_client, conversation_id=conversation).status_code == 404


def test_models_default_to_the_first_two_configured_or_the_first_twice(logged_in_client):
    connect(logged_in_client, models=("m1", "m2", "m3"))
    run = run_of(create(logged_in_client, prompts=["a"]))
    assert (run["model_a"], run["model_b"]) == ("Default::m1", "Default::m2")
    connect(logged_in_client, models=("solo",))
    run = run_of(create(logged_in_client, prompts=["a"]))
    assert (run["model_a"], run["model_b"]) == ("Default::solo", "Default::solo")


def test_the_agent_defaults_to_the_users_preference(logged_in_client):
    logged_in_client.put("/api/preferences", json={"agent_id": "research"})
    assert run_of(create(logged_in_client, prompts=["a"]))["agent_id"] == "research"


# ---- update
def test_models_and_agent_can_change_until_the_first_step_then_lock(logged_in_client):
    connect(logged_in_client, models=("m1", "m2", "m3"))
    run = run_of(create(logged_in_client, prompts=["a", "b"]))
    url = f"/api/replay-runs/{run['replay_run_id']}"
    changed = run_of(logged_in_client.patch(url, json={"model_b": "m3", "agent_id": "code"}))
    assert (changed["model_a"], changed["model_b"], changed["agent_id"]) == ("Default::m1", "m3", "code")
    assert logged_in_client.patch(url, json={"model_a": "nope"}).status_code == 422
    run = run_of(step(logged_in_client, changed))
    locked = logged_in_client.patch(url, json={"model_a": "m2"})
    assert locked.status_code == 409 and locked.json()["error"]["code"] == "replay_locked"
    assert run["model_a"] == "Default::m1"


# ---- stepping
def test_stepping_stores_both_slots_and_advances_the_cursor(logged_in_client):
    run = run_of(create(logged_in_client, prompts=["first", "second"]))
    run = run_of(step(logged_in_client, run))
    assert run["cursor"] == 1
    a, b = run["results"]["a"][0], run["results"]["b"][0]
    assert a["turn_index"] == b["turn_index"] == 0 and a["demo"] is True and a["error"] is False
    assert a["content"].startswith("Demo · model-a") and b["content"].startswith("Demo · model-b")
    assert a["model"] == "model-a" and b["model"] == "model-b" and a["decision_trace"] is None
    assert run["saved_at"] is None


def test_a_stale_cursor_and_a_finished_run_are_conflicts(logged_in_client):
    run = run_of(create(logged_in_client, prompts=["only"]))
    assert step(logged_in_client, run).status_code == 200
    stale = step(logged_in_client, run)  # still says cursor 0
    assert stale.status_code == 409 and stale.json()["error"]["code"] == "stale_cursor"
    done = logged_in_client.post(f"/api/replay-runs/{run['replay_run_id']}/steps", json={"expected_cursor": 1})
    assert done.status_code == 409 and done.json()["error"]["code"] == "replay_complete"
    assert (
        logged_in_client.post(
            f"/api/replay-runs/{run['replay_run_id']}/steps", json={"expected_cursor": -1}
        ).status_code
        == 422
    )


def test_each_slot_only_sees_its_own_earlier_responses(logged_in_client, llm_stub):
    connect(logged_in_client)
    llm_stub.reply = lambda kw: f"{kw['model']} says {len(kw['messages'])}"
    run = run_of(create(logged_in_client, prompts=["p1", "p2", "p3"]))
    run = play_all(logged_in_client, run)
    last_by_model = {c["model"]: c["messages"] for c in llm_stub.calls[-2:]}
    assert [m["content"] for m in last_by_model["m1"]] == ["p1", "m1 says 1", "p2", "m1 says 3", "p3"]
    assert [m["content"] for m in last_by_model["m2"]] == ["p1", "m2 says 1", "p2", "m2 says 3", "p3"]
    first = llm_stub.calls[0]
    assert first["messages"] == [{"role": "user", "content": "p1"}] and "helpful assistant" in first["system"]
    assert run["results"]["a"][2]["content"] == "m1 says 5" and run["results"]["b"][2]["content"] == "m2 says 5"


def test_the_same_model_in_both_slots_keeps_separate_results(logged_in_client, llm_stub):
    connect(logged_in_client)
    counter = iter(range(100))
    llm_stub.reply = lambda kw: f"answer #{next(counter)}"
    run = run_of(create(logged_in_client, prompts=["p1"], model_a="m1", model_b="m1"))
    run = run_of(step(logged_in_client, run))
    assert {run["results"]["a"][0]["content"], run["results"]["b"][0]["content"]} == {"answer #0", "answer #1"}
    saved = logged_in_client.get("/api/saved-replays").json()
    assert [s["id"].split(":")[1] for s in saved] == ["a", "b"] and {s["model"] for s in saved} == {"m1"}


def test_a_step_is_all_or_nothing(logged_in_client, llm_stub):
    connect(logged_in_client)

    def reply(kw):
        if kw["model"] == "m2":
            raise LLMError(
                502, "llm_http_error", "API returned HTTP 500. Check your key, model ID, and endpoint in Account."
            )
        return "fine"

    llm_stub.reply = reply
    run = run_of(create(logged_in_client, prompts=["p1", "p2"]))
    failed = step(logged_in_client, run)
    assert failed.status_code == 502 and failed.json()["error"]["code"] == "llm_http_error"
    again = run_of(logged_in_client.get("/api/replay-runs/current"))
    assert again["cursor"] == 0 and again["results"] == {"a": [], "b": []} and again["step_running"] is False
    llm_stub.reply = None
    assert step(logged_in_client, again).status_code == 200  # the failed attempt did not wedge the run


def test_completing_a_run_saves_it_and_a_further_step_is_refused(logged_in_client):
    run = play_all(logged_in_client, run_of(create(logged_in_client, prompts=["p1", "p2"])))
    assert run["saved_at"] is not None and run["cursor"] == 2
    summaries = logged_in_client.get("/api/saved-replays").json()
    assert [(s["slot"], s["completed"], s["prompt_count"], s["response_count"]) for s in summaries] == [
        ("a", True, 2, 2),
        ("b", True, 2, 2),
    ]


# ---- save / saved replays
def test_partial_runs_are_saved_only_on_request_and_need_results(logged_in_client):
    run = run_of(create(logged_in_client, prompts=["p1", "p2"]))
    nothing = logged_in_client.post(f"/api/replay-runs/{run['replay_run_id']}/save")
    assert nothing.status_code == 409 and nothing.json()["error"]["code"] == "nothing_to_save"
    run = run_of(step(logged_in_client, run))
    assert logged_in_client.get("/api/saved-replays").json() == []
    saved = run_of(logged_in_client.post(f"/api/replay-runs/{run['replay_run_id']}/save"))
    assert saved["saved_at"] is not None
    summary = logged_in_client.get("/api/saved-replays").json()
    assert [(s["completed"], s["response_count"], s["prompt_count"]) for s in summary] == [(False, 1, 2), (False, 1, 2)]
    again = run_of(logged_in_client.post(f"/api/replay-runs/{run['replay_run_id']}/save"))
    assert again["saved_at"] == saved["saved_at"]  # saving twice keeps the first timestamp


def test_starting_a_new_run_saves_the_previous_one_only_if_it_has_results(logged_in_client):
    empty = run_of(create(logged_in_client, prompts=["p1", "p2"]))
    with_results = run_of(create(logged_in_client, prompts=["p1", "p2"]))
    run_of(step(logged_in_client, with_results))
    run_of(create(logged_in_client, prompts=["p1"]))
    saved = logged_in_client.get("/api/saved-replays").json()
    assert {s["replay_run_id"] for s in saved} == {with_results["replay_run_id"]}
    assert empty["replay_run_id"] not in {s["replay_run_id"] for s in saved}


def test_saved_replay_detail_has_the_prompts_and_that_slots_responses(logged_in_client):
    run = play_all(logged_in_client, run_of(create(logged_in_client, prompts=["p1", "p2"])))
    summary = logged_in_client.get("/api/saved-replays").json()[1]
    assert summary["id"] == f"{run['replay_run_id']}:b"
    detail = run_of(logged_in_client.get(f"/api/saved-replays/{summary['id']}"))
    assert detail["prompts"] == ["p1", "p2"] and detail["slot"] == "b" and detail["model"] == "model-b"
    assert [r["turn_index"] for r in detail["responses"]] == [0, 1] and {r["slot"] for r in detail["responses"]} == {
        "b"
    }


def test_saved_replay_detail_404s(logged_in_client, other_client):
    run = run_of(create(logged_in_client, prompts=["p1", "p2"]))
    run = run_of(step(logged_in_client, run))
    unsaved = f"{run['replay_run_id']}:a"
    assert logged_in_client.get(f"/api/saved-replays/{unsaved}").status_code == 404  # not saved yet
    logged_in_client.post(f"/api/replay-runs/{run['replay_run_id']}/save")
    assert logged_in_client.get(f"/api/saved-replays/{unsaved}").status_code == 200
    assert logged_in_client.get(f"/api/saved-replays/{run['replay_run_id']}:c").status_code == 404
    assert logged_in_client.get("/api/saved-replays/nonsense").status_code == 404
    assert other_client.get(f"/api/saved-replays/{unsaved}").status_code == 404
    assert other_client.get("/api/saved-replays").json() == []


# ---- ownership
def test_other_users_cannot_touch_a_run(logged_in_client, other_client):
    run = run_of(create(logged_in_client, prompts=["p1"]))
    rid = run["replay_run_id"]
    assert other_client.patch(f"/api/replay-runs/{rid}", json={"agent_id": "code"}).status_code == 404
    assert other_client.post(f"/api/replay-runs/{rid}/steps", json={"expected_cursor": 0}).status_code == 404
    assert other_client.post(f"/api/replay-runs/{rid}/stop").status_code == 404
    assert other_client.post(f"/api/replay-runs/{rid}/save").status_code == 404
    assert other_client.get("/api/replay-runs/current").status_code == 404


# ---- stop and concurrency (requests are held in flight, so these run on the test's own event loop)
async def connect_async(client, models=("m1", "m2")):
    response = await client.post(
        "/api/connections",
        json={"label": "Default", "url": "https://api.example.com/v1", "api_key": "sk-secret", "models": list(models)},
    )
    assert response.status_code == 201


async def new_run(client, prompts=("p1", "p2")):
    response = await client.post("/api/replay-runs", json={"prompts": list(prompts)})
    assert response.status_code == 201
    return response.json()


async def start_step(client, run, llm_stub, calls_expected=2):
    llm_stub.gate = asyncio.Event()
    task = asyncio.create_task(
        client.post(f"/api/replay-runs/{run['replay_run_id']}/steps", json={"expected_cursor": run["cursor"]})
    )
    for _ in range(300):
        if len(llm_stub.calls) >= calls_expected:
            return task
        await asyncio.sleep(0.01)
    raise AssertionError(f"expected {calls_expected} model calls in flight, saw {len(llm_stub.calls)}")


async def test_both_models_are_called_concurrently(async_client, llm_stub):
    await connect_async(async_client)
    run = await new_run(async_client)
    task = await start_step(async_client, run, llm_stub)  # waits for BOTH calls while the gate is closed
    assert {c["model"] for c in llm_stub.calls} == {"m1", "m2"}
    view = (await async_client.get("/api/replay-runs/current")).json()
    assert view["step_running"] is True and view["cursor"] == 0
    llm_stub.gate.set()
    assert (await task).json()["cursor"] == 1


async def test_a_second_step_while_one_is_running_is_refused(async_client, llm_stub):
    await connect_async(async_client)
    run = await new_run(async_client)
    task = await start_step(async_client, run, llm_stub)
    second = await async_client.post(f"/api/replay-runs/{run['replay_run_id']}/steps", json={"expected_cursor": 0})
    assert second.status_code == 409 and second.json()["error"]["code"] == "step_in_progress"
    llm_stub.gate.set()
    assert (await task).status_code == 200


async def test_stop_mid_step_stores_nothing_and_leaves_the_cursor(async_client, llm_stub):
    await connect_async(async_client)
    run = await new_run(async_client)
    rid = run["replay_run_id"]
    task = await start_step(async_client, run, llm_stub)
    assert (await async_client.post(f"/api/replay-runs/{rid}/stop")).json() == {"stopped": True}
    llm_stub.gate.set()
    response = await task
    assert response.status_code == 409 and response.json()["error"]["code"] == "stopped"
    view = (await async_client.get("/api/replay-runs/current")).json()
    assert view["cursor"] == 0 and view["results"] == {"a": [], "b": []} and view["step_running"] is False

    llm_stub.gate = None  # the same step can be run again afterwards
    again = await async_client.post(f"/api/replay-runs/{rid}/steps", json={"expected_cursor": 0})
    assert again.status_code == 200 and again.json()["cursor"] == 1


async def test_stop_when_idle_is_a_no_op_and_does_not_poison_the_next_step(async_client):
    run = await new_run(async_client)
    rid = run["replay_run_id"]
    assert (await async_client.post(f"/api/replay-runs/{rid}/stop")).json() == {"stopped": False}
    step_response = await async_client.post(f"/api/replay-runs/{rid}/steps", json={"expected_cursor": 0})
    assert step_response.status_code == 200 and step_response.json()["cursor"] == 1


async def test_a_dead_step_does_not_wedge_the_run(async_client, db):
    run = await new_run(async_client)
    rid = run["replay_run_id"]
    conn = sqlite3.connect(db)
    conn.execute("UPDATE replay_runs SET step_started_at = '2000-01-01T00:00:00+00:00' WHERE replay_run_id = ?", (rid,))
    conn.commit()
    assert (await async_client.get("/api/replay-runs/current")).json()["step_running"] is False
    assert (await async_client.post(f"/api/replay-runs/{rid}/steps", json={"expected_cursor": 0})).status_code == 200


# ---- a stop command can reach the server before the step it cancels (found by the live frontend test)
def step_with_id(client, run_id, cursor, request_id):
    return client.post(f"/api/replay-runs/{run_id}/steps", json={"expected_cursor": cursor, "request_id": request_id})


async def post_step(client, run_id, cursor, request_id):
    return await client.post(
        f"/api/replay-runs/{run_id}/steps", json={"expected_cursor": cursor, "request_id": request_id}
    )


async def test_a_stop_that_beats_its_step_to_the_server_is_honored(async_client, llm_stub):
    await connect_async(async_client)
    run = await new_run(async_client)
    rid = run["replay_run_id"]
    stop = await async_client.post(f"/api/replay-runs/{rid}/stop", json={"request_id": "step-early-0001"})
    assert stop.json() == {"stopped": True}

    refused = await post_step(async_client, rid, 0, "step-early-0001")
    assert refused.status_code == 409 and refused.json()["error"]["code"] == "stopped"
    assert llm_stub.calls == []  # no model was called
    view = (await async_client.get("/api/replay-runs/current")).json()
    assert view["cursor"] == 0 and view["results"] == {"a": [], "b": []} and view["step_running"] is False


async def test_a_stop_marker_never_blocks_a_different_step_at_the_same_cursor(async_client):
    """The bug a cursor-keyed marker had: Stop pressed, the step never arrives, and the user's NEXT step is refused."""
    run = await new_run(async_client)
    rid = run["replay_run_id"]
    await async_client.post(f"/api/replay-runs/{rid}/stop", json={"request_id": "step-never-arrives"})
    later = await post_step(async_client, rid, 0, "step-the-next-try")
    assert later.status_code == 200 and later.json()["cursor"] == 1


async def test_a_stop_marker_is_used_up_by_its_own_step(async_client):
    run = await new_run(async_client)
    rid = run["replay_run_id"]
    await async_client.post(f"/api/replay-runs/{rid}/stop", json={"request_id": "step-once-00001"})
    assert (await post_step(async_client, rid, 0, "step-once-00001")).status_code == 409
    assert (await post_step(async_client, rid, 0, "step-once-00001")).status_code == 200  # the id was used up


async def test_stopping_a_step_that_already_finished_does_nothing(async_client):
    run = await new_run(async_client)
    rid = run["replay_run_id"]
    assert (await post_step(async_client, rid, 0, "step-done-00001")).status_code == 200
    stop = await async_client.post(f"/api/replay-runs/{rid}/stop", json={"request_id": "step-done-00001"})
    assert stop.json() == {"stopped": False}
    assert (await async_client.get("/api/replay-runs/current")).json()["cursor"] == 1


async def test_a_stop_naming_the_running_step_discards_it(async_client, llm_stub):
    await connect_async(async_client)
    run = await new_run(async_client)
    rid = run["replay_run_id"]
    llm_stub.gate = asyncio.Event()
    task = asyncio.create_task(post_step(async_client, rid, 0, "step-running-001"))
    for _ in range(300):
        if len(llm_stub.calls) >= 2:
            break
        await asyncio.sleep(0.01)
    assert (
        await async_client.post(f"/api/replay-runs/{rid}/stop", json={"request_id": "step-running-001"})
    ).json() == {"stopped": True}
    llm_stub.gate.set()
    response = await task
    assert response.status_code == 409 and response.json()["error"]["code"] == "stopped"
    assert (await async_client.get("/api/replay-runs/current")).json()["cursor"] == 0


def test_step_request_ids_are_validated(logged_in_client):
    run = run_of(create(logged_in_client, prompts=["p"]))
    bad = logged_in_client.post(
        f"/api/replay-runs/{run['replay_run_id']}/steps", json={"expected_cursor": 0, "request_id": "no spaces allowed"}
    )
    assert bad.status_code == 422


# ---- a run remembers the chat it came from (the Replay page numbers a chat's saved replays as versions)
def test_a_run_started_from_a_chat_is_tied_to_it_and_so_are_its_saved_replays(logged_in_client):
    cid = current_chat(logged_in_client, "one", "two")
    run = run_of(create(logged_in_client, conversation_id=cid))
    assert run["source_conversation_id"] == cid
    done = play_all(logged_in_client, run)
    assert done["source_conversation_id"] == cid
    saved = logged_in_client.get("/api/saved-replays").json()
    assert saved and all(s["source_conversation_id"] == cid for s in saved)
    assert logged_in_client.get(f"/api/saved-replays/{saved[0]['id']}").json()["source_conversation_id"] == cid


def test_with_no_source_the_current_chat_is_used_and_recorded(logged_in_client):
    cid = current_chat(logged_in_client, "one")
    assert run_of(create(logged_in_client))["source_conversation_id"] == cid


def test_explicit_prompts_have_no_chat_unless_one_is_named(logged_in_client):
    cid = current_chat(logged_in_client, "one")
    assert run_of(create(logged_in_client, prompts=["x"]))["source_conversation_id"] is None
    assert run_of(create(logged_in_client, prompts=["x"], source_conversation_id=cid))["source_conversation_id"] == cid
    # a chat that is not the user's is ignored, not trusted
    assert (
        run_of(create(logged_in_client, prompts=["x"], source_conversation_id="missing"))["source_conversation_id"]
        is None
    )


def test_a_chat_record_run_has_no_chat(logged_in_client):
    cid = current_chat(logged_in_client, "one")
    record = logged_in_client.post("/api/chat-records", json={"conversation_id": cid}).json()
    assert run_of(create(logged_in_client, chat_record_id=record["chat_record_id"]))["source_conversation_id"] is None


# ---- temperature (0 to 2) on a run
def warm_chat(client, temperature):
    cid = client.post(
        "/api/conversations",
        json={"name": "Warm", "agent_id": "assistant", "model": "model-a", "temperature": temperature},
    ).json()["conversation_id"]
    assert client.post(f"/api/conversations/{cid}/messages", json={"content": "hello"}).status_code == 200
    return cid


def test_a_run_starts_from_its_chats_temperature_and_can_change_it_before_the_first_step(logged_in_client):
    cid = warm_chat(logged_in_client, 0.7)
    run = run_of(create(logged_in_client, conversation_id=cid))
    assert run["temperature"] == 0.7
    changed = logged_in_client.patch(f"/api/replay-runs/{run['replay_run_id']}", json={"temperature": 1.5})
    assert changed.status_code == 200 and changed.json()["temperature"] == 1.5
    assert run_of(create(logged_in_client, conversation_id=cid, temperature=0.2))["temperature"] == 0.2
    assert run_of(create(logged_in_client, prompts=["x"]))["temperature"] == 0


def test_temperature_outside_zero_to_two_is_refused_on_a_run(logged_in_client):
    run = run_of(create(logged_in_client, prompts=["x"]))
    assert create(logged_in_client, prompts=["x"], temperature=3).status_code == 422
    assert (
        logged_in_client.patch(f"/api/replay-runs/{run['replay_run_id']}", json={"temperature": -1}).status_code == 422
    )


def test_the_runs_temperature_is_sent_with_each_replayed_prompt_and_shown_on_saved_replays(logged_in_client, llm_stub):
    connect(logged_in_client)
    cid = logged_in_client.post(
        "/api/conversations", json={"name": "T", "agent_id": "assistant", "model": "m1", "temperature": 0.9}
    ).json()["conversation_id"]
    logged_in_client.post(f"/api/conversations/{cid}/messages", json={"content": "hello"})
    llm_stub.calls.clear()
    run = run_of(create(logged_in_client, conversation_id=cid))
    play_all(logged_in_client, run)
    assert llm_stub.calls and all(call["temperature"] == 0.9 for call in llm_stub.calls)
    saved = logged_in_client.get("/api/saved-replays").json()
    assert saved and all(s["temperature"] == 0.9 for s in saved)


# ---- brief replies: the chat's switch is carried into the run, so both models get the same instruction
def test_a_run_starts_from_its_chats_brief_replies_and_can_change_them_before_the_first_step(logged_in_client):
    cid = logged_in_client.post(
        "/api/conversations", json={"name": "B", "agent_id": "assistant", "model": "model-a", "brief_replies": True}
    ).json()["conversation_id"]
    run = run_of(create(logged_in_client, conversation_id=cid))
    assert run["brief_replies"] is True
    changed = logged_in_client.patch(f"/api/replay-runs/{run['replay_run_id']}", json={"brief_replies": False})
    assert changed.status_code == 200 and changed.json()["brief_replies"] is False
    assert run_of(create(logged_in_client, conversation_id=cid, brief_replies=False))["brief_replies"] is False
    assert run_of(create(logged_in_client, prompts=["x"]))["brief_replies"] is False


def test_the_instruction_is_sent_with_each_replayed_prompt_and_shown_on_saved_replays(logged_in_client, llm_stub):
    connect(logged_in_client)
    cid = logged_in_client.post(
        "/api/conversations", json={"name": "B", "agent_id": "assistant", "model": "m1", "brief_replies": True}
    ).json()["conversation_id"]
    logged_in_client.post(f"/api/conversations/{cid}/messages", json={"content": "hello"})
    llm_stub.calls.clear()
    run = run_of(create(logged_in_client, conversation_id=cid))
    play_all(logged_in_client, run)
    answers = [c for c in llm_stub.calls if c["messages"] and c["messages"][-1]["role"] == "user"]
    assert answers and all(c["messages"][-1]["content"].endswith("Respond in 100 words or less.") for c in answers[-2:])
    saved = logged_in_client.get("/api/saved-replays").json()
    assert saved and all(s["brief_replies"] is True for s in saved)


# ---- the raw API log of a saved replay
def saved_ids(client):
    return [s["id"] for s in client.get("/api/saved-replays").json()]


def api_log(client, saved_id):
    return client.get(f"/api/saved-replays/{saved_id}/api-log")


def test_the_api_log_needs_login(client):
    assert client.get("/api/saved-replays/x:a/api-log").status_code == 401


def test_the_api_log_needs_an_owned_saved_replay(logged_in_client, other_client):
    cid = current_chat(logged_in_client, "hello")
    play_all(logged_in_client, run_of(create(logged_in_client, conversation_id=cid)))
    mine = saved_ids(logged_in_client)[0]
    assert api_log(other_client, mine).status_code == 404
    assert api_log(logged_in_client, "missing:a").status_code == 404


def test_a_connected_replay_keeps_each_rest_call_per_turn_and_never_the_key(logged_in_client, llm_stub):
    connect(logged_in_client)
    cid = logged_in_client.post(
        "/api/conversations", json={"name": "L", "agent_id": "assistant", "model": "m1", "temperature": 0.3}
    ).json()["conversation_id"]
    for prompt in ("first", "second"):
        logged_in_client.post(f"/api/conversations/{cid}/messages", json={"content": prompt})
    run = run_of(create(logged_in_client, conversation_id=cid))
    play_all(logged_in_client, run)
    body = api_log(logged_in_client, f"{run['replay_run_id']}:a")
    assert body.status_code == 200
    log = body.json()
    assert log["recorded"] is True and log["model"] == "m1"
    assert [t["turn_index"] for t in log["turns"]] == [0, 1]
    assert [t["prompt"] for t in log["turns"]] == ["first", "second"]
    call = log["turns"][0]["calls"][0]
    assert call["method"] == "POST" and call["url"] == "https://api.example.com/v1/chat/completions"
    assert call["purpose"] == "answer" and call["response"]["status"] == 200
    assert call["request"]["body"]["model"] == "m1" and call["request"]["body"]["temperature"] == 0.3
    assert (
        call["request"]["body"]["messages"][-1]["content"] == "second"
        or call["request"]["body"]["messages"][-1]["content"] == "first"
    )
    assert call["request"]["headers"]["Authorization"] == "Bearer <redacted>"
    assert "sk-secret" not in body.text


def test_each_slot_has_its_own_calls(logged_in_client, llm_stub):
    connect(logged_in_client)
    cid = logged_in_client.post(
        "/api/conversations", json={"name": "L", "agent_id": "assistant", "model": "m1"}
    ).json()["conversation_id"]
    logged_in_client.post(f"/api/conversations/{cid}/messages", json={"content": "hello"})
    run = run_of(create(logged_in_client, conversation_id=cid, model_a="m1", model_b="m2"))
    play_all(logged_in_client, run)
    a = api_log(logged_in_client, f"{run['replay_run_id']}:a").json()
    b = api_log(logged_in_client, f"{run['replay_run_id']}:b").json()
    assert [c["request"]["body"]["model"] for t in a["turns"] for c in t["calls"]] == ["m1"]
    assert [c["request"]["body"]["model"] for t in b["turns"] for c in t["calls"]] == ["m2"]


def test_demo_mode_makes_no_calls_so_the_log_is_recorded_but_empty(logged_in_client):
    cid = current_chat(logged_in_client, "hello")
    run = run_of(create(logged_in_client, conversation_id=cid))
    play_all(logged_in_client, run)
    log = api_log(logged_in_client, f"{run['replay_run_id']}:a").json()
    assert log["recorded"] is True and [t["calls"] for t in log["turns"]] == [[]]


def test_a_replay_saved_before_calls_were_kept_says_not_recorded(logged_in_client, test_settings):
    cid = current_chat(logged_in_client, "hello")
    run = run_of(create(logged_in_client, conversation_id=cid))
    play_all(logged_in_client, run)
    with sqlite3.connect(test_settings.LOG_DB_PATH) as conn:  # as if the replay were saved before logs existed
        conn.execute("DELETE FROM api_log_turns")
        conn.execute("DELETE FROM api_calls")
    log = api_log(logged_in_client, f"{run['replay_run_id']}:a").json()
    assert log["recorded"] is False and [t["calls"] for t in log["turns"]] == [[]]


# ---- log probabilities (the Config popup's toggle)
def test_a_run_asks_for_logprobs_only_when_told_to_and_can_change_it_before_the_first_step(logged_in_client):
    off = run_of(create(logged_in_client, prompts=["x"]))
    assert off["logprobs"] is False
    on = run_of(create(logged_in_client, prompts=["x"], logprobs=True))
    assert on["logprobs"] is True
    changed = logged_in_client.patch(f"/api/replay-runs/{on['replay_run_id']}", json={"logprobs": False})
    assert changed.status_code == 200 and changed.json()["logprobs"] is False
    again = logged_in_client.patch(f"/api/replay-runs/{on['replay_run_id']}", json={"logprobs": True})
    assert again.json()["logprobs"] is True
    kept = logged_in_client.patch(f"/api/replay-runs/{on['replay_run_id']}", json={"temperature": 1})
    assert kept.json()["logprobs"] is True  # an unrelated change leaves it alone


def test_the_logprobs_switch_locks_with_the_rest_once_the_replay_starts(logged_in_client):
    run = run_of(create(logged_in_client, prompts=["x", "y"]))
    run_of(step(logged_in_client, run))
    locked = logged_in_client.patch(f"/api/replay-runs/{run['replay_run_id']}", json={"logprobs": True})
    assert locked.status_code == 409 and locked.json()["error"]["code"] == "replay_locked"


def test_the_logprobs_setting_is_shown_on_saved_replays_and_the_api_log(logged_in_client, llm_stub):
    connect(logged_in_client)
    run = run_of(create(logged_in_client, prompts=["only"], model_a="m1", model_b="m2", logprobs=True))
    play_all(logged_in_client, run)
    saved = logged_in_client.get("/api/saved-replays").json()
    assert saved and all(s["logprobs"] is True for s in saved)
    log = logged_in_client.get(f"/api/saved-replays/{run['replay_run_id']}:a/api-log").json()
    assert log["logprobs"] is True
    assert log["turns"][0]["calls"][0]["settings"]["logprobs"] is True
    assert all(call["logprobs"] is True for call in llm_stub.calls)  # every call of the replay asked for them


# ---- the answer tokens' log probabilities, for the Diff page
def logprob_run(client, llm_stub, logprobs=True):
    connect(client)
    llm_stub.token_logprobs = [{"token": "Hello", "logprob": -0.1}, {"token": " world", "logprob": -3.2}]
    run = run_of(create(client, prompts=["one", "two"], model_a="m1", model_b="m2", logprobs=logprobs))
    play_all(client, run)
    return run


def test_the_logprobs_endpoint_needs_login_and_an_owned_saved_replay(client):
    assert client.get("/api/saved-replays/x:a/logprobs").status_code == 401


def test_the_logprobs_endpoint_is_not_found_for_someone_elses_replay(logged_in_client, other_client, llm_stub):
    run = logprob_run(logged_in_client, llm_stub)
    assert other_client.get(f"/api/saved-replays/{run['replay_run_id']}:a/logprobs").status_code == 404
    assert logged_in_client.get("/api/saved-replays/missing:a/logprobs").status_code == 404


def test_it_returns_each_turns_answer_tokens_per_slot(logged_in_client, llm_stub):
    run = logprob_run(logged_in_client, llm_stub)
    body = logged_in_client.get(f"/api/saved-replays/{run['replay_run_id']}:a/logprobs").json()
    assert body["available"] is True and body["id"] == f"{run['replay_run_id']}:a"
    assert [t["turn_index"] for t in body["turns"]] == [0, 1]
    assert body["turns"][0]["tokens"] == [{"token": "Hello", "logprob": -0.1}, {"token": " world", "logprob": -3.2}]
    other = logged_in_client.get(f"/api/saved-replays/{run['replay_run_id']}:b/logprobs").json()
    assert other["available"] is True and other["turns"][1]["tokens"][1]["logprob"] == -3.2


def test_it_says_unavailable_when_the_replay_did_not_ask_or_the_model_returned_none(logged_in_client, llm_stub):
    run = logprob_run(logged_in_client, llm_stub, logprobs=False)  # the switch was off: no tokens were asked for
    body = logged_in_client.get(f"/api/saved-replays/{run['replay_run_id']}:a/logprobs").json()
    assert body["available"] is False and [t["tokens"] for t in body["turns"]] == [None, None]


def test_demo_mode_has_no_logprobs_to_show(logged_in_client):
    cid = current_chat(logged_in_client, "hello")
    run = run_of(create(logged_in_client, conversation_id=cid, logprobs=True))
    play_all(logged_in_client, run)
    body = logged_in_client.get(f"/api/saved-replays/{run['replay_run_id']}:a/logprobs").json()
    assert body["available"] is False


# ---- a replay runs at most MAX_USER_PROMPTS prompts
def test_a_replay_of_a_longer_chat_uses_its_first_prompts(logged_in_client, monkeypatch, test_settings):
    cid = current_chat(logged_in_client, "p1", "p2", "p3", "p4", "p5")
    monkeypatch.setattr(test_settings, "MAX_USER_PROMPTS", 3)  # the chat was made when more were allowed
    assert run_of(create(logged_in_client, conversation_id=cid))["prompts"] == ["p1", "p2", "p3"]
    assert run_of(create(logged_in_client))["prompts"] == ["p1", "p2", "p3"]  # the current chat


def test_explicit_prompts_over_the_limit_are_refused_and_at_the_limit_are_not(
    logged_in_client, monkeypatch, test_settings
):
    monkeypatch.setattr(test_settings, "MAX_USER_PROMPTS", 3)
    assert len(run_of(create(logged_in_client, prompts=["a", "b", "c"]))["prompts"]) == 3
    over = create(logged_in_client, prompts=["a", "b", "c", "d"])
    assert over.status_code == 422
    assert "at most 3 prompts" in over.json()["error"]["message"]


def test_a_chat_record_is_cut_to_the_limit_too(logged_in_client, monkeypatch, test_settings):
    cid = current_chat(logged_in_client, "p1", "p2", "p3", "p4")
    record = logged_in_client.post("/api/chat-records", json={"conversation_id": cid}).json()
    monkeypatch.setattr(test_settings, "MAX_USER_PROMPTS", 2)
    assert run_of(create(logged_in_client, chat_record_id=record["chat_record_id"]))["prompts"] == ["p1", "p2"]


def test_the_default_replay_limit_is_ten(logged_in_client):
    many = [f"p{i}" for i in range(11)]
    assert create(logged_in_client, prompts=many).status_code == 422
    assert len(run_of(create(logged_in_client, prompts=many[:10]))["prompts"]) == 10
