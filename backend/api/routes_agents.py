from fastapi import APIRouter, Depends

from api.deps import get_current_user
from config import Settings, get_settings
from controllers import settings_controller
from models.agent import AgentView
from models.user import User

router = APIRouter()


@router.get("/api/agents", response_model=list[AgentView])
async def list_agents(settings: Settings = Depends(get_settings), user: User = Depends(get_current_user)):
    return await settings_controller.list_agents(settings)
