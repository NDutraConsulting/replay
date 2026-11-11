def test_agents_list_hides_system_prompts(logged_in_client):
    response = logged_in_client.get("/api/agents")
    assert response.json() == [
        {"id": "assistant", "name": "General assistant"},
        {"id": "code", "name": "Code assistant"},
        {"id": "research", "name": "IT Security Assistant"},
    ]
    assert "system_prompt" not in response.text and "helpful assistant" not in response.text


def test_agents_require_login(client):
    assert client.get("/api/agents").status_code == 401


def test_preferences_defaults_keep_the_replay_prompts_panel_closed(logged_in_client):
    assert logged_in_client.get("/api/preferences").json() == {
        "agent_id": "assistant",
        "model": None,
        "chat_sidebar_hidden": False,
        "replay_prompts_hidden": True,
    }


def test_preferences_update_only_the_fields_sent(logged_in_client):
    first = logged_in_client.put("/api/preferences", json={"agent_id": "code", "model": "m1"}).json()
    assert first["agent_id"] == "code" and first["model"] == "m1" and first["replay_prompts_hidden"] is True
    second = logged_in_client.put("/api/preferences", json={"replay_prompts_hidden": False}).json()
    assert second == {"agent_id": "code", "model": "m1", "chat_sidebar_hidden": False, "replay_prompts_hidden": False}
    assert logged_in_client.get("/api/preferences").json() == second


def test_preferences_can_clear_the_model_with_an_explicit_null(logged_in_client):
    logged_in_client.put("/api/preferences", json={"model": "m1"})
    assert logged_in_client.put("/api/preferences", json={"model": None}).json()["model"] is None


def test_preferences_reject_unknown_agents_and_nulls(logged_in_client):
    assert logged_in_client.put("/api/preferences", json={"agent_id": "nope"}).status_code == 422
    assert logged_in_client.put("/api/preferences", json={"agent_id": None}).status_code == 422
    assert logged_in_client.put("/api/preferences", json={"chat_sidebar_hidden": None}).status_code == 422


def test_preferences_are_per_user(logged_in_client, other_client):
    logged_in_client.put("/api/preferences", json={"agent_id": "research"})
    assert other_client.get("/api/preferences").json()["agent_id"] == "assistant"


def test_demo_responses_follow_the_old_browser_text():
    from services.demo_response_service import demo_response

    history = [{"role": "user", "content": "x" * 200}]
    text = demo_response(history, "model-b", "assistant", ["model-a", "model-b", "model-c"])
    assert text.startswith("Demo · model-b\n\nHere’s a concise direction for “" + "x" * 150 + "…”")
    assert "Research plan" in demo_response(history, "m", "research", ["m"])
    assert "reviewable implementation" in demo_response(history, "m", "code", ["m"])
    assert "Let’s explore" in demo_response(history, "model-c", "assistant", ["model-a", "model-b", "model-c"])
    assert "useful starting point" in demo_response(history, "model-a", "assistant", ["model-a", "model-b", "model-c"])


async def test_concurrent_preference_updates_do_not_overwrite_each_other(async_client):
    """Found by the live frontend test: changing the agent, the model and the sidebar in quick succession fires
    three PUTs at once. Each must change only its own field."""
    import asyncio

    results = await asyncio.gather(
        async_client.put("/api/preferences", json={"agent_id": "research"}),
        async_client.put("/api/preferences", json={"model": "model-c"}),
        async_client.put("/api/preferences", json={"chat_sidebar_hidden": True}),
        async_client.put("/api/preferences", json={"replay_prompts_hidden": False}),
    )
    assert all(r.status_code == 200 for r in results)
    assert (await async_client.get("/api/preferences")).json() == {
        "agent_id": "research",
        "model": "model-c",
        "chat_sidebar_hidden": True,
        "replay_prompts_hidden": False,
    }


def test_the_first_update_creates_the_row_with_defaults_for_everything_else(logged_in_client):
    body = logged_in_client.put("/api/preferences", json={"chat_sidebar_hidden": True}).json()
    assert body == {"agent_id": "assistant", "model": None, "chat_sidebar_hidden": True, "replay_prompts_hidden": True}
