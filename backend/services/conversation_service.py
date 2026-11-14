"""Conversations and messages: creating (with a fixed configuration), sending, stop, rename, lock, fork and Compact.

A conversation's agent, model, reasoning level and KB-summary-tool switch are chosen once, in the New conversation
popup, and are fixed: every message runs with them (the client does not send them), so a set of conversations can be
compared against each other. Only the name, a free label, can change. The conversation's uuid is its only identity.

Sending is a small state machine driven by the status tag on the user's message:
  pending  --reply arrives first-->   complete   (reply stored as complete)
  pending  --user sends stop-->       stopped    (a late reply is stored as `ignored` and hidden)
  pending  --model call errors-->     failed
"""

import asyncio
import logging
import uuid
from datetime import UTC, datetime

from config import Settings
from errors import AppError, conflict, not_found, validation_error
from models.common import StopResponse
from models.conversation import (
    MAX_NAME_LENGTH,
    Conversation,
    ConversationSummary,
    ConversationView,
    ForkRequest,
    Message,
    NewConversationRequest,
    SendMessageRequest,
    SendMessageResponse,
    UpdateConversationRequest,
)
from models.decision import DecisionStep
from models.replay_run import ApiCall, ApiLog, ApiLogTurn
from models.user import User
from repositories import chat_api_log_repository, conversation_repository, kb_choice_repository, message_repository
from repositories.conversation_errors import ConversationLocked, PromptInProgress
from services import (
    demo_response_service,
    history_service,
    kb_routing_service,
    llm_service,
    settings_service,
    summary_service,
)
from services.OpenAI_API_Model_rules import resolve_params

logger = logging.getLogger(__name__)


def _locked() -> AppError:
    return conflict(
        "conversation_locked", "This conversation is locked. Open it to fork it and keep going from a copy."
    )


def _prompt_in_progress() -> AppError:
    return conflict("prompt_in_progress", "A prompt is still waiting for its reply. Wait for it, or stop it, first.")


def _stopped() -> AppError:
    return conflict("stopped", "Response stopped. Your prompt is saved.")


def _generated_name(agent_name: str) -> str:
    return f"{agent_name} {datetime.now(UTC).date().isoformat()}"


def _clean_name(name: str, agent_name: str) -> str:
    """A name is only a label: trimmed, at most 80 characters, not unique. A blank one is generated."""
    cleaned = " ".join(name.split())[:MAX_NAME_LENGTH].strip()
    return cleaned or _generated_name(agent_name)


async def _owned(settings: Settings, user: User, conversation_id: str) -> Conversation:
    conversation = await conversation_repository.get_owned(settings.DATABASE_PATH, user.user_id, conversation_id)
    if conversation is None:
        raise not_found("Conversation")
    if not conversation.model:
        # an older conversation that never recorded a model: give it one now (then it is fixed like any other)
        preferences = await settings_service.get_preferences(settings, user)
        models = await settings_service.available_models(settings, user)
        model = preferences.model if settings_service.model_known(models, preferences.model) else models[0]
        await conversation_repository.fill_model(settings.DATABASE_PATH, conversation_id, model)
        conversation = conversation.model_copy(update={"model": model})
    return conversation


async def _with_traces(settings: Settings, user: User, conversation_id: str, messages: list[Message]) -> list[Message]:
    """Attach what an answer was built from: the knowledge-base choices (a choice belongs to a send, its request id,
    and the answer is the assistant message that follows that prompt), the summary that stood in for the file when the
    KB-summary-tool was on, and a flag when the version of the file that was used has since been deleted."""
    request_ids = [m.request_id for m in messages if m.role == "user" and m.request_id]
    traces = await kb_choice_repository.trace_for_chat(
        settings.KNOWLEDGE_DB_PATH, user.user_id, conversation_id, request_ids
    )
    summaries = {
        m.request_id: m.content
        for m in await message_repository.list_internal(settings.DATABASE_PATH, conversation_id)
        if m.message_type == "kb_summary_tool" and m.request_id
    }
    if not traces and not summaries:
        return messages
    result: list[Message] = []
    prompt_request_id: str | None = None
    for message in messages:
        if message.role == "user":
            prompt_request_id = message.request_id
            result.append(message)
        elif message.message_type == "chat" and (prompt_request_id in traces or prompt_request_id in summaries):
            steps = [DecisionStep(**s) for s in traces.get(prompt_request_id, [])]
            result.append(
                message.model_copy(
                    update={
                        "decision_trace": steps or None,
                        "kb_summary": summaries.get(prompt_request_id),
                        "kb_version_deleted": any(s.kb_version_deleted for s in steps),
                    }
                )
            )
        else:
            result.append(message)
    return result


