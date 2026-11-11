from fastapi import APIRouter, Depends

from api.deps import get_current_user
from config import Settings, get_settings
from controllers import chat_record_controller as controller
from models.chat_record import ChatRecordView, CreateChatRecordRequest
from models.user import User

router = APIRouter()


@router.get("/api/chat-records", response_model=list[ChatRecordView])
async def list_records(settings: Settings = Depends(get_settings), user: User = Depends(get_current_user)):
    return await controller.list_records(settings, user)


@router.post("/api/chat-records", response_model=ChatRecordView, status_code=201)
async def create_record(
    request: CreateChatRecordRequest, settings: Settings = Depends(get_settings), user: User = Depends(get_current_user)
):
    return await controller.create_record(settings, user, request)
