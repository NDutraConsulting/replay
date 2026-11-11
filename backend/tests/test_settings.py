"""API connections: an account's several APIs (label, URL, key, models) and how a chosen model finds its API."""

import json
import shutil
import sqlite3

import pytest

from db.migrate import MIGRATIONS_DIR, apply_migrations
from services.llm_service import LLMError
from services.settings_service import SERVER_ROUTE_LABEL


def add(client, label="Local", url="https://api.example.com/v1", api_key="sk-secret", models=("m1", "m2"), **extra):
    return client.post(
        "/api/connections", json={"label": label, "url": url, "api_key": api_key, "models": list(models), **extra}
    )


def made(client, **kwargs):
    response = add(client, **kwargs)
    assert response.status_code == 201, response.text
    return response.json()


def settings_of(client):
    return client.get("/api/settings").json()


# ---- the list and the aggregate
def test_with_no_api_the_account_is_in_demo_mode_with_the_demo_models(logged_in_client):
    assert settings_of(logged_in_client) == {
        "models": ["model-a", "model-b", "model-c"], "connected": False, "connections": [],
    }  # fmt: skip
    assert logged_in_client.get("/api/connections").json() == []


def test_everything_needs_login(client):
    assert client.get("/api/settings").status_code == 401
    assert client.get("/api/connections").status_code == 401
    assert (
        client.post("/api/connections", json={"label": "x", "url": "https://a.test", "api_key": "k"}).status_code == 401
    )
    assert client.put("/api/connections/x", json={"models": ["m"]}).status_code == 401
    assert client.delete("/api/connections/x").status_code == 401
    assert client.post("/api/connections/x/test").status_code == 401


# ---- add
def test_adding_an_api_never_returns_the_key(logged_in_client):
    response = add(logged_in_client, label="  Fast   GPU ", models=[" m1 ", "m2", "m1", ""])
    assert response.status_code == 201
    body = response.json()
    assert body["label"] == "Fast GPU"  # trimmed, inner spaces collapsed
    assert body["url"] == "https://api.example.com/v1" and body["models"] == ["m1", "m2"]
    assert body["api_key_set"] is True and body["connected"] is True
    assert body["source"] == "account" and body["read_only"] is False and body["connection_id"]
    assert "sk-secret" not in response.text
    for r in (logged_in_client.get("/api/connections"), logged_in_client.get("/api/settings")):
        assert "sk-secret" not in r.text


def test_the_key_is_encrypted_at_rest(logged_in_client, db):
    add(logged_in_client)
    stored = sqlite3.connect(db).execute("SELECT api_key FROM api_connections").fetchone()[0]
    assert stored and stored != "sk-secret" and "sk-secret" not in stored


def test_an_api_can_be_added_without_models_and_models_added_later(logged_in_client):
    body = made(logged_in_client, models=())
    assert body["models"] == []
    assert settings_of(logged_in_client)["models"] == []  # an API with no models offers nothing yet
    updated = logged_in_client.put(f"/api/connections/{body['connection_id']}", json={"models": ["m1", "m2"]}).json()
    assert updated["models"] == ["m1", "m2"]
    assert settings_of(logged_in_client)["models"] == ["Local::m1", "Local::m2"]


@pytest.mark.parametrize(
    ("body", "message"),
    [
        ({"label": "  ", "url": "https://a.test/v1", "api_key": "k"}, "Give the API a label."),
        ({"label": "x" * 41, "url": "https://a.test/v1", "api_key": "k"}, "at most 40 characters"),
        ({"label": "a::b", "url": "https://a.test/v1", "api_key": "k"}, 'cannot contain "::"'),
        ({"label": "ok", "url": "ftp://a.test", "api_key": "k"}, "valid HTTP or HTTPS API URL"),
        ({"label": "ok", "url": "nonsense", "api_key": "k"}, "valid HTTP or HTTPS API URL"),
        ({"label": "ok", "url": "https://a.test/v1", "api_key": "   "}, "Add the API key"),
        ({"label": SERVER_ROUTE_LABEL, "url": "https://a.test/v1", "api_key": "k"}, "already have an API labelled"),
    ],
)
def test_adding_validates(logged_in_client, body, message):
    response = logged_in_client.post("/api/connections", json=body)
    assert response.status_code == 422
    assert message in response.json()["error"]["message"]