async def _view(settings: Settings, user: User, conversation: Conversation) -> ConversationView:
    messages = await message_repository.list_visible(settings.DATABASE_PATH, conversation.conversation_id)
    messages = await _with_traces(settings, user, conversation.conversation_id, messages)
    forked_from = (
        await conversation_repository.forks_for(settings.DATABASE_PATH, user.user_id, [conversation.conversation_id])
    ).get(conversation.conversation_id)
    parent = (
        await conversation_repository.get_owned(settings.DATABASE_PATH, user.user_id, forked_from)
        if forked_from
        else None
    )
    return ConversationView(
        conversation_id=conversation.conversation_id,
        is_sample=conversation.is_sample,
        name=conversation.name,
        agent_id=conversation.agent_id,
        model=conversation.model,
        reasoning_level=conversation.reasoning_level,
        temperature=conversation.temperature,
        kb_summary_tool=conversation.kb_summary_tool,
        brief_replies=conversation.brief_replies,
        brief_instruction=history_service.BRIEF_REPLY_INSTRUCTION,
        source_conversation_id=conversation.source_conversation_id,
        locked=conversation.locked_at is not None,
        lock_reason=conversation.lock_reason,
        forked_from_conversation_id=forked_from,
        forked_from_name=parent.name if parent else None,
        created_at=conversation.created_at,
        max_user_prompts=settings.MAX_USER_PROMPTS,
        messages=messages,
    )


async def get_current(settings: Settings, user: User) -> ConversationView:
    """The user's latest conversation. A brand-new user gets an empty one (their saved agent and model)."""
    conversation = await conversation_repository.get_latest(settings.DATABASE_PATH, user.user_id)
    if conversation is None:
        preferences = await settings_service.get_preferences(settings, user)
        models = await settings_service.available_models(settings, user)
        agent = await settings_service.require_agent(settings, preferences.agent_id)
        conversation = await conversation_repository.create(
            settings.DATABASE_PATH,
            user.user_id,
            name=_generated_name(agent.name),
            agent_id=agent.agent_id,
            model=preferences.model if settings_service.model_known(models, preferences.model) else models[0],
        )
    else:
        conversation = await _owned(settings, user, conversation.conversation_id)
    return await _view(settings, user, conversation)


async def get_one(settings: Settings, user: User, conversation_id: str) -> ConversationView:
    return await _view(settings, user, await _owned(settings, user, conversation_id))


async def list_conversations(settings: Settings, user: User) -> list[ConversationSummary]:
    """Every chat the user started in the chat interface, most recently used first. Replay runs and saved replays are
    kept in their own tables and never appear here."""
    rows = await conversation_repository.list_with_prompt_counts(settings.DATABASE_PATH, user.user_id)
    forks = await conversation_repository.forks_for(  # one query for the whole list
        settings.DATABASE_PATH, user.user_id, [c.conversation_id for c, _ in rows]
    )
    return [
        ConversationSummary(
            conversation_id=c.conversation_id,
            name=c.name,
            agent_id=c.agent_id,
            model=c.model,
            reasoning_level=c.reasoning_level,
            temperature=c.temperature,
            kb_summary_tool=c.kb_summary_tool,
            brief_replies=c.brief_replies,
            source_conversation_id=c.source_conversation_id,
            locked=c.locked_at is not None,
            forked_from_conversation_id=forks.get(c.conversation_id),
            prompt_count=count,
            created_at=c.created_at,
            updated_at=c.updated_at,
        )
        for c, count in rows
    ]


