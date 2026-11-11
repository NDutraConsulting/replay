import asyncio

import httpx
import pytest
from cryptography.fernet import Fernet
from fastapi.testclient import TestClient

from config import Settings, get_settings
from db.connection import init_db
from services import seed_service


@pytest.fixture
def test_settings(tmp_path) -> Settings:
    return Settings(
        _env_file=None,
        DATABASE_PATH=str(tmp_path / "test.db"),
        KNOWLEDGE_DB_PATH=str(tmp_path / "knowledge-test.db"),
        LOG_DB_PATH=str(tmp_path / "log-test.db"),
        ENCRYPTION_KEY=Fernet.generate_key().decode(),
        OPENAI_API_KEY="",  # a key in the developer's shell or .env must never turn the tests into live calls
        PASSWORD_HASH_ITERATIONS=1000,  # fast hashing in tests
        DEMO_DELAY_SECONDS=0,
        DEMO_PASSWORD="demo-password",
        LLM_TIMEOUT_SECONDS=5,
        KB_ROUTING_ENABLED=False,  # the older tests assert exact model calls; routing tests switch it on (routing_on)
    )


class LLMStub:
    """Stands in for services.llm_service.complete so tests never call a provider.

    reply: str | callable(call_kwargs) -> str      error: Exception to raise
    gate:  asyncio.Event the call waits on (async tests only), to hold a request in flight
    """

    def __init__(self):
        self.calls: list[dict] = []
        self.reply = None
        self.error: Exception | None = None
        self.gate: asyncio.Event | None = None
        self.token_logprobs = None
        """[{token, logprob}] (or a callable taking the call) an answer call returns when it asked for log probabilities."""

    def _record(self, kwargs) -> None:
        """What the real client would have kept for this call, so API-log tests need no network."""
        from services import llm_service

        body = {
            "model": kwargs["model"],
            "messages": [{"role": "system", "content": kwargs["system"]}, *kwargs["messages"]],
        }
        if kwargs.get("reasoning_effort"):
            body["reasoning_effort"] = kwargs["reasoning_effort"]
        if kwargs.get("temperature") is not None:
            body["temperature"] = kwargs["temperature"]
        if kwargs.get("logprobs"):
            body["logprobs"] = True
        llm_service.record_call(
            {
                "at": "2026-01-01T00:00:00+00:00",
                "purpose": kwargs.get("purpose", "answer"),
                "method": "POST",
                "url": llm_service.normalize_url(kwargs["base_url"]),
                "duration_ms": 12,
                "settings": {
                    "temperature": kwargs.get("temperature"),
                    "temperature_sent": kwargs.get("temperature") is not None,
                    "temperature_note": None,
                    "logprobs": bool(kwargs.get("logprobs")),
                    "logprobs_sent": bool(kwargs.get("logprobs")),
                    "logprobs_note": None,
                    "reasoning_effort": kwargs.get("reasoning_effort"),
                },
                "request": {
                    "headers": {"Authorization": "Bearer <redacted>", "Content-Type": "application/json"},
                    "body": body,
                },
                "response": {"status": 200, "body": '{"choices":[{"message":{"content":"stub"}}]}', "truncated": False},
                "error": None,
                **(
                    {"logprobs": self.token_logprobs(kwargs) if callable(self.token_logprobs) else self.token_logprobs}
                    if kwargs.get("logprobs") and kwargs.get("purpose", "answer") == "answer" and self.token_logprobs
                    else {}
                ),
            }
        )

    async def complete(self, **kwargs) -> str:
        self.calls.append(kwargs)
        self._record(kwargs)
        if self.gate is not None:
            await self.gate.wait()
        if self.error is not None:
            raise self.error
        if callable(self.reply):
            return self.reply(kwargs)
        return self.reply if self.reply is not None else f"stub reply from {kwargs['model']}"


@pytest.fixture(autouse=True)
def llm_stub(monkeypatch) -> LLMStub:
    stub = LLMStub()
    monkeypatch.setattr("services.llm_service.complete", stub.complete)
    return stub


@pytest.fixture
def db(test_settings: Settings) -> str:
    init_db(test_settings.DATABASE_PATH, test_settings.KNOWLEDGE_DB_PATH, test_settings.LOG_DB_PATH)
    asyncio.run(seed_service.seed_all(test_settings))
    return test_settings.DATABASE_PATH


@pytest.fixture
def routing_on(test_settings: Settings, monkeypatch) -> Settings:
    """Switch knowledge-base routing on (it is off by default in tests)."""
    monkeypatch.setattr(test_settings, "KB_ROUTING_ENABLED", True)
    return test_settings


@pytest.fixture
def kb_db(test_settings: Settings, db) -> str:
    """Path of the knowledge base database (a separate file from `db`, the app database)."""
    return test_settings.KNOWLEDGE_DB_PATH


@pytest.fixture
def client(test_settings: Settings, db):
    from main import app

    app.dependency_overrides[get_settings] = lambda: test_settings
    with TestClient(app) as test_client:
        yield test_client
    app.dependency_overrides.clear()


@pytest.fixture
def logged_in_client(client):
    response = client.post("/api/account/login", json={"username": "demo", "password": "demo-password"})
    assert response.status_code == 200
    return client


@pytest.fixture
def other_client(client):
    """A second, separately logged-in user (own cookie jar) for ownership tests."""
    from main import app

    other = TestClient(app)
    response = other.post("/api/account/signup", json={"username": "someone-else", "password": "another-password"})
    assert response.status_code == 201
    return other


@pytest.fixture
async def async_client(test_settings: Settings, db):
    """Async client on the test's own event loop, for tests that hold a request in flight (stop/step)."""
    from main import app

    app.dependency_overrides[get_settings] = lambda: test_settings
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.post("/api/account/login", json={"username": "demo", "password": "demo-password"})
        assert response.status_code == 200
        yield client
    app.dependency_overrides.clear()