def test_the_label_must_be_unique_for_the_account_ignoring_case(logged_in_client, other_client):
    made(logged_in_client, label="Fast")
    again = add(logged_in_client, label="fast")
    assert again.status_code == 422 and 'already have an API labelled "fast"' in again.json()["error"]["message"]
    assert add(other_client, label="Fast").status_code == 201  # another account may use it


def test_the_request_shape_is_checked(logged_in_client):
    assert logged_in_client.post("/api/connections", json={"label": "x"}).status_code == 422
    assert add(logged_in_client, label="many", models=[f"m{i}" for i in range(51)]).status_code == 422


# ---- several APIs: the model choices
def test_every_model_is_offered_as_label_and_model_in_the_order_the_apis_were_added(logged_in_client):
    made(logged_in_client, label="H100", models=("llama", "mixtral"))
    made(logged_in_client, label="A100", url="https://other.example.com/v1", models=("llama",))
    body = settings_of(logged_in_client)
    assert body["models"] == [
        "H100::llama",
        "H100::mixtral",
        "A100::llama",
    ]  # the same model on two APIs is two choices
    assert body["connected"] is True
    assert [c["label"] for c in body["connections"]] == ["H100", "A100"]


def test_a_conversation_calls_the_api_that_serves_its_model(logged_in_client, llm_stub):
    made(logged_in_client, label="H100", url="https://h100.example.com/v1", api_key="sk-h100", models=("llama",))
    made(logged_in_client, label="A100", url="https://a100.example.com/v1", api_key="sk-a100", models=("llama",))
    for label, host, key in (("H100", "h100", "sk-h100"), ("A100", "a100", "sk-a100")):
        cid = logged_in_client.post(
            "/api/conversations", json={"name": label, "agent_id": "assistant", "model": f"{label}::llama"}
        ).json()["conversation_id"]
        assert logged_in_client.post(f"/api/conversations/{cid}/messages", json={"content": "hi"}).status_code == 200
        answer = llm_stub.calls[-1]
        assert answer["base_url"] == f"https://{host}.example.com/v1" and answer["api_key"] == key
        assert answer["model"] == "llama"  # the provider is sent the plain model name


def test_a_replays_two_slots_can_run_on_two_different_apis(logged_in_client, llm_stub):
    made(logged_in_client, label="H100", url="https://h100.example.com/v1", api_key="sk-h100", models=("llama",))
    made(logged_in_client, label="A100", url="https://a100.example.com/v1", api_key="sk-a100", models=("llama",))
    run = logged_in_client.post(
        "/api/replay-runs", json={"prompts": ["hello"], "model_a": "H100::llama", "model_b": "A100::llama"}
    ).json()
    assert (run["model_a"], run["model_b"]) == ("H100::llama", "A100::llama")
    step = logged_in_client.post(f"/api/replay-runs/{run['replay_run_id']}/steps", json={"expected_cursor": 0})
    assert step.status_code == 200
    by_host = {c["base_url"]: c for c in llm_stub.calls}
    assert by_host["https://h100.example.com/v1"]["api_key"] == "sk-h100"
    assert by_host["https://a100.example.com/v1"]["api_key"] == "sk-a100"
    assert {c["model"] for c in llm_stub.calls} == {"llama"}
    assert step.json()["results"]["a"][0]["model"] == "H100::llama"  # each result keeps which API it came from
    assert step.json()["results"]["b"][0]["model"] == "A100::llama"


def test_a_plain_model_name_finds_the_first_api_that_lists_it(logged_in_client, llm_stub):
    made(logged_in_client, label="First", url="https://first.example.com/v1", models=("shared",))
    made(logged_in_client, label="Second", url="https://second.example.com/v1", models=("shared", "only-here"))
    cid = logged_in_client.post(
        "/api/conversations", json={"name": "old", "agent_id": "assistant", "model": "shared"}
    ).json()["conversation_id"]
    logged_in_client.post(f"/api/conversations/{cid}/messages", json={"content": "hi"})
    assert llm_stub.calls[-1]["base_url"] == "https://first.example.com/v1"
    cid2 = logged_in_client.post(
        "/api/conversations", json={"name": "other", "agent_id": "assistant", "model": "only-here"}
    ).json()["conversation_id"]
    logged_in_client.post(f"/api/conversations/{cid2}/messages", json={"content": "hi"})
    assert llm_stub.calls[-1]["base_url"] == "https://second.example.com/v1"


