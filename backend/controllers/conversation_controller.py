from config import Settings
from models.common import StopResponse
from models.conversation import (
    ConversationSummary,
    ConversationView,
    NewConversationRequest,
    RewindResponse,
    SendMessageRequest,
    SendMessageResponse,
    UpdateConversationRequest,
)
from models.replay_run import ApiLog
from models.user import User
from services import conversation_service as service


async def get_current(settings: Settings, user: User) -> ConversationView:
    return await service.get_current(settings, user)


async def get_one(settings: Settings, user: User, conversation_id: str) -> ConversationView:
    return await service.get_one(settings, user, conversation_id)


async def list_conversations(settings: Settings, user: User) -> list[ConversationSummary]:
    return await service.list_conversations(settings, user)


async def open_conversation(settings: Settings, user: User, conversation_id: str) -> ConversationView:
    return await service.open_conversation(settings, user, conversation_id)


async def new_conversation(settings: Settings, user: User, request: NewConversationRequest) -> ConversationView:
    return await service.new_conversation(settings, user, request)


async def update(
    settings: Settings, user: User, conversation_id: str, request: UpdateConversationRequest
) -> ConversationView:
    return await service.update(settings, user, conversation_id, request)


async def compact(settings: Settings, user: User, conversation_id: str) -> ConversationView:
    return await service.compact(settings, user, conversation_id)


async def send_message(
    settings: Settings, user: User, conversation_id: str, request: SendMessageRequest
) -> SendMessageResponse:
    return await service.send_message(settings, user, conversation_id, request)


async def rewind(settings: Settings, user: User, conversation_id: str) -> RewindResponse:
    return await service.rewind(settings, user, conversation_id)


async def stop(settings: Settings, user: User, conversation_id: str, request_id: str | None = None) -> StopResponse:
    return await service.stop(settings, user, conversation_id, request_id)


async def get_api_log(settings: Settings, user: User, conversation_id: str) -> ApiLog:
    return await service.get_api_log(settings, user, conversation_id)
