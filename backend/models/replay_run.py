from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

from models.conversation import ReasoningLevel
from models.decision import DecisionStep

Slot = Literal["a", "b"]
SLOTS: tuple[Slot, Slot] = ("a", "b")
MAX_PROMPTS = 200


class ReplayResult(BaseModel):
    replay_result_id: str
    replay_run_id: str
    slot: Slot
    turn_index: int
    content: str
    model: str
    demo: bool = False
    error: bool = False
    decision_trace: list[DecisionStep] | None = None
    kb_summary: str | None = None
    """When the run's KB-summary-tool switch was on: the summary this slot's model wrote of the file it was routed to."""
    kb_version_deleted: bool = False
    created_at: datetime


class ApiCallRequest(BaseModel):
    headers: dict[str, str]
    """The headers sent. The API key is replaced by a placeholder: it is never stored or shown."""
    body: dict
    """The JSON body, exactly as sent (model, messages, reasoning_effort, temperature, ...)."""


class ApiCallResponse(BaseModel):
    status: int
    body: str
    """The response body as text, exactly as the provider sent it (cut when very long: see `truncated`)."""
    truncated: bool = False


class ApiCallSettings(BaseModel):
    """What the user set for the call, and whether the request carried it. The request body is exactly what was sent."""

    temperature: float | None = None
    """The temperature asked for. None: no temperature was given for this call."""
    temperature_sent: bool = False
    temperature_note: str | None = None
    """Why it was left out, when it was asked for but not sent (the model refused it)."""
    logprobs: bool = False
    """Log probabilities were asked for (the setting)."""
    logprobs_sent: bool = False
    logprobs_note: str | None = None
    """Why they were asked for but not requested (the model does not take them with this reasoning level)."""
    reasoning_effort: str | None = None
    """The reasoning effort sent. None: the field was left out, so the model's own default applies."""
    rule: str | None = None
    """The model rule that shaped the request (services/OpenAI_API_Model_rules.py): a model id, a prefix like gpt-5*, or unknown."""
    adjustments: list[str] = []
    """Everything the rules left out or changed, in words."""


class ApiCall(BaseModel):
    """One REST call made to the model provider while a replay result was produced."""

    at: datetime
    purpose: str
    """answer, kb_summary, compact_summary or kb_route:<level>."""
    method: str
    url: str
    duration_ms: int
    request: ApiCallRequest
    settings: ApiCallSettings | None = None
    """None for calls logged before this was kept."""
    response: ApiCallResponse | None = None
    error: str | None = None
    """Set when there was no response (timeout, unreachable)."""
    request_retry_counter: int | None = None
    """Chat calls only: 0 for the first attempt of this purpose for the prompt, 1 for the first retry, and so on."""
    api_response_code: str | None = None
    """Chat calls only: the provider's own error code, when it gave one."""
    response_status: Literal["failed", "timeout", "success", "error"] | None = None
    """Chat calls only: how the attempt ended. failed: the provider answered with an error status. timeout: no answer
    in time. error: unreachable, or an answer that could not be used."""


class TokenLogprob(BaseModel):
    token: str
    logprob: float


class SavedLogprobsTurn(BaseModel):
    turn_index: int
    tokens: list[TokenLogprob] | None
    """The answer's tokens with their log probabilities; None when this answer has none."""


class SavedLogprobs(BaseModel):
    """The answer tokens' log probabilities behind one saved replay (one slot), for the Diff page."""

    id: str
    available: bool
    """False when no answer of this replay returned log probabilities (the switch was off, or the model refused)."""
    turns: list[SavedLogprobsTurn]


class ApiLogTurn(BaseModel):
    turn_index: int
    prompt: str
    calls: list[ApiCall]
    source_conversation_id: str | None = None
    """Chat API log of a fork: the conversation that made these calls, when it is not the one being viewed."""
    source_conversation_name: str | None = None
    """That conversation's name; None when it has since been deleted."""


class ApiLog(BaseModel):
    """The raw REST calls behind one saved replay (one slot), turn by turn."""

    id: str
    recorded: bool
    """False when the replay was saved before calls were kept. An empty log with recorded true means demo mode."""
    model: str
    temperature: float
    reasoning_level: str
    logprobs: bool
    """The temperature, reasoning level and log-probabilities switch the replay was set to (each call below shows what it
    actually sent)."""
    turns: list[ApiLogTurn]