async def open_conversation(settings: Settings, user: User, conversation_id: str) -> ConversationView:
    """File > Open: make this chat the current one (so a reload and the Replay page follow it) and return it."""
    conversation = await _owned(settings, user, conversation_id)
    await conversation_repository.touch(settings.DATABASE_PATH, conversation.conversation_id)
    return await _view(settings, user, await _owned(settings, user, conversation_id))


async def new_conversation(settings: Settings, user: User, request: NewConversationRequest) -> ConversationView:
    agent = await settings_service.require_agent(settings, request.agent_id)
    await settings_service.require_model(settings, user, request.model)
    # A conversation's settings are fixed once it starts, so a model and reasoning level the model is documented not to accept
    # would make a chat that can never send (every message would answer 400). Refuse that here, with the same explanation
    # the send would give, while the New conversation popup is still open.
    provider = await settings_service.get_provider(settings, user, request.model)
    resolve_params(provider.model, summary_service.effort(request.reasoning_level), request.temperature)
    conversation = await conversation_repository.create(
        settings.DATABASE_PATH,
        user.user_id,
        name=_clean_name(request.name, agent.name),
        agent_id=agent.agent_id,
        model=request.model,
        reasoning_level=request.reasoning_level,
        temperature=request.temperature,
        kb_summary_tool=request.kb_summary_tool,
        brief_replies=request.brief_replies,
    )
    return await _view(settings, user, conversation)


async def update(
    settings: Settings, user: User, conversation_id: str, request: UpdateConversationRequest
) -> ConversationView:
    """Rename. Agent, model, reasoning level and the KB-summary-tool switch are fixed for the conversation."""
    conversation = await _owned(settings, user, conversation_id)
    fixed = [
        field
        for field in ("agent_id", "model", "reasoning_level", "temperature", "kb_summary_tool", "brief_replies")
        if getattr(request, field) is not None
    ]
    if fixed:
        raise conflict(
            "configuration_fixed",
            "A conversation's agent, model, reasoning level and KB-summary-tool setting are fixed when it starts. "
            "Start another conversation to try a different configuration. Only the name can be changed.",
        )
    if request.name is None:
        raise validation_error("Send the new name.")
    agent = await settings_service.require_agent(settings, conversation.agent_id)
    await conversation_repository.rename(settings.DATABASE_PATH, conversation_id, _clean_name(request.name, agent.name))
    return await _view(settings, user, await _owned(settings, user, conversation_id))


async def _attach_document(
    settings: Settings,
    conversation: Conversation,
    provider: settings_service.Provider,
    request_id: str,
    routing: kb_routing_service.Routing,
) -> None:
    """Record, by reference, the file this turn was answered with. With the KB-summary-tool on, a model first writes a
    summary of it for this conversation and the summary is what is stored (and sent) instead of the file's text."""
    document = routing.document
    if document is None or not document.version_id:
        return
    if conversation.kb_summary_tool:
        turns, summary = await history_service.conversation_turns(settings, conversation.conversation_id)
        text = await summary_service.summarize_document(
            settings,
            provider,
            provider.model,
            history_service.transcript(turns, summary),
            document.label,
            document.content,
            conversation.reasoning_level,
            conversation.temperature,
        )
        await message_repository.add_kb_row(
            settings.DATABASE_PATH,
            conversation.conversation_id,
            request_id,
            "kb_summary_tool",
            text,
            document.version_id,
            document.label,
        )
    else:
        await message_repository.add_kb_row(
            settings.DATABASE_PATH,
            conversation.conversation_id,
            request_id,
            "kb_reference",
            history_service.reference_row_content(document.category, document.subcategory, document.title),
            document.version_id,
            document.label,
        )


async def _log_calls(
    settings: Settings, user: User, conversation_id: str, request_id: str, message_id: str, calls: list[dict]
) -> None:
    """Keep the raw REST calls made for this prompt (Log.db, append-only), so the chat can show what was sent. A missing
    log must never fail a prompt, so a problem here is only logged."""
    try:
        await chat_api_log_repository.record_request(
            settings.LOG_DB_PATH, user.user_id, conversation_id, request_id, message_id, calls
        )
    except Exception:
        logger.exception("Could not log the API calls for %s", request_id)


