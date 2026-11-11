from fastapi import APIRouter, Depends

from api.deps import get_current_user
from config import Settings, get_settings
from controllers import conversation_controller as controller
from models.common import StopResponse
from models.conversation import (
    ConversationSummary,
    ConversationView,
    NewConversationRequest,
    RewindResponse,
    SendMessageRequest,
    SendMessageResponse,
    StopMessageRequest,
    UpdateConversationRequest,
)
from models.user import User

router = APIRouter()


@router.get("/api/conversations", response_model=list[ConversationSummary])
async def list_conversations(settings: Settings = Depends(get_settings), user: User = Depends(get_current_user)):
    return await controller.list_conversations(settings, user)


@router.get("/api/conversations/current", response_model=ConversationView)
async def get_current(settings: Settings = Depends(get_settings), user: User = Depends(get_current_user)):
    return await controller.get_current(settings, user)


@router.post("/api/conversations", response_model=ConversationView, status_code=201)
async def new_conversation(
    request: NewConversationRequest, settings: Settings = Depends(get_settings), user: User = Depends(get_current_user)
):
    return await controller.new_conversation(settings, user, request)


@router.get("/api/conversations/{conversation_id}", response_model=ConversationView)
async def get_conversation(
    conversation_id: str, settings: Settings = Depends(get_settings), user: User = Depends(get_current_user)
):
    return await controller.get_one(settings, user, conversation_id)


@router.patch("/api/conversations/{conversation_id}", response_model=ConversationView)
async def update_conversation(
    conversation_id: str,
    request: UpdateConversationRequest,
    settings: Settings = Depends(get_settings),
    user: User = Depends(get_current_user),
):
    return await controller.update(settings, user, conversation_id, request)


@router.post("/api/conversations/{conversation_id}/open", response_model=ConversationView)
async def open_conversation(
    conversation_id: str, settings: Settings = Depends(get_settings), user: User = Depends(get_current_user)
):
    return await controller.open_conversation(settings, user, conversation_id)


@router.post("/api/conversations/{conversation_id}/compact", response_model=ConversationView, status_code=201)
async def compact_conversation(
    conversation_id: str, settings: Settings = Depends(get_settings), user: User = Depends(get_current_user)
):
    return await controller.compact(settings, user, conversation_id)


@router.post("/api/conversations/{conversation_id}/messages", response_model=SendMessageResponse)
async def send_message(
    conversation_id: str,
    request: SendMessageRequest,
    settings: Settings = Depends(get_settings),
    user: User = Depends(get_current_user),
):
    return await controller.send_message(settings, user, conversation_id, request)


@router.post("/api/conversations/{conversation_id}/rewind", response_model=RewindResponse)
async def rewind(
    conversation_id: str, settings: Settings = Depends(get_settings), user: User = Depends(get_current_user)
):
    return await controller.rewind(settings, user, conversation_id)


@router.post("/api/conversations/{conversation_id}/stop", response_model=StopResponse)
async def stop(
    conversation_id: str,
    request: StopMessageRequest | None = None,
    settings: Settings = Depends(get_settings),
    user: User = Depends(get_current_user),
):
    return await controller.stop(settings, user, conversation_id, request.request_id if request else None)