def test_a_model_no_api_lists_is_refused(logged_in_client):
    made(logged_in_client, label="H100", models=("llama",))
    for model in ("H100::nope", "Nowhere::llama", "nope", "model-a"):
        r = logged_in_client.post("/api/conversations", json={"name": "x", "agent_id": "assistant", "model": model})
        assert r.status_code == 422, model
        assert f"Unknown model: {model}." in r.json()["error"]["message"]


def test_a_conversation_whose_api_was_deleted_says_so_instead_of_sending_a_demo_reply(logged_in_client):
    connection = made(logged_in_client, label="Gone", models=("m1",))
    cid = logged_in_client.post(
        "/api/conversations", json={"name": "x", "agent_id": "assistant", "model": "Gone::m1"}
    ).json()["conversation_id"]
    assert logged_in_client.delete(f"/api/connections/{connection['connection_id']}").status_code == 204
    r = logged_in_client.post(f"/api/conversations/{cid}/messages", json={"content": "hi"})
    assert r.status_code == 422
    assert 'The API "Gone" no longer exists' in r.json()["error"]["message"]


def test_demo_mode_keeps_working_with_the_demo_models(logged_in_client):
    cid = logged_in_client.post(
        "/api/conversations", json={"name": "d", "agent_id": "assistant", "model": "model-b"}
    ).json()["conversation_id"]
    reply = logged_in_client.post(f"/api/conversations/{cid}/messages", json={"content": "hi"}).json()["messages"][1]
    assert reply["demo"] is True and reply["content"].startswith("Demo · model-b")


# ---- change and delete
def test_changing_the_models_keeps_the_key_and_the_url(logged_in_client, llm_stub):
    c = made(logged_in_client, label="Keep", models=("m1",))
    updated = logged_in_client.put(f"/api/connections/{c['connection_id']}", json={"models": ["m1", "m2"]})
    assert updated.status_code == 200 and updated.json()["models"] == ["m1", "m2"]
    assert updated.json()["url"] == "https://api.example.com/v1" and updated.json()["api_key_set"] is True
    logged_in_client.post(f"/api/connections/{c['connection_id']}/test")
    assert llm_stub.calls[-1]["api_key"] == "sk-secret"  # still the saved key


def test_the_url_and_the_key_can_be_replaced_but_not_the_label(logged_in_client, llm_stub):
    c = made(logged_in_client, label="Fixed")
    body = logged_in_client.put(
        f"/api/connections/{c['connection_id']}",
        json={"url": "https://new.example.com/v1", "api_key": "sk-new", "label": "Renamed"},
    ).json()
    assert body["label"] == "Fixed" and body["url"] == "https://new.example.com/v1"
    logged_in_client.post(f"/api/connections/{c['connection_id']}/test")
    assert llm_stub.calls[-1]["api_key"] == "sk-new" and llm_stub.calls[-1]["base_url"] == "https://new.example.com/v1"


@pytest.mark.parametrize(
    ("body", "message"),
    [({"url": "ftp://x"}, "valid HTTP or HTTPS API URL"), ({"api_key": " "}, "needs a key")],
)
def test_changing_validates(logged_in_client, body, message):
    c = made(logged_in_client)
    r = logged_in_client.put(f"/api/connections/{c['connection_id']}", json=body)
    assert r.status_code == 422 and message in r.json()["error"]["message"]


def test_deleting_removes_the_api_and_its_models(logged_in_client):
    a = made(logged_in_client, label="A", models=("a1",))
    made(logged_in_client, label="B", models=("b1",))
    assert logged_in_client.delete(f"/api/connections/{a['connection_id']}").status_code == 204
    assert settings_of(logged_in_client)["models"] == ["B::b1"]
    assert logged_in_client.delete(f"/api/connections/{a['connection_id']}").status_code == 404


