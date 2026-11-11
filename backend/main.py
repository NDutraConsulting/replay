import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from api import (
    routes_account,
    routes_agents,
    routes_chat_records,
    routes_conversations,
    routes_knowledge_base,
    routes_preferences,
    routes_replay,
    routes_settings,
)
from config import Settings, get_settings
from db.connection import init_db
from errors import AppError
from services import seed_service


def _resolve_settings(app: FastAPI) -> Settings:
    """Honors dependency_overrides so tests (which override get_settings) also drive the lifespan."""
    return app.dependency_overrides.get(get_settings, get_settings)()


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = _resolve_settings(app)
    logging.basicConfig(level=settings.LOG_LEVEL.upper())
    init_db(settings.DATABASE_PATH, settings.KNOWLEDGE_DB_PATH, settings.LOG_DB_PATH)
    await seed_service.seed_all(settings)
    yield


app = FastAPI(title="Replay Chat API", lifespan=lifespan)


def _envelope(status_code: int, code: str, message: str, details: dict | None = None) -> JSONResponse:
    error = {"code": code, "message": message}
    if details:
        error["details"] = details
    return JSONResponse(status_code=status_code, content={"error": error})


@app.exception_handler(AppError)
async def app_error_handler(request: Request, exc: AppError):
    return _envelope(exc.status_code, exc.code, exc.message, exc.details)


@app.exception_handler(StarletteHTTPException)
async def http_error_handler(request: Request, exc: StarletteHTTPException):
    code = {404: "not_found", 405: "method_not_allowed"}.get(exc.status_code, "http_error")
    return _envelope(exc.status_code, code, str(exc.detail))


@app.exception_handler(RequestValidationError)
async def validation_error_handler(request: Request, exc: RequestValidationError):
    first = exc.errors()[0] if exc.errors() else {}
    field = ".".join(str(part) for part in first.get("loc", ()) if part not in ("body", "query"))
    detail = first.get("msg", "Invalid request.")
    return _envelope(422, "validation_error", f"{field}: {detail}" if field else detail)


@app.get("/api/health")
async def health():
    return {"status": "ok"}


app.include_router(routes_account.router)
app.include_router(routes_agents.router)
app.include_router(routes_settings.router)
app.include_router(routes_preferences.router)
app.include_router(routes_knowledge_base.router)
app.include_router(routes_conversations.router)
app.include_router(routes_chat_records.router)
app.include_router(routes_replay.router)
