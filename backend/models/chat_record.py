from datetime import datetime

from pydantic import BaseModel, Field


class ChatRecord(BaseModel):
    chat_record_id: str
    user_id: str
    name: str
    prompts: list[str]
    created_at: datetime


class CreateChatRecordRequest(BaseModel):
    conversation_id: str = Field(min_length=1, max_length=100)


class ChatRecordView(BaseModel):
    chat_record_id: str
    name: str
    prompts: list[str]
    created_at: datetime