def test_deleting_the_last_api_goes_back_to_demo_mode(logged_in_client):
    c = made(logged_in_client)
    logged_in_client.delete(f"/api/connections/{c['connection_id']}")
    assert settings_of(logged_in_client)["connected"] is False
    assert settings_of(logged_in_client)["models"] == ["model-a", "model-b", "model-c"]


def test_apis_are_per_account(logged_in_client, other_client):
    c = made(logged_in_client, label="Mine")
    assert other_client.get("/api/connections").json() == []
    assert other_client.get("/api/settings").json()["models"] == ["model-a", "model-b", "model-c"]
    for r in (
        other_client.put(f"/api/connections/{c['connection_id']}", json={"models": ["x"]}),
        other_client.delete(f"/api/connections/{c['connection_id']}"),
        other_client.post(f"/api/connections/{c['connection_id']}/test"),
    ):
        assert r.status_code == 404


def test_the_ssrf_guard_applies_when_enabled(logged_in_client, test_settings, monkeypatch):
    monkeypatch.setattr(test_settings, "BLOCK_PRIVATE_LLM_URLS", True)
    r = add(logged_in_client, url="http://127.0.0.1:9/v1")
    assert r.status_code == 422 and r.json()["error"]["code"] == "api_url_not_allowed"
    monkeypatch.setattr(test_settings, "BLOCK_PRIVATE_LLM_URLS", False)
    c = made(logged_in_client)
    monkeypatch.setattr(test_settings, "BLOCK_PRIVATE_LLM_URLS", True)
    r = logged_in_client.put(f"/api/connections/{c['connection_id']}", json={"url": "http://127.0.0.1:9/v1"})
    assert r.status_code == 422 and r.json()["error"]["code"] == "api_url_not_allowed"


# ---- test connection
def test_testing_uses_the_first_model_the_decrypted_key_and_that_apis_url(logged_in_client, llm_stub):
    c = made(logged_in_client, models=("first", "second"))
    body = logged_in_client.post(f"/api/connections/{c['connection_id']}/test").json()
    assert body == {"ok": True, "message": "Connection verified. Your API returned a response."}
    call = llm_stub.calls[0]
    assert (
        call["model"] == "first" and call["api_key"] == "sk-secret" and call["base_url"] == "https://api.example.com/v1"
    )


def test_testing_an_api_with_no_models_says_to_add_one(logged_in_client, llm_stub):
    c = made(logged_in_client, models=())
    body = logged_in_client.post(f"/api/connections/{c['connection_id']}/test").json()
    assert body == {"ok": False, "message": "Add a model to this API before testing it."}
    assert llm_stub.calls == []


def test_test_failures_are_reported_not_raised(logged_in_client, llm_stub):
    c = made(logged_in_client)
    llm_stub.error = LLMError(
        502, "llm_http_error", "API returned HTTP 401. Check your key, model ID, and endpoint in Account."
    )
    body = logged_in_client.post(f"/api/connections/{c['connection_id']}/test").json()
    assert body["ok"] is False and "HTTP 401" in body["message"]
    llm_stub.error = LLMError(504, "llm_timeout", "Your API did not respond in time.")
    assert (
        "timed out after 5 seconds"
        in logged_in_client.post(f"/api/connections/{c['connection_id']}/test").json()["message"]
    )


# ---- the server's own API (OPENAI_API_KEY in .env)
@pytest.fixture
def server_key(test_settings, monkeypatch):
    monkeypatch.setattr(test_settings, "OPENAI_API_KEY", "sk-from-env")
    return test_settings


def test_the_server_key_is_a_read_only_api_listed_after_the_accounts_own(logged_in_client, server_key):
    made(logged_in_client, label="Mine", models=("m1",))
    body = settings_of(logged_in_client)
    assert body["models"][0] == "Mine::m1" and body["models"][1].startswith(f"{SERVER_ROUTE_LABEL}::")
    server = body["connections"][-1]
    assert server["label"] == SERVER_ROUTE_LABEL and server["source"] == "server" and server["read_only"] is True
    assert server["connection_id"] == "server" and server["url"] == "https://api.openai.com/v1"
    assert server["api_key_set"] is True and "sk-from-env" not in json.dumps(body)


