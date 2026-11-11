from datetime import datetime

from pydantic import BaseModel


class UserPreferences(BaseModel):
    user_id: str
    agent_id: str = "assistant"
    model: str | None = None
    chat_sidebar_hidden: bool = True
    """The chat page's \"This conversation\" sidebar starts closed."""
    replay_prompts_hidden: bool = True
    """The replay "Your prompts" panel starts closed."""
    updated_at: datetime | None = None


class PreferencesView(BaseModel):
    agent_id: str
    model: str | None
    chat_sidebar_hidden: bool
    replay_prompts_hidden: bool


class UpdatePreferencesRequest(BaseModel):
    """Every field is optional; only the fields present in the request are changed
    (send "model": null to clear the remembered model)."""

    agent_id: str | None = None
    model: str | None = None
    chat_sidebar_hidden: bool | None = None
    replay_prompts_hidden: bool | None = None
