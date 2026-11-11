"""One exception type for every expected failure. main.py turns it (and framework errors) into the
{"error": {"code", "message"}} envelope the frontend shows to the user."""


class AppError(Exception):
    def __init__(self, status_code: int, code: str, message: str, details: dict | None = None):
        super().__init__(message)
        self.status_code = status_code
        self.code = code
        self.message = message
        self.details = details
        """Optional machine-readable facts for the client (for example counts), returned beside the message."""


def not_found(what: str) -> AppError:
    return AppError(404, "not_found", f"{what} not found.")


def validation_error(message: str) -> AppError:
    return AppError(422, "validation_error", message)


def conflict(code: str, message: str) -> AppError:
    return AppError(409, code, message)
