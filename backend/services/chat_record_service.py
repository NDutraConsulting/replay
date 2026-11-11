from config import Settings
from errors import not_found, validation_error
from models.chat_record import ChatRecordView
from models.user import User
from repositories import chat_record_repository, conversation_repository, message_repository


def _view(record) -> ChatRecordView:
    return ChatRecordView(
        chat_record_id=record.chat_record_id, name=record.name, prompts=record.prompts, created_at=record.created_at
    )


async def list_records(settings: Settings, user: User) -> list[ChatRecordView]:
    return [_view(r) for r in await chat_record_repository.list_for_user(settings.DATABASE_PATH, user.user_id)]


async def create_from_conversation(settings: Settings, user: User, conversation_id: str) -> ChatRecordView:
    conversation = await conversation_repository.get_owned(settings.DATABASE_PATH, user.user_id, conversation_id)
    if conversation is None:
        raise not_found("Conversation")
    prompts = await message_repository.user_prompts(settings.DATABASE_PATH, conversation_id)
    if not prompts:
        raise validation_error("Send a chat message before saving a record.")
    return _view(await chat_record_repository.create(settings.DATABASE_PATH, user.user_id, prompts))
