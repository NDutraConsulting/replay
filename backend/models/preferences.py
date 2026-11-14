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
    show_compact_button: bool = False
    """The Chat page's Compact button is shown only when the user turns it on in Config (off by default)."""
    show_rewind_button: bool = True
    """The Chat page's Rewind button (it enters rewind mode) is shown unless the user turns it off in Config."""
    updated_at: datetime | None = None


class PreferencesView(BaseModel):
    agent_id: str
    model: str | None
    chat_sidebar_hidden: bool
    replay_prompts_hidden: bool
    show_compact_button: bool
    show_rewind_button: bool


class UpdatePreferencesRequest(BaseModel):
    """Every field is optional; only the fields present in the request are changed
    (send "model": null to clear the remembered model)."""

    agent_id: str | None = None
    model: str | None = None
    chat_sidebar_hidden: bool | None = None
    replay_prompts_hidden: bool | None = None
    show_compact_button: bool | None = None
    show_rewind_button: bool | None = None