async def get_api_log(settings: Settings, user: User, conversation_id: str) -> ApiLog:
    """What the Chat page sent to the model provider, prompt by prompt: the raw REST calls (the API key is never in
    them), found through the conversation's own rows in the log. Only prompts still in the conversation are listed.
    A fork lists the calls of the prompts it copied; those turns say which conversation made them. A conversation
    from before the log existed (or before it was reset) has `recorded` false."""
    conversation = await _owned(settings, user, conversation_id)
    messages = await message_repository.list_visible(settings.DATABASE_PATH, conversation_id)
    logged = await chat_api_log_repository.for_conversation(settings.LOG_DB_PATH, user.user_id, conversation_id)
    names: dict[str, str | None] = {}

    async def name_of(other_id: str) -> str | None:
        if other_id not in names:
            other = await conversation_repository.get_owned(settings.DATABASE_PATH, user.user_id, other_id)
            names[other_id] = other.name if other else None
        return names[other_id]

    turns = []
    for index, m in enumerate(m for m in messages if m.role == "user" and m.message_type == "chat"):
        calls = logged.get(m.message_id, [])
        made_in = calls[0]["conversation_id"] if calls else conversation_id
        turns.append(
            ApiLogTurn(
                turn_index=index,
                prompt=m.content,
                calls=[ApiCall(**{k: v for k, v in call.items() if k != "conversation_id"}) for call in calls],
                source_conversation_id=made_in if made_in != conversation_id else None,
                source_conversation_name=await name_of(made_in) if made_in != conversation_id else None,
            )
        )
    return ApiLog(
        id=conversation.conversation_id,
        recorded=bool(logged),
        model=conversation.model,
        temperature=conversation.temperature,
        logprobs=False,
        reasoning_level=conversation.reasoning_level,
        turns=turns,
    )


