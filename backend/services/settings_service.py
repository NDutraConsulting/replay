"""API connections (label, URL, key, models), user preferences and the agents list."""

from dataclasses import dataclass
from urllib.parse import urlsplit

from config import Settings
from errors import not_found, validation_error
from models.agent import Agent, AgentView
from models.preferences import PreferencesView, UpdatePreferencesRequest, UserPreferences
from models.provider_settings import (
    MAX_LABEL_LENGTH,
    ConnectionView,
    CreateConnectionRequest,
    SettingsView,
    TestConnectionResult,
    UpdateConnectionRequest,
)
from models.user import User
from repositories import agent_repository, api_connection_repository, preferences_repository
from services import crypto_service, llm_service

DEFAULT_MODELS = ["model-a", "model-b", "model-c"]
"""The demo models, offered while an account has no API at all."""

SERVER_ROUTE_LABEL = "OpenAI (server key)"
"""The label of the API made by OPENAI_API_KEY in .env. It is read only, and an account cannot use this label."""

REF_SEPARATOR = "::"
"""A model is chosen as "<API label>::<model>", so the same model name on two APIs is two different choices."""


@dataclass
class Route:
    """An API an account can call, with its key decrypted. Server-side use only."""

    label: str
    base_url: str
    api_key: str
    models: list[str]
    connection_id: str | None
    """None for the server's own API."""
    source: str
    """"account" or "server"."""


@dataclass
class Provider:
    """What one model call needs. Server-side use only.

    `models` is every choice the account has (as "<label>::<model>"); `model` is the plain name to send to this API, and
    `label` says which API it is. Without a model (`get_provider(settings, user)`) it only lists the choices."""

    base_url: str
    api_key: str
    models: list[str]
    model: str = ""
    label: str = ""

    @property
    def connected(self) -> bool:
        return bool(self.base_url)  # a hosted API always has a key; a local one (Ollama, LM Studio, ...) may have none


def make_ref(label: str, model: str) -> str:
    return f"{label}{REF_SEPARATOR}{model}"


def split_ref(ref: str) -> tuple[str | None, str]:
    """("<label>", "<model>") for a "<label>::<model>" choice; (None, ref) for a plain name (a demo model, or a chat made
    before accounts had several APIs)."""
    label, separator, model = ref.partition(REF_SEPARATOR)
    return (label, model) if separator and label and model else (None, ref)


def clean_models(models: list[str]) -> list[str]:
    """Strip, drop blanks, dedupe preserving order."""
    seen: dict[str, None] = {}
    for model in models:
        model = model.strip()
        if model:
            seen.setdefault(model[:200], None)
    return list(seen)


def _server_route(settings: Settings) -> Route | None:
    """The API made by OPENAI_API_KEY (and OPENAI_BASE_URL, OPENAI_MODELS) in .env, if one is set."""
    key = settings.OPENAI_API_KEY.strip()
    if not key:
        return None
    return Route(
        label=SERVER_ROUTE_LABEL,
        base_url=settings.OPENAI_BASE_URL.strip(),
        api_key=key,
        models=clean_models(settings.OPENAI_MODELS.split(",")),
        connection_id=None,
        source="server",
    )


async def list_routes(settings: Settings, user: User) -> list[Route]:
    """Every API the account can call: the ones it added, then the server's own when .env has a key."""
    rows = await api_connection_repository.list_for_user(settings.DATABASE_PATH, user.user_id)
    routes = [
        Route(
            label=row.label,
            base_url=row.base_url,
            api_key=crypto_service.decrypt(settings, row.api_key) if row.api_key else "",
            models=list(row.models),
            connection_id=row.connection_id,
            source="account",
        )
        for row in rows
    ]
    server = _server_route(settings)
    return [*routes, server] if server else routes


def model_refs(routes: list[Route]) -> list[str]:
    """Every model choice, "<label>::<model>", in the order the APIs were added. Demo names when there is no API."""
    refs = [make_ref(route.label, model) for route in routes for model in route.models]
    return refs if routes else list(DEFAULT_MODELS)


def model_known(refs: list[str], ref: str) -> bool:
    """Whether `ref` is one of `refs`, or a plain name that one of them has (a chat made before there were several APIs)."""
    return ref in refs or any(split_ref(r)[1] == ref for r in refs if split_ref(r)[0] is not None)


async def available_models(settings: Settings, user: User) -> list[str]:
    return model_refs(await list_routes(settings, user))


