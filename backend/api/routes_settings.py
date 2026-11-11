from fastapi import APIRouter, Depends, Response

from api.deps import get_current_user
from config import Settings, get_settings
from controllers import settings_controller
from models.provider_settings import (
    ConnectionView,
    CreateConnectionRequest,
    SettingsView,
    TestConnectionResult,
    UpdateConnectionRequest,
)
from models.user import User

router = APIRouter()


@router.get("/api/settings", response_model=SettingsView)
async def get_settings_route(settings: Settings = Depends(get_settings), user: User = Depends(get_current_user)):
    return await settings_controller.get_settings(settings, user)


@router.get("/api/connections", response_model=list[ConnectionView])
async def list_connections(settings: Settings = Depends(get_settings), user: User = Depends(get_current_user)):
    return await settings_controller.list_connections(settings, user)


@router.post("/api/connections", response_model=ConnectionView, status_code=201)
async def create_connection(
    request: CreateConnectionRequest, settings: Settings = Depends(get_settings), user: User = Depends(get_current_user)
):
    return await settings_controller.create_connection(settings, user, request)


@router.put("/api/connections/{connection_id}", response_model=ConnectionView)
async def update_connection(
    connection_id: str,
    request: UpdateConnectionRequest,
    settings: Settings = Depends(get_settings),
    user: User = Depends(get_current_user),
):
    return await settings_controller.update_connection(settings, user, connection_id, request)


@router.delete("/api/connections/{connection_id}", status_code=204)
async def delete_connection(
    connection_id: str, settings: Settings = Depends(get_settings), user: User = Depends(get_current_user)
):
    await settings_controller.delete_connection(settings, user, connection_id)
    return Response(status_code=204)


@router.post("/api/connections/{connection_id}/test", response_model=TestConnectionResult)
async def test_connection(
    connection_id: str, settings: Settings = Depends(get_settings), user: User = Depends(get_current_user)
):
    return await settings_controller.test_connection(settings, user, connection_id)