def test_the_server_api_cannot_be_edited_or_deleted_but_can_be_tested(logged_in_client, server_key, llm_stub):
    assert logged_in_client.put("/api/connections/server", json={"models": ["x"]}).status_code == 422
    assert logged_in_client.delete("/api/connections/server").status_code == 422
    body = logged_in_client.post("/api/connections/server/test").json()
    assert body["ok"] is True
    assert (
        llm_stub.calls[0]["api_key"] == "sk-from-env" and llm_stub.calls[0]["base_url"] == "https://api.openai.com/v1"
    )


def test_without_a_server_key_there_is_no_server_api(logged_in_client, test_settings):
    assert test_settings.OPENAI_API_KEY == ""
    assert settings_of(logged_in_client)["connections"] == []
    assert logged_in_client.post("/api/connections/server/test").status_code == 404


def test_a_chat_on_a_server_model_calls_the_server_api(logged_in_client, server_key, llm_stub):
    model = settings_of(logged_in_client)["models"][0]
    cid = logged_in_client.post(
        "/api/conversations", json={"name": "s", "agent_id": "assistant", "model": model}
    ).json()["conversation_id"]
    assert logged_in_client.post(f"/api/conversations/{cid}/messages", json={"content": "hi"}).status_code == 200
    assert llm_stub.calls[-1]["api_key"] == "sk-from-env"
    assert model == f"{SERVER_ROUTE_LABEL}::{llm_stub.calls[-1]['model']}"


def test_env_url_and_models_can_be_changed(logged_in_client, server_key, monkeypatch):
    monkeypatch.setattr(server_key, "OPENAI_BASE_URL", "https://proxy.example.com/v1")
    monkeypatch.setattr(server_key, "OPENAI_MODELS", " one , two ,, one")
    server = settings_of(logged_in_client)["connections"][-1]
    assert server["url"] == "https://proxy.example.com/v1" and server["models"] == ["one", "two"]


# ---- accounts that had a single API before there were several
def test_the_old_single_connection_becomes_an_api_labelled_default(tmp_path):
    old = tmp_path / "old-migrations"
    old.mkdir()
    for path in MIGRATIONS_DIR.glob("*.sql"):
        if int(path.name[:4]) < 14:
            shutil.copy(path, old / path.name)
    db = str(tmp_path / "legacy.db")
    apply_migrations(db, old)
    conn = sqlite3.connect(db)
    conn.execute("PRAGMA foreign_keys = OFF")
    for uid, url, key in (
        ("u-complete", "https://x.test/v1", "cipher"),
        ("u-demo", "", ""),
        ("u-nokey", "https://y.test/v1", ""),
    ):
        conn.execute(
            "INSERT INTO provider_settings (user_id, base_url, api_key, models_json, updated_at) VALUES (?, ?, ?, ?, ?)",
            (uid, url, key, json.dumps(["m1", "m2"]), "2026-01-01T00:00:00+00:00"),
        )
    conn.commit()
    conn.close()
    assert apply_migrations(db) == [n for n in range(14, 14 + len(list(MIGRATIONS_DIR.glob("*.sql"))) - 13)]
    rows = (
        sqlite3.connect(db)
        .execute("SELECT user_id, label, base_url, api_key, models_json FROM api_connections")
        .fetchall()
    )
    assert rows == [
        ("u-complete", "Default", "https://x.test/v1", "cipher", '["m1", "m2"]')
    ]  # only a complete one carries over


