from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

from models.decision import DecisionStep

# Status tag on every message:
#   complete - normal message
#   pending  - user message sent, reply not stored yet
#   stopped  - user message whose reply the user cancelled with the stop command
#   failed   - user message whose model call errored (or was superseded while pending)
#   ignored  - assistant message that arrived after a stop: kept for tracking, never shown,
#              never sent back to the model
MessageStatus = Literal["complete", "pending", "stopped", "failed", "ignored"]

# What a message is (Phase 8):
#   chat              a normal turn
#   kb_reference      internal: this turn was answered with a version of a knowledge base file (no text stored)
#   kb_summary_tool   internal: the model-written summary of that file, sent in place of its text
#   compacted_summary the first message of a conversation started by Compact
# The two internal types are never shown as turns; they are attached to the answer they belong to.
MessageType = Literal["chat", "kb_reference", "kb_summary_tool", "compacted_summary"]
INTERNAL_TYPES = ("kb_reference", "kb_summary_tool")

# OpenAI's `reasoning_effort` values. "default" omits the field (the model's own default applies). Which values a model
# accepts differs by model; a provider that rejects one answers 400 and the message is marked failed.
REASONING_LEVELS = ("default", "none", "minimal", "low", "medium", "high", "xhigh")
ReasoningLevel = Literal["default", "none", "minimal", "low", "medium", "high", "xhigh"]
MAX_NAME_LENGTH = 80
MAX_TEMPERATURE = 2.0
"""OpenAI accepts a temperature from 0 to 2. 0 (the default here) is the least random."""


class Conversation(BaseModel):
    conversation_id: str
    user_id: str
    is_sample: bool
    name: str = ""
    """A free label. The conversation_id (uuid) is the only identity."""
    agent_id: str = ""
    model: str = ""
    reasoning_level: ReasoningLevel = "default"
    temperature: float = 0.0
    kb_summary_tool: bool = False
    """Fixed at creation: agent, model, reasoning level, temperature and these two switches. Only the name can change."""
    brief_replies: bool = False
    """Append "Respond in 100 words or less." to the end of each request (services/history_service.BRIEF_REPLY_INSTRUCTION)."""
    source_conversation_id: str | None = None
    """Set on a conversation started by Compact: the conversation it summarises."""
    created_at: datetime
    updated_at: datetime


class Message(BaseModel):
    message_id: str
    conversation_id: str
    sequence_number: int
    role: Literal["user", "assistant"]
    content: str
    status: MessageStatus = "complete"
    model: str | None = None
    agent: str | None = None
    demo: bool = False
    created_at: datetime
    request_id: str | None = None
    """The client's id for the send that produced this user message (lets the page recognize its own prompt)."""
    message_type: MessageType = "chat"
    decision_trace: list[DecisionStep] | None = None
    """On an assistant message: the knowledge-base choices made to answer it (None when nothing was routed)."""
    kb_summary: str | None = None
    """On an assistant message, when the KB-summary-tool was on: the summary of the file that was sent instead of it."""
    kb_version_deleted: bool = False
    """On an assistant message: the version of the file it was answered with has since been deleted."""
    kb_version_id: str | None = None
    kb_label: str | None = None


class ConversationView(BaseModel):
    conversation_id: str
    is_sample: bool
    name: str
    agent_id: str
    model: str
    reasoning_level: ReasoningLevel
    temperature: float
    kb_summary_tool: bool
    brief_replies: bool
    brief_instruction: str
    """The exact text added to the end of each request when `brief_replies` is on, so the page can show what is sent."""
    source_conversation_id: str | None
    created_at: datetime
    max_user_prompts: int
    """The most prompts a conversation may hold (MAX_USER_PROMPTS in .env): the page stops offering to send past it."""
    messages: list[Message]
    """Never includes `ignored` messages or the internal knowledge base rows."""


class ConversationSummary(BaseModel):
    """One row of the File > Open list: a chat started in the chat interface (replays are never listed here)."""

    conversation_id: str
    name: str
    agent_id: str
    model: str
    reasoning_level: ReasoningLevel
    temperature: float
    kb_summary_tool: bool
    brief_replies: bool
    source_conversation_id: str | None
    prompt_count: int
    created_at: datetime
    updated_at: datetime


class NewConversationRequest(BaseModel):
    """The New conversation popup. Everything except the name is fixed for the life of the conversation."""

    name: str = Field(default="", max_length=400)
    """A free label (trimmed to 80 characters; blank gets a generated one). Not unique."""
    agent_id: str = Field(min_length=1, max_length=100)
    model: str = Field(min_length=1, max_length=200)
    reasoning_level: ReasoningLevel = "default"
    temperature: float = Field(default=0.0, ge=0, le=MAX_TEMPERATURE)
    """0 to 2. 0 is the least random. A reasoning model takes it only when the reasoning level is none; otherwise it is not
    sent (services/OpenAI_API_Model_rules.py decides, and the API log says so)."""
    kb_summary_tool: bool = False
    brief_replies: bool = False


class UpdateConversationRequest(BaseModel):
    """Rename. The other fields exist only so the API can refuse them: the configuration is fixed."""

    name: str | None = Field(default=None, max_length=400)
    agent_id: str | None = None
    model: str | None = None
    reasoning_level: ReasoningLevel | None = None
    temperature: float | None = None
    kb_summary_tool: bool | None = None
    brief_replies: bool | None = None


class SendMessageRequest(BaseModel):
    """The agent, model and reasoning level come from the conversation, never from the message."""

    content: str = Field(max_length=8000)
    request_id: str | None = Field(default=None, min_length=8, max_length=64, pattern=r"^[A-Za-z0-9_-]+$")
    """The client's id for this send. Lets a stop command name it, even if the stop arrives first."""


class StopMessageRequest(BaseModel):
    request_id: str | None = Field(default=None, min_length=8, max_length=64, pattern=r"^[A-Za-z0-9_-]+$")
    """Stop this send. Without it, the conversation's latest pending prompt is stopped."""


class SendMessageResponse(BaseModel):
    messages: list[Message]
    """[the user's message, the assistant's reply]"""


class RewindResponse(BaseModel):
    messages: list[Message]
    removed_prompt: str