async def require_model(settings: Settings, user: User, ref: str) -> None:
    if not model_known(await available_models(settings, user), ref):
        raise validation_error(f"Unknown model: {ref}.")


def _find(routes: list[Route], ref: str) -> tuple[Route | None, str]:
    label, model = split_ref(ref)
    if label is not None:
        route = next((r for r in routes if r.label.lower() == label.lower()), None)
        if route is None:
            raise validation_error(
                f'The API "{label}" no longer exists. Start a new conversation with a model from an API you have.'
            )
        return route, model
    # a plain name: the first API that lists it, else none (a demo model)
    return next((r for r in routes if model in r.models), None), model


async def get_provider(settings: Settings, user: User, model: str | None = None) -> Provider:
    """What a model call needs. Give the chosen model ("<label>::<model>", or a plain name) to get the API that serves it
    (an unconnected provider, so a demo reply, when no API does). Without one: just the list of choices."""
    routes = await list_routes(settings, user)
    refs = model_refs(routes)
    if model is None:
        return Provider(base_url="", api_key="", models=refs)
    route, bare = _find(routes, model)
    if route is None:
        return Provider(base_url="", api_key="", models=refs, model=bare)
    return Provider(base_url=route.base_url, api_key=route.api_key, models=refs, model=bare, label=route.label)


def _connection_view(route: Route) -> ConnectionView:
    return ConnectionView(
        connection_id=route.connection_id or "server",
        label=route.label,
        url=route.base_url,
        models=list(route.models),
        api_key_set=bool(route.api_key),
        connected=bool(route.base_url),
        source=route.source,
        read_only=route.source == "server",
    )


async def get_view(settings: Settings, user: User) -> SettingsView:
    routes = await list_routes(settings, user)
    return SettingsView(
        models=model_refs(routes),
        connected=any(r.base_url for r in routes),
        connections=[_connection_view(r) for r in routes],
    )


def _check_url(settings: Settings, raw: str) -> str:
    url = raw.strip()
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise validation_error("Enter a valid HTTP or HTTPS API URL.")
    if settings.BLOCK_PRIVATE_LLM_URLS:
        llm_service.check_host_allowed(llm_service.normalize_url(url))
    return url


async def _label(settings: Settings, user: User, raw: str) -> str:
    label = " ".join(raw.split())
    if not label:
        raise validation_error("Give the API a label.")
    if len(label) > MAX_LABEL_LENGTH:
        raise validation_error(f"The label can be at most {MAX_LABEL_LENGTH} characters.")
    if REF_SEPARATOR in label:
        raise validation_error(f'The label cannot contain "{REF_SEPARATOR}".')
    if label.lower() == SERVER_ROUTE_LABEL.lower() or await api_connection_repository.label_taken(
        settings.DATABASE_PATH, user.user_id, label
    ):
        raise validation_error(f'You already have an API labelled "{label}".')
    return label


async def create_connection(settings: Settings, user: User, request: CreateConnectionRequest) -> ConnectionView:
    label = await _label(settings, user, request.label)
    url = _check_url(settings, request.url)
    key = request.api_key.strip()
    if not key and not llm_service.is_local_url(url):
        raise validation_error(
            "Add the API key for this API. (Only an API on your own machine or network can go without one.)"
        )
    row = await api_connection_repository.create(
        settings.DATABASE_PATH,
        user.user_id,
        label,
        url,
        crypto_service.encrypt(settings, key) if key else "",
        clean_models(request.models),
    )
    return _connection_view(_route_of(settings, row))


def _route_of(settings: Settings, row) -> Route:
    return Route(
        label=row.label,
        base_url=row.base_url,
        api_key=crypto_service.decrypt(settings, row.api_key) if row.api_key else "",
        models=list(row.models),
        connection_id=row.connection_id,
        source="account",
    )


async def _owned_connection(settings: Settings, user: User, connection_id: str):
    row = await api_connection_repository.get(settings.DATABASE_PATH, user.user_id, connection_id)
    if row is None:
        raise not_found("API")
    return row


