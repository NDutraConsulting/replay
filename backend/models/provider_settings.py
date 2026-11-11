from datetime import datetime

from pydantic import BaseModel, Field

MAX_LABEL_LENGTH = 40
MAX_MODELS_PER_API = 50


class ApiConnection(BaseModel):
    """One API an account can call: where it is, how to sign in, and which models it serves."""

    connection_id: str
    user_id: str
    label: str
    """The name the user gives it (unique per account). A model is chosen as "<label>::<model>"."""
    base_url: str
    api_key: str
    """Fernet ciphertext. Decrypt via crypto_service only."""
    models: list[str]
    sort_order: int
    created_at: datetime
    updated_at: datetime


class CreateConnectionRequest(BaseModel):
    label: str = Field(max_length=200)
    url: str = Field(max_length=2000)
    api_key: str = Field(max_length=1000)
    models: list[str] = Field(default_factory=list, max_length=MAX_MODELS_PER_API)
    """Optional here: models can be added afterwards by choosing the API's label."""


class UpdateConnectionRequest(BaseModel):
    """The label never changes (chats refer to models by it). Anything left out stays as it is."""

    url: str | None = Field(default=None, max_length=2000)
    api_key: str | None = Field(default=None, max_length=1000)
    models: list[str] | None = Field(default=None, max_length=MAX_MODELS_PER_API)


class ConnectionView(BaseModel):
    """What the browser may see of a connection. The key itself never leaves the server."""

    connection_id: str
    label: str
    url: str
    models: list[str]
    api_key_set: bool
    connected: bool
    source: str
    """"account" (added on the Account page) or "server" (the OPENAI_API_KEY in .env: read only)."""
    read_only: bool


class SettingsView(BaseModel):
    """Everything the pages need to offer models: each choice is "<label>::<model>" (or a plain demo name)."""

    models: list[str]
    connected: bool
    """True when at least one API can be called. False: demo mode."""
    connections: list[ConnectionView]


class TestConnectionResult(BaseModel):
    __test__ = False  # not a pytest class

    ok: bool
    message: str
