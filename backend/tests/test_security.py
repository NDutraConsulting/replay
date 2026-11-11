import logging

import pytest

from main import app

PUBLIC = {
    ("GET", "/api/health"),
    ("POST", "/api/account/signup"),
    ("POST", "/api/account/login"),
    ("POST", "/api/account/logout"),  # logging out without a session is harmless
}


def _routes():
    """Every (METHOD, path) the app serves, read from the OpenAPI schema (stable across FastAPI versions)."""
    for path, item in app.openapi()["paths"].items():
        if path.startswith("/api"):
            for method in item:
                if method in {"get", "post", "put", "patch", "delete"}:
                    yield method.upper(), path


def _fill(path: str) -> str:
    import re

    return re.sub(r"\{[^}]+\}", "x", path)


@pytest.mark.parametrize(("method", "path"), sorted(set(_routes()) - PUBLIC))
def test_every_other_route_requires_a_session(client, method, path):
    response = client.request(method, _fill(path), json={})
    assert response.status_code == 401, f"{method} {path} answered {response.status_code} without a session"
    assert response.json()["error"]["code"] == "not_logged_in"


def test_the_route_enumeration_is_not_silently_empty():
    """Guards the parametrized test above: it must really see the whole API, and PUBLIC must be real routes."""
    routes = set(_routes())
    assert len(routes) >= 30
    assert PUBLIC <= routes
    assert ("POST", "/api/replay-runs/{run_id}/steps") in routes and ("GET", "/api/me") in routes


def test_secrets_never_reach_the_logs(logged_in_client, llm_stub, caplog):
    caplog.set_level(logging.DEBUG)
    made = logged_in_client.post(
        "/api/connections",
        json={"label": "Secret", "url": "https://api.example.com/v1", "api_key": "sk-very-secret", "models": ["m1"]},
    )
    logged_in_client.post(f"/api/connections/{made.json()['connection_id']}/test")
    conversation = logged_in_client.get("/api/conversations/current").json()["conversation_id"]
    logged_in_client.post(
        f"/api/conversations/{conversation}/messages", json={"content": "hi", "model": "m1", "agent_id": "assistant"}
    )
    logged_in_client.post("/api/account/login", json={"username": "demo", "password": "demo-password"})
    logged_in_client.post("/api/account/login", json={"username": "demo", "password": "wrong-password-x"})
    text = caplog.text
    for secret in ("sk-very-secret", "demo-password", "wrong-password-x"):
        assert secret not in text


def test_the_api_key_is_in_no_response_body(logged_in_client):
    made = logged_in_client.post(
        "/api/connections",
        json={"label": "Secret", "url": "https://api.example.com/v1", "api_key": "sk-very-secret", "models": ["m1"]},
    )
    cid = made.json()["connection_id"]
    responses = [
        made,
        logged_in_client.get("/api/settings"),
        logged_in_client.get("/api/connections"),
        logged_in_client.put(f"/api/connections/{cid}", json={"models": ["m1", "m2"]}),
        logged_in_client.post(f"/api/connections/{cid}/test"),
        logged_in_client.get("/api/me"),
        logged_in_client.get("/api/preferences"),
    ]
    assert all("sk-very-secret" not in r.text for r in responses)


@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("POST", "/api/connections"),
        ("POST", "/api/conversations/x/messages"),
        ("POST", "/api/replay-runs"),
        ("PUT", "/api/preferences"),
    ],
)
def test_mutating_routes_do_not_accept_form_or_plain_text_bodies(logged_in_client, method, path):
    """A cross-site HTML form can only send form/plain-text bodies; JSON routes must refuse them."""
    for content_type, body in (("text/plain", '{"models": ["m"]}'), ("application/x-www-form-urlencoded", "models=m")):
        response = logged_in_client.request(method, path, content=body, headers={"Content-Type": content_type})
        assert response.status_code == 422


def test_no_cors_headers_are_sent(logged_in_client):
    response = logged_in_client.get("/api/health", headers={"Origin": "https://evil.example"})
    assert "access-control-allow-origin" not in {k.lower() for k in response.headers}


def test_the_session_token_is_new_on_every_login(client):
    tokens = set()
    for _ in range(2):
        response = client.post("/api/account/login", json={"username": "demo", "password": "demo-password"})
        tokens.add(response.cookies.get("session_token"))
    assert len(tokens) == 2 and None not in tokens