async def update_connection(
    settings: Settings, user: User, connection_id: str, request: UpdateConnectionRequest
) -> ConnectionView:
    if connection_id == "server":
        raise validation_error("The server's own API is set in .env and cannot be edited here.")
    row = await _owned_connection(settings, user, connection_id)
    url = _check_url(settings, request.url) if request.url is not None else row.base_url
    if request.api_key is None:
        encrypted = row.api_key
    else:
        key = request.api_key.strip()
        encrypted = crypto_service.encrypt(settings, key) if key else ""
    if not encrypted and not llm_service.is_local_url(url):
        raise validation_error("An API needs a key. Delete the API to remove it.")  # only a local API may go without
    models = clean_models(request.models) if request.models is not None else list(row.models)
    updated = await api_connection_repository.update(
        settings.DATABASE_PATH, user.user_id, connection_id, url, encrypted, models
    )
    return _connection_view(_route_of(settings, updated))


async def delete_connection(settings: Settings, user: User, connection_id: str) -> None:
    if connection_id == "server":
        raise validation_error("The server's own API is set in .env and cannot be deleted here.")
    await _owned_connection(settings, user, connection_id)
    await api_connection_repository.delete(settings.DATABASE_PATH, user.user_id, connection_id)


async def test_connection(settings: Settings, user: User, connection_id: str) -> TestConnectionResult:
    """Ask one API for a one-word reply, with the first model it lists."""
    if connection_id == "server":  # the server's own API can be tested too (it just cannot be edited)
        route = _server_route(settings)
        if route is None:
            raise not_found("API")
    else:
        route = _route_of(settings, await _owned_connection(settings, user, connection_id))
    if not route.models:
        return TestConnectionResult(ok=False, message="Add a model to this API before testing it.")
    agent = await agent_repository.get(settings.DATABASE_PATH, "assistant")
    try:
        await llm_service.complete(
            base_url=route.base_url,
            api_key=route.api_key,
            model=route.models[0],
            system=agent.system_prompt if agent else "You are a helpful assistant.",
            messages=[{"role": "user", "content": "Reply with OK."}],
            timeout=settings.LLM_TIMEOUT_SECONDS,
            block_private=settings.BLOCK_PRIVATE_LLM_URLS,
        )
    except llm_service.LLMError as exc:
        if exc.code == "llm_timeout":
            return TestConnectionResult(
                ok=False, message=f"Connection timed out after {settings.LLM_TIMEOUT_SECONDS:g} seconds."
            )
        return TestConnectionResult(ok=False, message=exc.message)
    return TestConnectionResult(ok=True, message="Connection verified. Your API returned a response.")


# ---- agents
async def list_agents(settings: Settings) -> list[AgentView]:
    return [AgentView(id=a.agent_id, name=a.name) for a in await agent_repository.list_all(settings.DATABASE_PATH)]


async def require_agent(settings: Settings, agent_id: str) -> Agent:
    agent = await agent_repository.get(settings.DATABASE_PATH, agent_id)
    if agent is None:
        raise validation_error(f"Unknown agent: {agent_id}.")
    return agent


# ---- preferences
def _view(prefs: UserPreferences) -> PreferencesView:
    return PreferencesView(
        agent_id=prefs.agent_id,
        model=prefs.model,
        chat_sidebar_hidden=prefs.chat_sidebar_hidden,
        replay_prompts_hidden=prefs.replay_prompts_hidden,
        show_compact_button=prefs.show_compact_button,
        show_rewind_button=prefs.show_rewind_button,
        show_page_popups=prefs.show_page_popups,
        api_tour_seen=prefs.api_tour_seen,
    )


async def get_preferences(settings: Settings, user: User) -> UserPreferences:
    return await preferences_repository.get(settings.DATABASE_PATH, user.user_id) or UserPreferences(
        user_id=user.user_id
    )


async def get_preferences_view(settings: Settings, user: User) -> PreferencesView:
    return _view(await get_preferences(settings, user))


async def update_preferences(settings: Settings, user: User, request: UpdatePreferencesRequest) -> PreferencesView:
    changes = request.model_dump(exclude_unset=True)
    if "agent_id" in changes:
        if changes["agent_id"] is None:
            raise validation_error("agent_id cannot be null.")
        await require_agent(settings, changes["agent_id"])
    for field in ("chat_sidebar_hidden", "replay_prompts_hidden", "show_compact_button", "show_rewind_button", "show_page_popups", "api_tour_seen"):
        if field in changes and changes[field] is None:
            raise validation_error(f"{field} cannot be null.")
    await preferences_repository.update(settings.DATABASE_PATH, user.user_id, changes)
    return await get_preferences_view(settings, user)