class ReplayRun(BaseModel):
    replay_run_id: str
    user_id: str
    agent_id: str
    prompts: list[str]
    model_a: str
    model_b: str
    kb_summary_tool: bool = False
    reasoning_level: ReasoningLevel = "default"
    temperature: float = 0.0
    logprobs: bool = False
    brief_replies: bool = False
    context_summary: str | None = None
    source_conversation_id: str | None = None
    """The chat the run was started from (None for older runs and runs from explicit prompts or a chat record)."""
    cursor: int
    stop_requested: bool = False
    step_started_at: datetime | None = None
    saved_at: datetime | None = None
    created_at: datetime
    updated_at: datetime


class CreateReplayRunRequest(BaseModel):
    """Give at most one source for the prompts. With none, the user's current conversation is used."""

    prompts: list[str] | None = Field(default=None, max_length=MAX_PROMPTS)
    conversation_id: str | None = Field(default=None, max_length=100)
    chat_record_id: str | None = Field(default=None, max_length=100)
    source_conversation_id: str | None = Field(default=None, max_length=100)
    """With explicit `prompts` (Reset): the chat the run belongs to. Ignored when `conversation_id` is given."""
    model_a: str | None = Field(default=None, max_length=200)
    model_b: str | None = Field(default=None, max_length=200)
    agent_id: str | None = Field(default=None, max_length=100)
    kb_summary_tool: bool | None = None
    """One switch for the whole run (both slots). Default: the source conversation's, else off."""
    reasoning_level: ReasoningLevel | None = None
    """Default: "none" (reasoning off), whatever the source conversation used."""
    temperature: float | None = Field(default=None, ge=0, le=2)
    """Default: the source conversation's, else 0."""
    logprobs: bool | None = None
    """Ask the model for log probabilities in the response. Default: off."""
    brief_replies: bool | None = None
    """Append "Respond in 100 words or less." to the end of each request. Default: the source conversation's, else off."""


class UpdateReplayRunRequest(BaseModel):
    model_a: str | None = Field(default=None, max_length=200)
    model_b: str | None = Field(default=None, max_length=200)
    agent_id: str | None = Field(default=None, max_length=100)
    kb_summary_tool: bool | None = None
    reasoning_level: ReasoningLevel | None = None
    temperature: float | None = Field(default=None, ge=0, le=2)
    logprobs: bool | None = None
    brief_replies: bool | None = None


class StepRequest(BaseModel):
    expected_cursor: int = Field(ge=0)
    request_id: str | None = Field(default=None, min_length=8, max_length=64, pattern=r"^[A-Za-z0-9_-]+$")
    """The client's id for this step. Lets a stop command name it, even if the stop arrives first."""


class StopStepRequest(BaseModel):
    request_id: str | None = Field(default=None, min_length=8, max_length=64, pattern=r"^[A-Za-z0-9_-]+$")
    """The step to stop. Without it, whichever step is running is stopped."""


class ReplayRunView(BaseModel):
    replay_run_id: str
    agent_id: str
    prompts: list[str]
    model_a: str
    model_b: str
    kb_summary_tool: bool
    reasoning_level: ReasoningLevel
    temperature: float
    logprobs: bool
    brief_replies: bool
    context_summary: str | None
    source_conversation_id: str | None
    cursor: int
    step_running: bool
    saved_at: datetime | None
    created_at: datetime
    updated_at: datetime
    results: dict[Slot, list[ReplayResult]]


class SavedReplaySummary(BaseModel):
    """Derived, not stored: a saved run's results for one slot."""

    id: str
    """"{replay_run_id}:{slot}" - the same shape the frontend already uses."""
    replay_run_id: str
    slot: Slot
    model: str
    agent_id: str
    completed: bool
    kb_summary_tool: bool = False
    """The run's KB-summary-tool switch (one for both slots): the Diff shows which setting a replay used."""
    reasoning_level: ReasoningLevel = "default"
    temperature: float = 0.0
    logprobs: bool = False
    brief_replies: bool = False
    source_conversation_id: str | None = None
    """The chat this replay was started from: the Replay page groups a chat's saved replays as versions."""
    prompt_count: int
    response_count: int
    created_at: datetime
    """When the run was saved."""


class SavedReplay(SavedReplaySummary):
    prompts: list[str]
    responses: list[ReplayResult]