# ---- APIs on your own machine or network need no key
@pytest.mark.parametrize(
    "url",
    [
        "http://localhost:11434/v1",
        "http://LOCALHOST:1234/v1",
        "http://127.0.0.1:8000/v1",
        "http://[::1]:8000/v1",
        "http://192.168.1.20:8080/v1",
        "http://10.0.0.5/v1",
        "http://172.16.4.2:9000/v1",
        "http://gpu-box.local:8000/v1",
        "http://ollama.localhost/v1",
        "http://169.254.1.1/v1",
    ],
)
def test_a_local_api_can_be_added_without_a_key(logged_in_client, url):
    response = add(logged_in_client, label="Local host", url=url, api_key="", models=("llama3",))
    assert response.status_code == 201, response.text
    body = response.json()
    assert body["api_key_set"] is False and body["connected"] is True  # usable, with no key to send
    assert settings_of(logged_in_client)["connected"] is True
    assert settings_of(logged_in_client)["models"] == ["Local host::llama3"]


@pytest.mark.parametrize(
    "url",
    [
        "https://api.openai.com/v1",
        "http://api.example.com/v1",
        "https://8.8.8.8/v1",
        "http://localhost.example.com/v1",
        "http://notlocal/v1",
    ],
)
def test_a_hosted_api_still_needs_a_key(logged_in_client, url):
    response = add(logged_in_client, label="Hosted", url=url, api_key="  ")
    assert response.status_code == 422
    assert (
        "Add the API key" in response.json()["error"]["message"]
        and "your own machine" in response.json()["error"]["message"]
    )


def test_a_keyless_local_api_answers_chats_without_sending_a_key(logged_in_client, llm_stub):
    made(logged_in_client, label="Ollama", url="http://localhost:11434/v1", api_key="", models=("llama3",))
    cid = logged_in_client.post(
        "/api/conversations", json={"name": "local", "agent_id": "assistant", "model": "Ollama::llama3"}
    ).json()["conversation_id"]
    reply = logged_in_client.post(f"/api/conversations/{cid}/messages", json={"content": "hi"}).json()["messages"][1]
    assert reply["demo"] is False  # a real call, not a demo reply
    assert llm_stub.calls[-1]["base_url"] == "http://localhost:11434/v1" and llm_stub.calls[-1]["api_key"] == ""
    assert llm_stub.calls[-1]["model"] == "llama3"


def test_a_keyless_api_can_be_tested(logged_in_client, llm_stub):
    c = made(logged_in_client, label="Ollama", url="http://localhost:11434/v1", api_key="", models=("llama3",))
    assert logged_in_client.post(f"/api/connections/{c['connection_id']}/test").json()["ok"] is True
    assert llm_stub.calls[0]["api_key"] == ""


def test_the_key_can_be_removed_from_a_local_api_but_not_from_a_hosted_one(logged_in_client):
    local = made(logged_in_client, label="Local", url="http://localhost:11434/v1", api_key="sk-x")
    updated = logged_in_client.put(f"/api/connections/{local['connection_id']}", json={"api_key": ""})
    assert updated.status_code == 200 and updated.json()["api_key_set"] is False
    hosted = made(logged_in_client, label="Hosted")
    refused = logged_in_client.put(f"/api/connections/{hosted['connection_id']}", json={"api_key": ""})
    assert refused.status_code == 422 and "needs a key" in refused.json()["error"]["message"]


def test_moving_a_keyless_api_to_a_hosted_url_needs_a_key(logged_in_client):
    c = made(logged_in_client, label="Local", url="http://localhost:11434/v1", api_key="")
    refused = logged_in_client.put(f"/api/connections/{c['connection_id']}", json={"url": "https://api.openai.com/v1"})
    assert refused.status_code == 422
    ok = logged_in_client.put(
        f"/api/connections/{c['connection_id']}", json={"url": "https://api.openai.com/v1", "api_key": "sk-new"}
    )
    assert ok.status_code == 200 and ok.json()["api_key_set"] is True
    back = logged_in_client.put(
        f"/api/connections/{c['connection_id']}", json={"url": "http://localhost:1234/v1", "api_key": ""}
    )
    assert back.status_code == 200 and back.json()["api_key_set"] is False


def test_a_keyless_api_is_refused_when_the_server_blocks_private_addresses(
    logged_in_client, test_settings, monkeypatch
):
    monkeypatch.setattr(test_settings, "BLOCK_PRIVATE_LLM_URLS", True)
    r = add(logged_in_client, url="http://localhost:11434/v1", api_key="")
    assert r.status_code == 422 and r.json()["error"]["code"] == "api_url_not_allowed"
