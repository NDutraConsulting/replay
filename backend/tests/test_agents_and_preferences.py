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
        "chat_sidebar_hidden": True,
        "replay_prompts_hidden": True,
        "show_compact_button": False,
        "show_rewind_button": True,
        "show_page_popups": True,
        "api_tour_seen": False,
    }


def test_preferences_update_only_the_fields_sent(logged_in_client):
    first = logged_in_client.put("/api/preferences", json={"agent_id": "code", "model": "m1"}).json()
    assert first["agent_id"] == "code" and first["model"] == "m1" and first["replay_prompts_hidden"] is True
    second = logged_in_client.put("/api/preferences", json={"replay_prompts_hidden": False}).json()
    assert second == {
        "agent_id": "code",
        "model": "m1",
        "chat_sidebar_hidden": True,
        "replay_prompts_hidden": False,
        "show_compact_button": False,
        "show_rewind_button": True,
        "show_page_popups": True,
        "api_tour_seen": False,
    }
    assert logged_in_client.get("/api/preferences").json() == second


def test_preferences_can_clear_the_model_with_an_explicit_null(logged_in_client):
    logged_in_client.put("/api/preferences", json={"model": "m1"})
    assert logged_in_client.put("/api/preferences", json={"model": None}).json()["model"] is None


def test_preferences_reject_unknown_agents_and_nulls(logged_in_client):
    assert logged_in_client.put("/api/preferences", json={"agent_id": "nope"}).status_code == 422
    assert logged_in_client.put("/api/preferences", json={"agent_id": None}).status_code == 422
    assert logged_in_client.put("/api/preferences", json={"chat_sidebar_hidden": None}).status_code == 422
    assert logged_in_client.put("/api/preferences", json={"show_compact_button": None}).status_code == 422
    assert logged_in_client.put("/api/preferences", json={"show_rewind_button": None}).status_code == 422


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
        "show_compact_button": False,
        "show_rewind_button": True,
        "show_page_popups": True,
        "api_tour_seen": False,
    }


def test_the_first_update_creates_the_row_with_defaults_for_everything_else(logged_in_client):
    body = logged_in_client.put("/api/preferences", json={"chat_sidebar_hidden": True}).json()
    assert body == {
        "agent_id": "assistant",
        "model": None,
        "chat_sidebar_hidden": True,
        "replay_prompts_hidden": True,
        "show_compact_button": False,
        "show_rewind_button": True,
        "show_page_popups": True,
        "api_tour_seen": False,
    }


# ---- the Chat page's optional buttons (the Config popup's two switches)
def test_the_compact_button_is_off_and_the_rewind_button_on_by_default(logged_in_client):
    body = logged_in_client.get("/api/preferences").json()
    assert body["show_compact_button"] is False
    assert body["show_rewind_button"] is True


def test_each_button_switch_changes_alone_and_is_remembered(logged_in_client):
    on = logged_in_client.put("/api/preferences", json={"show_compact_button": True}).json()
    assert on["show_compact_button"] is True and on["show_rewind_button"] is True  # the other is untouched
    off = logged_in_client.put("/api/preferences", json={"show_rewind_button": False}).json()
    assert off["show_compact_button"] is True and off["show_rewind_button"] is False
    assert logged_in_client.get("/api/preferences").json() == off  # saved on the server, not in the browser
    back = logged_in_client.put(
        "/api/preferences", json={"show_compact_button": False, "show_rewind_button": True}
    ).json()
    assert back["show_compact_button"] is False and back["show_rewind_button"] is True


def test_the_button_switches_do_not_disturb_the_other_preferences(logged_in_client):
    logged_in_client.put("/api/preferences", json={"agent_id": "code", "model": "m1"})
    after = logged_in_client.put("/api/preferences", json={"show_compact_button": True}).json()
    assert after["agent_id"] == "code" and after["model"] == "m1"
    again = logged_in_client.put("/api/preferences", json={"model": "m2"}).json()
    assert again["show_compact_button"] is True  # changing something else keeps the switch


def test_the_button_switches_are_per_user(logged_in_client, other_client):
    logged_in_client.put("/api/preferences", json={"show_compact_button": True, "show_rewind_button": False})
    theirs = other_client.get("/api/preferences").json()
    assert theirs["show_compact_button"] is False and theirs["show_rewind_button"] is True


def test_preferences_saved_before_the_migration_get_the_defaults(tmp_path):
    import shutil
    import sqlite3

    from db.migrate import MIGRATIONS_DIR, apply_migrations

    before = tmp_path / "before"
    before.mkdir()
    for path in sorted(MIGRATIONS_DIR.glob("*.sql")):
        if int(path.name[:4]) <= 17:
            shutil.copy(path, before / path.name)
    db = str(tmp_path / "app.db")
    apply_migrations(db, before)
    with sqlite3.connect(db) as conn:
        conn.execute(
            "INSERT INTO users (user_id, username, password_hash, created_at) VALUES ('u', 'u', 'x', '2026-01-01')"
        )
        conn.execute("INSERT INTO user_preferences (user_id, updated_at) VALUES ('u', '2026-01-01')")
    assert apply_migrations(db) == [18, 19, 20]
    row = sqlite3.connect(db).execute(
        "SELECT show_compact_button, show_rewind_button, api_tour_seen FROM user_preferences"
    ).fetchone()
    assert row == (0, 1, 1)  # accounts that already exist are not shown the first-login tour


def test_api_tour_seen_starts_false_and_can_be_set(logged_in_client):
    assert logged_in_client.get("/api/preferences").json()["api_tour_seen"] is False
    assert logged_in_client.put("/api/preferences", json={"api_tour_seen": True}).json()["api_tour_seen"] is True
    assert logged_in_client.put("/api/preferences", json={"api_tour_seen": None}).status_code == 422


def test_page_popups_default_on_and_can_be_switched_off(logged_in_client):
    assert logged_in_client.get("/api/preferences").json()["show_page_popups"] is True
    assert logged_in_client.put("/api/preferences", json={"show_page_popups": False}).json()["show_page_popups"] is False
    assert logged_in_client.get("/api/preferences").json()["show_page_popups"] is False
    assert logged_in_client.put("/api/preferences", json={"show_page_popups": None}).status_code == 422
