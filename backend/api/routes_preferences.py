from fastapi import APIRouter, Depends

from api.deps import get_current_user
from config import Settings, get_settings
from controllers import settings_controller
from models.preferences import PreferencesView, UpdatePreferencesRequest
from models.user import User

router = APIRouter()


@router.get("/api/preferences", response_model=PreferencesView)
async def get_preferences(settings: Settings = Depends(get_settings), user: User = Depends(get_current_user)):
    return await settings_controller.get_preferences(settings, user)


@router.put("/api/preferences", response_model=PreferencesView)
async def put_preferences(
    request: UpdatePreferencesRequest,
    settings: Settings = Depends(get_settings),
    user: User = Depends(get_current_user),
):
    return await settings_controller.update_preferences(settings, user, request)
