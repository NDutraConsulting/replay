from config import Settings
from models.chat_record import ChatRecordView, CreateChatRecordRequest
from models.user import User
from services import chat_record_service as service


async def list_records(settings: Settings, user: User) -> list[ChatRecordView]:
    return await service.list_records(settings, user)


async def create_record(settings: Settings, user: User, request: CreateChatRecordRequest) -> ChatRecordView:
    return await service.create_from_conversation(settings, user, request.conversation_id)
