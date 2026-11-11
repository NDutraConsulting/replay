"""Shared FastAPI dependencies. SESSION_COOKIE is the single source of truth for the cookie name."""

from fastapi import Cookie, Depends

from config import Settings, get_settings
from controllers import account_controller
from models.user import User

SESSION_COOKIE = "session_token"


async def get_current_user(
    settings: Settings = Depends(get_settings),
    session_token: str | None = Cookie(default=None, alias=SESSION_COOKIE),
) -> User:
    """Dependency for every route that needs a logged-in user; raises 401 otherwise."""
    return await account_controller.get_current_user(settings, session_token)
