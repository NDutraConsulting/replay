"""Password hashing (stdlib PBKDF2-HMAC-SHA256) and session tokens."""

import hashlib
import hmac
import secrets
from datetime import UTC, datetime, timedelta

from config import Settings
from repositories import session_repository

_SCHEME = "pbkdf2_sha256"


def hash_password(password: str, iterations: int) -> str:
    """Stored as scheme$iterations$salt$digest so the cost can be raised later without breaking old hashes."""
    salt = secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt), iterations).hex()
    return f"{_SCHEME}${iterations}${salt}${digest}"


def verify_password(password: str, stored: str) -> bool:
    try:
        scheme, iterations, salt, digest = stored.split("$")
        if scheme != _SCHEME:
            return False
        candidate = hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt), int(iterations)).hex()
    except ValueError:
        return False
    return hmac.compare_digest(candidate, digest)


async def create_session(settings: Settings, user_id: str) -> str:
    token = secrets.token_urlsafe(32)
    await session_repository.create(settings.DATABASE_PATH, token, user_id, datetime.now(UTC))
    return token


async def get_user_id_for_session(settings: Settings, token: str) -> str | None:
    """None when the token is unknown or older than SESSION_MAX_AGE_DAYS (expired sessions are deleted)."""
    found = await session_repository.get(settings.DATABASE_PATH, token)
    if found is None:
        return None
    user_id, created_at = found
    if datetime.now(UTC) - created_at > timedelta(days=settings.SESSION_MAX_AGE_DAYS):
        await session_repository.delete(settings.DATABASE_PATH, token)
        return None
    return user_id