async def send_message(
    settings: Settings, user: User, conversation_id: str, request: SendMessageRequest
) -> SendMessageResponse:
    content = request.content.strip()
    if not content:
        raise validation_error("Message must not be blank.")
    conversation = await _owned(settings, user, conversation_id)
    if (
        await message_repository.count_user_prompts(settings.DATABASE_PATH, conversation_id)
        >= settings.MAX_USER_PROMPTS
    ):
        raise conflict(
            "prompt_limit_reached",
            f"This conversation has reached its limit of {settings.MAX_USER_PROMPTS} prompts. "
            "Start a new conversation (File > New) to keep going.",
        )
    agent = await settings_service.require_agent(settings, conversation.agent_id)
    provider = await settings_service.get_provider(settings, user, conversation.model)  # the API that serves its model

    # The prompt is saved first, so it survives a failure, a stop or a crash. Every send has a request id (the
    # client's, or one made here) that names it in the stop command and in the recorded knowledge-base choices.
    request_id = request.request_id or uuid.uuid4().hex
    try:
        user_message, already_stopped = await message_repository.begin_turn(
            settings.DATABASE_PATH, conversation_id, content, request_id
        )
    except ConversationLocked:
        raise _locked() from None
    if already_stopped:
        raise _stopped()  # the stop command arrived first: the prompt is saved, the model is never called
    calls: list[dict] = []
    try:
        with llm_service.collect_calls() as collected:
            calls = collected
            try:
                # Walk the agent's knowledge base: what it was offered and chose is recorded (and shown with the answer),
                # and the selections from earlier answered turns of this conversation are shown to it as a hint.
                answered = await message_repository.answered_request_ids(settings.DATABASE_PATH, conversation_id)
                previous = await kb_choice_repository.last_chat_path(
                    settings.KNOWLEDGE_DB_PATH, user.user_id, conversation_id, answered
                )
                routing = await kb_routing_service.route(
                    settings,
                    user,
                    agent.agent_id,
                    provider,
                    provider.model,
                    content,
                    previous,
                    reasoning_effort=summary_service.effort(conversation.reasoning_level),
                    temperature=conversation.temperature,
                )
                if routing.steps:
                    await kb_choice_repository.record_path(
                        settings.KNOWLEDGE_DB_PATH,
                        user.user_id,
                        agent.agent_id,
                        "chat",
                        conversation_id,
                        request_id,
                        routing.steps,
                    )
                await _attach_document(settings, conversation, provider, request_id, routing)
                if provider.connected:
                    reply = await llm_service.complete(
                        base_url=provider.base_url,
                        api_key=provider.api_key,
                        model=provider.model,
                        system=agent.system_prompt,
                        messages=await history_service.for_conversation(
                            settings, conversation_id, brief=conversation.brief_replies
                        ),
                        timeout=settings.LLM_TIMEOUT_SECONDS,
                        block_private=settings.BLOCK_PRIVATE_LLM_URLS,
                        reasoning_effort=summary_service.effort(conversation.reasoning_level),
                        temperature=conversation.temperature,
                    )
                else:
                    if settings.DEMO_DELAY_SECONDS > 0:
                        await asyncio.sleep(settings.DEMO_DELAY_SECONDS)
                    reply = demo_response_service.demo_response(
                        await history_service.for_conversation(settings, conversation_id, plain=True),
                        conversation.model,
                        agent.agent_id,
                        provider.models,
                        source=kb_routing_service.demo_source(routing),
                    )
            except Exception:
                # a failed or stopped turn must not leave its file behind to be sent again with the next prompt
                await message_repository.delete_kb_rows(settings.DATABASE_PATH, conversation_id, request_id)
                status = await message_repository.mark_failed(settings.DATABASE_PATH, user_message.message_id)
                if status == "stopped":
                    raise _stopped() from None  # the user cancelled; the provider error no longer matters
                raise

    finally:
        await _log_calls(settings, user, conversation_id, request_id, user_message.message_id, calls)

    outcome, user_stored, assistant = await message_repository.finish_reply(
        settings.DATABASE_PATH,
        conversation_id,
        user_message.message_id,
        reply,
        conversation.model,
        agent.name,
        demo=not provider.connected,
    )
    if outcome == "complete":
        messages = await _with_traces(settings, user, conversation_id, [user_stored, assistant])
        return SendMessageResponse(messages=messages)
    await message_repository.delete_kb_rows(settings.DATABASE_PATH, conversation_id, request_id)
    if outcome == "gone":
        raise conflict("prompt_removed", "That prompt was removed before the reply arrived.")
    raise _stopped()


async def stop(settings: Settings, user: User, conversation_id: str, request_id: str | None = None) -> StopResponse:
    await _owned(settings, user, conversation_id)
    return StopResponse(stopped=await message_repository.stop(settings.DATABASE_PATH, conversation_id, request_id))


async def compact(settings: Settings, user: User, conversation_id: str) -> ConversationView:
    """The Compact button: a model writes a summary of this conversation (including the text of every file it used), and
    a NEW conversation starts from it, with the same fixed configuration. This conversation is left untouched."""
    conversation = await _owned(settings, user, conversation_id)
    turns, earlier_summary = await history_service.conversation_turns(settings, conversation_id)
    if not any(t.user is not None and t.assistant is not None for t in turns):
        raise conflict("nothing_to_compact", "Send at least one prompt and get an answer before compacting.")
    agent = await settings_service.require_agent(settings, conversation.agent_id)
    provider = await settings_service.get_provider(settings, user, conversation.model)
    summary = await summary_service.summarize_conversation(
        settings,
        provider,
        provider.model,
        history_service.text_of(history_service.render(turns, earlier_summary)),
        conversation.reasoning_level,
        conversation.temperature,
    )
    started = await conversation_repository.create(
        settings.DATABASE_PATH,
        user.user_id,
        name=f"{conversation.name} (summary)"[:MAX_NAME_LENGTH],
        agent_id=conversation.agent_id,
        model=conversation.model,
        reasoning_level=conversation.reasoning_level,
        temperature=conversation.temperature,
        kb_summary_tool=conversation.kb_summary_tool,
        brief_replies=conversation.brief_replies,
        source_conversation_id=conversation.conversation_id,
        opening={
            "role": "assistant",
            "content": summary.strip(),
            "message_type": "compacted_summary",
            "model": conversation.model,
            "agent": agent.name,
            "demo": not provider.connected,
        },
    )
    return await _view(settings, user, started)


