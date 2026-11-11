"""Agents, API connections and preferences: thin orchestration between the routes and settings_service."""

from config import Settings
from models.agent import AgentView
from models.preferences import PreferencesView, UpdatePreferencesRequest
from models.provider_settings import (
    ConnectionView,
    CreateConnectionRequest,
    SettingsView,
    TestConnectionResult,
    UpdateConnectionRequest,
)
from models.user import User
from services import settings_service


async def list_agents(settings: Settings) -> list[AgentView]:
    return await settings_service.list_agents(settings)


async def get_settings(settings: Settings, user: User) -> SettingsView:
    return await settings_service.get_view(settings, user)


async def list_connections(settings: Settings, user: User) -> list[ConnectionView]:
    return (await settings_service.get_view(settings, user)).connections


async def create_connection(settings: Settings, user: User, request: CreateConnectionRequest) -> ConnectionView:
    return await settings_service.create_connection(settings, user, request)


async def update_connection(
    settings: Settings, user: User, connection_id: str, request: UpdateConnectionRequest
) -> ConnectionView:
    return await settings_service.update_connection(settings, user, connection_id, request)


async def delete_connection(settings: Settings, user: User, connection_id: str) -> None:
    await settings_service.delete_connection(settings, user, connection_id)


async def test_connection(settings: Settings, user: User, connection_id: str) -> TestConnectionResult:
    return await settings_service.test_connection(settings, user, connection_id)


async def get_preferences(settings: Settings, user: User) -> PreferencesView:
    return await settings_service.get_preferences_view(settings, user)


async def update_preferences(settings: Settings, user: User, request: UpdatePreferencesRequest) -> PreferencesView:
    return await settings_service.update_preferences(settings, user, request)
