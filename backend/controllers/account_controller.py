import uuid
from datetime import UTC, datetime

from config import Settings
from errors import AppError
from models.user import User
from repositories import session_repository, user_repository
from services import auth_service

DEMO_USERNAME = "demo"


def _new_user(settings: Settings, username: str, password: str) -> User:
    return User(
        user_id=str(uuid.uuid4()),
        username=username,
        password_hash=auth_service.hash_password(password, settings.PASSWORD_HASH_ITERATIONS),
        created_at=datetime.now(UTC),
    )


async def ensure_demo_account(settings: Settings) -> None:
    """Idempotent: creates the demo user (demo / DEMO_PASSWORD) on first boot, and at every start makes sure its password
    is DEMO_PASSWORD, so a database made with an older default still logs in as demo / demo. Its data is never touched."""
    existing = await user_repository.get_by_username(settings.DATABASE_PATH, DEMO_USERNAME)
    if existing is None:
        await user_repository.create(settings.DATABASE_PATH, _new_user(settings, DEMO_USERNAME, settings.DEMO_PASSWORD))
    elif not auth_service.verify_password(settings.DEMO_PASSWORD, existing.password_hash):
        await user_repository.set_password_hash(
            settings.DATABASE_PATH,
            existing.user_id,
            auth_service.hash_password(settings.DEMO_PASSWORD, settings.PASSWORD_HASH_ITERATIONS),
        )


async def signup(settings: Settings, username: str, password: str) -> tuple[User, str]:
    if await user_repository.get_by_username(settings.DATABASE_PATH, username) is not None:
        raise AppError(409, "username_taken", "Username already taken.")
    user = await user_repository.create(settings.DATABASE_PATH, _new_user(settings, username, password))
    return user, await auth_service.create_session(settings, user.user_id)


async def login(settings: Settings, username: str, password: str) -> tuple[User, str]:
    user = await user_repository.get_by_username(settings.DATABASE_PATH, username)
    if user is None or not auth_service.verify_password(password, user.password_hash):
        raise AppError(401, "invalid_credentials", "Invalid username or password.")
    return user, await auth_service.create_session(settings, user.user_id)


async def logout(settings: Settings, session_token: str) -> None:
    await session_repository.delete(settings.DATABASE_PATH, session_token)


async def get_current_user(settings: Settings, session_token: str | None) -> User:
    if session_token is None:
        raise AppError(401, "not_logged_in", "Not logged in.")
    user_id = await auth_service.get_user_id_for_session(settings, session_token)
    user = await user_repository.get_by_id(settings.DATABASE_PATH, user_id) if user_id else None
    if user is None:
        raise AppError(401, "session_expired", "Session expired or invalid.")
    return user