async def lock(settings: Settings, user: User, conversation_id: str) -> ConversationView:
    """Lock a conversation: it takes no more prompts, but stays available for replay. Locking a locked conversation
    changes nothing."""
    conversation = await _owned(settings, user, conversation_id)
    try:
        await conversation_repository.lock(settings.DATABASE_PATH, conversation.conversation_id, "user")
    except PromptInProgress:
        raise _prompt_in_progress() from None
    return await _view(settings, user, await _owned(settings, user, conversation_id))


async def lock_for_replay(settings: Settings, user: User, conversation_id: str) -> None:
    """A replay of this conversation is starting: lock it so the source can no longer change under its replays.
    Locking a locked conversation changes nothing."""
    await conversation_repository.lock(settings.DATABASE_PATH, conversation_id, "replay")


async def fork(settings: Settings, user: User, conversation_id: str, request: ForkRequest) -> ConversationView:
    """Copy a conversation (up to a message, or all of it) into a NEW conversation. Nothing is sent to a model.

    The copy spans three database files, so it is not one transaction: the messages and the fork's row in
    `conversation_forks` (app.db, one transaction) first, then the knowledge base choices (knowledgebase.db), then, last,
    the audit copy of the fork and the API-log rows (Log.db, append-only, written in a single transaction). If a later
    step fails, the earlier ones that can be undone are undone (the new conversation, its fork row and its choices are
    deleted), so a half-made fork never stays."""
    source = await _owned(settings, user, conversation_id)
    through_sequence: int | None = None
    if request.through_message_id is not None:
        visible = await message_repository.list_visible(settings.DATABASE_PATH, conversation_id)
        through = next((m for m in visible if m.message_id == request.through_message_id), None)
        if through is None:
            raise not_found("Message")
        through_sequence = through.sequence_number
    try:
        fork_, message_ids, fork_id = await conversation_repository.fork(
            settings.DATABASE_PATH,
            user.user_id,
            source,
            f"{source.name} (fork)"[:MAX_NAME_LENGTH],
            through_sequence,
        )
    except PromptInProgress:
        raise _prompt_in_progress() from None
    try:
        copied = await message_repository.list_visible(settings.DATABASE_PATH, fork_.conversation_id)
        await kb_choice_repository.copy_chat(
            settings.KNOWLEDGE_DB_PATH,
            user.user_id,
            source.conversation_id,
            fork_.conversation_id,
            [m.request_id for m in copied if m.role == "user" and m.request_id],
        )
        await chat_api_log_repository.copy_for_fork(
            settings.LOG_DB_PATH, user.user_id, source.conversation_id, fork_.conversation_id, message_ids, fork_id
        )
    except BaseException:
        await kb_choice_repository.delete_scope(
            settings.KNOWLEDGE_DB_PATH, user.user_id, "chat", [fork_.conversation_id]
        )
        await conversation_repository.undo_fork(settings.DATABASE_PATH, user.user_id, fork_.conversation_id)
        raise
    return await _view(settings, user, fork_)


async def delete(settings: Settings, user: User, conversation_id: str) -> None:
    """Delete a conversation. This cannot be undone. Its messages and knowledge base choices go with it; replays started from
    it keep their prompts and lose the link; fork rows and the append-only API log (Log.db) are left as they are, so a
    fork still shows where it came from and still shows the calls that produced the answers it copied. A locked
    conversation can be deleted too."""
    if not await conversation_repository.delete_one(settings.DATABASE_PATH, user.user_id, conversation_id):
        raise not_found("Conversation")
    await kb_choice_repository.delete_scope(settings.KNOWLEDGE_DB_PATH, user.user_id, "chat", [conversation_id])
