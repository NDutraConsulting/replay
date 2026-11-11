"""Encrypts provider API keys at rest with Fernet. The key comes from ENCRYPTION_KEY."""

from cryptography.fernet import Fernet, InvalidToken

from config import Settings
from errors import AppError


def _fernet(settings: Settings) -> Fernet:
    if not settings.ENCRYPTION_KEY:
        raise AppError(500, "server_misconfigured", "The server has no ENCRYPTION_KEY configured.")
    try:
        return Fernet(settings.ENCRYPTION_KEY.encode())
    except ValueError as exc:
        raise AppError(500, "server_misconfigured", "The server's ENCRYPTION_KEY is not a valid Fernet key.") from exc


def encrypt(settings: Settings, plaintext: str) -> str:
    return _fernet(settings).encrypt(plaintext.encode()).decode()


def decrypt(settings: Settings, token: str) -> str:
    try:
        return _fernet(settings).decrypt(token.encode()).decode()
    except InvalidToken as exc:
        raise AppError(
            500, "server_misconfigured", "Stored credentials cannot be decrypted. Re-enter your API key."
        ) from exc
