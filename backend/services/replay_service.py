"""Replay runs: the same prompts stepped through two models (slots A and B) and saved for comparison.

A step runs the next prompt on BOTH slots concurrently and is all-or-nothing: results are stored and the
cursor advances in one transaction, only if both calls succeed and no stop was requested meanwhile.

A run has one KB-summary-tool switch for both slots (set before it starts, fixed after): off, each slot is sent the whole
chosen file; on, each slot's own model first writes a summary of the file and that is sent instead. The summary is saved
on the slot's result so the Diff can show what each model was handed.
"""

import asyncio
import logging
from dataclasses import dataclass

from config import Settings
from errors import conflict, not_found, validation_error
from models.common import StopResponse
from models.conversation import Conversation
from models.decision import DecisionStep
from models.replay_run import (
    SLOTS,
    ApiCall,
    ApiLog,
    ApiLogTurn,
    CreateReplayRunRequest,
    ReplayResult,
    ReplayRun,
    ReplayRunView,
    SavedLogprobs,
    SavedLogprobsTurn,
    SavedReplay,
    SavedReplaySummary,
    Slot,
    StepRequest,
    UpdateReplayRunRequest,
)
from models.user import User
from repositories import (
    api_log_repository,
    chat_record_repository,
    conversation_repository,
    kb_choice_repository,
    kb_repository,
    message_repository,
    replay_run_repository,
)
from services import (
    conversation_service,
    demo_response_service,
    history_service,
    kb_routing_service,
    llm_service,
    settings_service,
    summary_service,
)
from services.history_service import Attachment, Turn

logger = logging.getLogger(__name__)

DEFAULT_REPLAY_REASONING = "none"
"""The reasoning level a new replay starts with (the chat's own level is only shown, not copied)."""


def _stale_seconds(settings: Settings) -> float:
    """A step running longer than two provider timeouts (plus slack) is treated as dead."""
    return settings.LLM_TIMEOUT_SECONDS * 2 + 30


def _view(settings: Settings, run: ReplayRun, results: list[ReplayResult]) -> ReplayRunView:
    cutoff = replay_run_repository.stale_cutoff(_stale_seconds(settings))
    running = run.step_started_at is not None and run.step_started_at.isoformat() > cutoff
    grouped: dict[Slot, list[ReplayResult]] = {"a": [], "b": []}
    for result in results:
        grouped[result.slot].append(result)
    return ReplayRunView(
        replay_run_id=run.replay_run_id,
        agent_id=run.agent_id,
        prompts=run.prompts,
        model_a=run.model_a,
        model_b=run.model_b,
        kb_summary_tool=run.kb_summary_tool,
        reasoning_level=run.reasoning_level,
        temperature=run.temperature,
        logprobs=run.logprobs,
        brief_replies=run.brief_replies,
        context_summary=run.context_summary,
        source_conversation_id=run.source_conversation_id,
        cursor=run.cursor,
        step_running=running,
        saved_at=run.saved_at,
        created_at=run.created_at,
        updated_at=run.updated_at,
        results=grouped,
    )


async def _owned(settings: Settings, user: User, run_id: str) -> ReplayRun:
    run = await replay_run_repository.get_owned(settings.DATABASE_PATH, user.user_id, run_id)
    if run is None:
        raise not_found("Replay run")
    return run


async def _results_with_traces(settings: Settings, run: ReplayRun) -> list[ReplayResult]:
    """The run's results, each with the knowledge-base choices recorded for it (keyed by slot and turn)."""
    results = await replay_run_repository.list_results(settings.DATABASE_PATH, run.replay_run_id)
    traces = await kb_choice_repository.trace_for_replay(settings.KNOWLEDGE_DB_PATH, run.user_id, run.replay_run_id)
    if not traces:
        return results
    out: list[ReplayResult] = []
    for r in results:
        steps = [DecisionStep(**s) for s in traces.get((r.slot, r.turn_index), [])]
        if steps:
            r = r.model_copy(
                update={"decision_trace": steps, "kb_version_deleted": any(s.kb_version_deleted for s in steps)}
            )
        out.append(r)
    return out


async def _full_view(settings: Settings, run: ReplayRun) -> ReplayRunView:
    return _view(settings, run, await _results_with_traces(settings, run))


def build_turns(
    prompts: list[str], results: list[ReplayResult], index: int, attachments: dict[int, list[Attachment]] | None = None
) -> list[Turn]:
    """What one slot is sent for turn `index`: the user prompts so far plus ONLY that slot's own earlier successful
    responses (results never cross between the two slots), each earlier turn with the file that slot was given."""
    by_turn = {r.turn_index: r for r in results}
    turns: list[Turn] = []
    for turn in range(index + 1):
        item = Turn(prompts[turn], attachments=list((attachments or {}).get(turn, [])))
        previous = by_turn.get(turn)
        if turn < index and previous is not None and not previous.error:
            item.assistant = previous.content
        turns.append(item)
    return turns


async def _earlier_attachments(
    settings: Settings, run: ReplayRun, slot: Slot, results: list[ReplayResult], traces: dict
) -> dict[int, list[Attachment]]:
    """The file each of this slot's committed earlier turns was answered with, rebuilt from what was recorded: the
    version the agent chose (its text is read now) or, with the switch on, the summary saved on the result."""
    chosen: dict[int, tuple[str, str, str, str]] = {}
    for result in results:
        steps = traces.get((slot, result.turn_index)) or []
        if len(steps) == 3 and steps[2]["outcome"] == "chosen" and steps[2].get("version_id"):
            names = [steps[0]["chosen"]["name"], steps[1]["chosen"]["name"], steps[2]["chosen"]["name"]]
            chosen[result.turn_index] = (*names, steps[2]["version_id"])
    versions = (
        {}
        if run.kb_summary_tool
        else await kb_repository.get_versions(settings.KNOWLEDGE_DB_PATH, [c[3] for c in chosen.values()])
    )
    by_turn = {r.turn_index: r for r in results}
    out: dict[int, list[Attachment]] = {}
    for turn, (category, subcategory, title, version_id) in chosen.items():
        label = f"{category} / {subcategory} / {title}"
        if run.kb_summary_tool:
            summary = by_turn[turn].kb_summary
            if summary:
                out[turn] = [Attachment("summary", label, text=summary)]
        else:
            version = versions.get(version_id)
            text = version.content if version else None
            out[turn] = [Attachment("reference", label, (category, subcategory, title), text=text)]
    return out


def _check_model(provider: settings_service.Provider, model: str) -> None:
    if not settings_service.model_known(provider.models, model):
        raise validation_error(f"Unknown model: {model}.")


@dataclass
class _Source:
    prompts: list[str]
    conversation: Conversation | None = None
    source_conversation_id: str | None = None
    context_summary: str | None = None
    """The compacted summary a summary-first conversation began with (a replay of it starts from there)."""


async def _source_for(settings: Settings, user: User, request: CreateReplayRunRequest) -> _Source:
    sources = [s for s in (request.prompts, request.conversation_id, request.chat_record_id) if s is not None]
    if len(sources) > 1:
        raise validation_error("Give only one of prompts, conversation_id or chat_record_id.")
    if request.prompts is not None:
        prompts = [p.strip() for p in request.prompts]
        if any(not p for p in prompts) or any(len(p) > 8000 for p in prompts):
            raise validation_error("Prompts must be non-empty and at most 8000 characters.")
        if len(prompts) > settings.MAX_USER_PROMPTS:
            raise validation_error(f"A replay can have at most {settings.MAX_USER_PROMPTS} prompts.")
        source_chat = None
        if request.source_conversation_id is not None:  # Reset keeps the run tied to its chat
            owned = await conversation_repository.get_owned(
                settings.DATABASE_PATH, user.user_id, request.source_conversation_id
            )
            source_chat = owned.conversation_id if owned else None
        return _Source(prompts, source_conversation_id=source_chat)
    if request.chat_record_id is not None:
        record = await chat_record_repository.get_owned(settings.DATABASE_PATH, user.user_id, request.chat_record_id)
        if record is None:
            raise not_found("Chat record")
        return _Source(list(record.prompts)[: settings.MAX_USER_PROMPTS])
    if request.conversation_id is not None:
        conversation = await conversation_repository.get_owned(
            settings.DATABASE_PATH, user.user_id, request.conversation_id
        )
        if conversation is None:
            raise not_found("Conversation")
    else:
        conversation = await conversation_repository.get_latest(settings.DATABASE_PATH, user.user_id)
        if conversation is None:
            return _Source([])
    prompts = (await message_repository.user_prompts(settings.DATABASE_PATH, conversation.conversation_id))[
        : settings.MAX_USER_PROMPTS
    ]  # a longer (older) chat is replayed from its first prompts
    visible = await message_repository.list_visible(settings.DATABASE_PATH, conversation.conversation_id)
    summary = next((m.content for m in visible if m.message_type == "compacted_summary"), None)
    return _Source(prompts, conversation, conversation.conversation_id, summary)


async def create(settings: Settings, user: User, request: CreateReplayRunRequest) -> ReplayRunView:
    """Start a new run ("Load current chat", "Replay" on a record, "Reset"). A previous run that has
    results is saved automatically.

    A run started from a conversation begins from that conversation's settings: its agent, its model in slot A (slot B
    is free), its reasoning level and its KB-summary-tool switch. The user may change any of them before the first step."""
    source = await _source_for(settings, user, request)
    conversation = source.conversation
    provider = await settings_service.get_provider(settings, user)
    default_a = (
        conversation.model
        if conversation is not None and settings_service.model_known(provider.models, conversation.model)
        else provider.models[0]
    )
    model_a = request.model_a or default_a
    # slot B starts as the first model that is not slot A's (the user may still pick the same model in both)
    default_b = next((m for m in provider.models if m != model_a), model_a)
    model_b = request.model_b or default_b
    _check_model(provider, model_a)
    _check_model(provider, model_b)
    agent_id = (
        request.agent_id
        or (conversation.agent_id if conversation is not None and conversation.agent_id else None)
        or (await settings_service.get_preferences(settings, user)).agent_id
    )
    await settings_service.require_agent(settings, agent_id)
    kb_summary_tool = (
        request.kb_summary_tool
        if request.kb_summary_tool is not None
        else (conversation.kb_summary_tool if conversation is not None else False)
    )
    # a replay starts with reasoning off ("none") whatever its chat used, so the models are compared without it; the
    # Config popup (or the request) can change it before the first step
    reasoning_level = request.reasoning_level or DEFAULT_REPLAY_REASONING
    temperature = (
        request.temperature
        if request.temperature is not None
        else (conversation.temperature if conversation is not None else 0.0)
    )
    brief_replies = (
        request.brief_replies
        if request.brief_replies is not None
        else (conversation.brief_replies if conversation is not None else False)
    )
    run = await replay_run_repository.create(
        settings.DATABASE_PATH,
        user.user_id,
        agent_id,
        source.prompts,
        model_a,
        model_b,
        kb_summary_tool,
        reasoning_level,
        source.context_summary,
        source.source_conversation_id,
        temperature,
        bool(request.logprobs),
        brief_replies,
    )
    return await _full_view(settings, run)


async def current(settings: Settings, user: User) -> ReplayRunView:
    run = await replay_run_repository.get_latest(settings.DATABASE_PATH, user.user_id)
    if run is None:
        raise not_found("Replay run")
    return await _full_view(settings, run)


async def update(settings: Settings, user: User, run_id: str, request: UpdateReplayRunRequest) -> ReplayRunView:
    run = await _owned(settings, user, run_id)
    view = await _full_view(settings, run)
    if run.cursor > 0 or view.step_running:
        raise conflict(
            "replay_locked",
            "Models, agent, reasoning level and the KB-summary-tool switch are locked once a replay has started. "
            "Reset to change them.",
        )
    provider = await settings_service.get_provider(settings, user)
    model_a, model_b = request.model_a or run.model_a, request.model_b or run.model_b
    _check_model(provider, model_a)
    _check_model(provider, model_b)
    agent_id = request.agent_id or run.agent_id
    await settings_service.require_agent(settings, agent_id)
    await replay_run_repository.update_config(
        settings.DATABASE_PATH,
        run_id,
        model_a,
        model_b,
        agent_id,
        run.kb_summary_tool if request.kb_summary_tool is None else request.kb_summary_tool,
        request.reasoning_level or run.reasoning_level,
        run.temperature if request.temperature is None else request.temperature,
        run.logprobs if request.logprobs is None else request.logprobs,
        run.brief_replies if request.brief_replies is None else request.brief_replies,
    )
    return await _full_view(settings, await _owned(settings, user, run_id))


async def _reply_for_slot(
    settings: Settings,
    user: User,
    run: ReplayRun,
    agent,
    slot: Slot,
    model: str,
    turns: list[Turn],
    previous: list[dict] | None,
) -> dict:
    """`_answer_slot`, plus every raw REST call it made to the provider (kept with the result, for the API log). Each slot
    is served by the API its own model belongs to, so A and B can be on different APIs."""
    provider = await settings_service.get_provider(settings, user, model)
    with llm_service.collect_calls() as calls:
        outcome = await _answer_slot(settings, user, run, provider, agent, slot, model, turns, previous)
    outcome["api_calls"] = list(calls)
    return outcome


async def _answer_slot(
    settings: Settings,
    user: User,
    run: ReplayRun,
    provider: settings_service.Provider,
    agent,
    slot: Slot,
    model: str,
    turns: list[Turn],
    previous: list[dict] | None,
) -> dict:
    """One slot's answer to the current prompt (the last of `turns`). The slot walks the agent's knowledge base with ITS
    OWN model (so two models, or the same model on different hardware, can route differently), then answers with the
    chosen file: its whole text, or, when the run's KB-summary-tool switch is on, a summary that SAME model writes first.
    The steps are returned, not recorded: they are recorded only once the whole step has committed."""
    routing = await kb_routing_service.route(
        settings,
        user,
        agent.agent_id,
        provider,
        provider.model,
        turns[-1].user,
        previous,
        reasoning_effort=summary_service.effort(run.reasoning_level),
        temperature=run.temperature,
        logprobs=run.logprobs,
    )
    document = routing.document
    kb_summary: str | None = None
    if document is not None and document.version_id:
        if run.kb_summary_tool:
            kb_summary = await summary_service.summarize_document(
                settings,
                provider,
                provider.model,
                history_service.transcript(turns, run.context_summary),
                document.label,
                document.content,
                run.reasoning_level,
                run.temperature,
                run.logprobs,
            )
            turns[-1].attachments.append(Attachment("summary", document.label, text=kb_summary))
        else:
            parts = (document.category, document.subcategory, document.title)
            turns[-1].attachments.append(Attachment("reference", document.label, parts, text=document.content))
    if provider.connected:
        content = await llm_service.complete(
            base_url=provider.base_url,
            api_key=provider.api_key,
            model=provider.model,
            system=agent.system_prompt,
            messages=history_service.render(turns, run.context_summary, brief=run.brief_replies),
            timeout=settings.LLM_TIMEOUT_SECONDS,
            block_private=settings.BLOCK_PRIVATE_LLM_URLS,
            reasoning_effort=summary_service.effort(run.reasoning_level),
            temperature=run.temperature,
            logprobs=run.logprobs,
        )
    else:
        if settings.DEMO_DELAY_SECONDS > 0:
            await asyncio.sleep(settings.DEMO_DELAY_SECONDS)
        content = demo_response_service.demo_response(
            history_service.render(turns, None, with_attachments=False),
            model,
            agent.agent_id,
            provider.models,
            source=kb_routing_service.demo_source(routing),
        )
    return {
        "slot": slot,
        "content": content,
        "model": model,
        "demo": not provider.connected,
        "steps": routing.steps,
        "kb_summary": kb_summary,
    }


async def step(settings: Settings, user: User, run_id: str, request: StepRequest) -> ReplayRunView:
    run = await _owned(settings, user, run_id)
    cutoff = replay_run_repository.stale_cutoff(_stale_seconds(settings))
    claim = await replay_run_repository.claim_step(
        settings.DATABASE_PATH, run_id, request.expected_cursor, cutoff, request.request_id
    )
    if claim == "stale":
        raise conflict("stale_cursor", "This replay has moved on. Reload it and try again.")
    if claim == "complete":
        raise conflict("replay_complete", "This replay is already complete.")
    if claim == "stopped":
        raise conflict("stopped", "Playback stopped. Resume from this prompt.")
    if claim == "busy":
        raise conflict("step_in_progress", "A step is already running for this replay.")

    try:
        if run.cursor == 0 and run.source_conversation_id:
            # the first step of a replay of a conversation locks that conversation, so the source can no longer change
            # under its replays. It is after the claim (a stale, stopped or busy step never locks) and before any model
            # call; if it fails the step fails and the claim is released below.
            await conversation_service.lock_for_replay(settings, user, run.source_conversation_id)
        agent = await settings_service.require_agent(settings, run.agent_id)
        existing = await replay_run_repository.list_results(settings.DATABASE_PATH, run_id)
        traces = await kb_choice_repository.trace_for_replay(settings.KNOWLEDGE_DB_PATH, user.user_id, run_id)
        models = {"a": run.model_a, "b": run.model_b}
        earlier = {}
        for slot in SLOTS:
            mine = [r for r in existing if r.slot == slot]
            earlier[slot] = (mine, await _earlier_attachments(settings, run, slot, mine, traces))
        # what each slot chose on its earlier turns (committed ones only) is shown to it as a hint
        previous = {
            slot: await kb_choice_repository.last_replay_path(settings.KNOWLEDGE_DB_PATH, user.user_id, run_id, slot)
            for slot in SLOTS
        }
        outcomes = await asyncio.gather(
            *(
                _reply_for_slot(
                    settings,
                    user,
                    run,
                    agent,
                    slot,
                    models[slot],
                    build_turns(run.prompts, earlier[slot][0], run.cursor, earlier[slot][1]),
                    previous[slot],
                )
                for slot in SLOTS
            ),
            return_exceptions=True,
        )
        failures = [o for o in outcomes if isinstance(o, BaseException)]
        if failures:
            raise failures[0]
        committed = await replay_run_repository.commit_step(settings.DATABASE_PATH, run_id, run.cursor, list(outcomes))
    except BaseException:
        await replay_run_repository.release_step(settings.DATABASE_PATH, run_id)
        raise
    if committed == "stopped":
        raise conflict("stopped", "Playback stopped. Resume from this prompt.")
    for item in outcomes:  # the step is committed: keep the raw REST calls behind each slot's answer (Log.db)
        try:
            await api_log_repository.record_turn(
                settings.LOG_DB_PATH, user.user_id, run_id, item["slot"], run.cursor, item.get("api_calls") or []
            )
        except Exception:  # a missing log must not fail a step that is already saved
            logger.exception("Could not log the API calls for %s:%s", run_id, item["slot"])
    for item in outcomes:  # ...and what each slot was offered and chose in the knowledge base
        if not item["steps"]:
            continue
        try:
            await kb_choice_repository.record_path(
                settings.KNOWLEDGE_DB_PATH,
                user.user_id,
                run.agent_id,
                "replay",
                run_id,
                f"{item['slot']}:{run.cursor}",
                item["steps"],
            )
        except Exception:  # the results are already saved; a missing trace must not fail the step
            logger.exception("Could not record the knowledge-base choices for %s:%s", run_id, item["slot"])
    return await _full_view(settings, await _owned(settings, user, run_id))


async def stop(settings: Settings, user: User, run_id: str, request_id: str | None = None) -> StopResponse:
    await _owned(settings, user, run_id)
    cutoff = replay_run_repository.stale_cutoff(_stale_seconds(settings))
    return StopResponse(
        stopped=await replay_run_repository.request_stop(settings.DATABASE_PATH, run_id, cutoff, request_id)
    )


async def save(settings: Settings, user: User, run_id: str) -> ReplayRunView:
    run = await _owned(settings, user, run_id)
    if not await replay_run_repository.save_if_has_results(settings.DATABASE_PATH, run_id):
        raise conflict("nothing_to_save", "Run at least one prompt before saving.")
    return await _full_view(settings, await _owned(settings, user, run.replay_run_id))


# ---- saved replays (derived views of saved runs, one per slot that has results)
def _summary(run: ReplayRun, slot: Slot, response_count: int) -> SavedReplaySummary:
    return SavedReplaySummary(
        id=f"{run.replay_run_id}:{slot}",
        replay_run_id=run.replay_run_id,
        slot=slot,
        model=run.model_a if slot == "a" else run.model_b,
        agent_id=run.agent_id,
        completed=run.cursor == len(run.prompts),
        kb_summary_tool=run.kb_summary_tool,
        reasoning_level=run.reasoning_level,
        temperature=run.temperature,
        logprobs=run.logprobs,
        brief_replies=run.brief_replies,
        source_conversation_id=run.source_conversation_id,
        prompt_count=len(run.prompts),
        response_count=response_count,
        created_at=run.saved_at,
    )


async def list_saved(settings: Settings, user: User) -> list[SavedReplaySummary]:
    saved = await replay_run_repository.list_saved(settings.DATABASE_PATH, user.user_id)
    return [_summary(run, slot, counts[slot]) for run, counts in saved for slot in SLOTS if counts.get(slot, 0) > 0]


async def get_api_log(settings: Settings, user: User, saved_id: str) -> ApiLog:
    """The raw REST calls (URL, request, response) behind one saved replay, turn by turn, for the Replay page's API log.
    The key is never in them. A replay saved before calls were kept has `recorded` false; demo mode has none to show.
    They are read from Log.db (a separate file from app.db)."""
    saved = await get_saved(settings, user, saved_id)  # also checks it is the user's and is saved
    run_id, _, slot = saved_id.rpartition(":")
    logged = await api_log_repository.turns_for(settings.LOG_DB_PATH, user.user_id, run_id, slot)
    turns = [
        ApiLogTurn(
            turn_index=response.turn_index,
            prompt=saved.prompts[response.turn_index] if response.turn_index < len(saved.prompts) else "",
            calls=[ApiCall(**call) for call in logged.get(response.turn_index, [])],
        )
        for response in saved.responses
    ]
    return ApiLog(
        id=saved.id,
        recorded=bool(logged),
        model=saved.model,
        temperature=saved.temperature,
        logprobs=saved.logprobs,
        reasoning_level=saved.reasoning_level,
        turns=turns,
    )


async def get_logprobs(settings: Settings, user: User, saved_id: str) -> SavedLogprobs:
    """The answer tokens' log probabilities of one saved replay, turn by turn (the Diff page marks the cliffs in them).
    They are read from Log.db, where each answer call kept them as it was made."""
    saved = await get_saved(settings, user, saved_id)
    run_id, _, slot = saved_id.rpartition(":")
    logged = await api_log_repository.answer_logprobs(settings.LOG_DB_PATH, user.user_id, run_id, slot)
    turns = [
        SavedLogprobsTurn(turn_index=response.turn_index, tokens=logged.get(response.turn_index))
        for response in saved.responses
    ]
    return SavedLogprobs(id=saved.id, available=any(t.tokens for t in turns), turns=turns)


async def get_saved(settings: Settings, user: User, saved_id: str) -> SavedReplay:
    run_id, _, slot = saved_id.rpartition(":")
    run = await replay_run_repository.get_owned(settings.DATABASE_PATH, user.user_id, run_id) if run_id else None
    if run is None or run.saved_at is None or slot not in SLOTS:
        raise not_found("Saved replay")
    responses = [r for r in await _results_with_traces(settings, run) if r.slot == slot]
    if not responses:
        raise not_found("Saved replay")
    return SavedReplay(**_summary(run, slot, len(responses)).model_dump(), prompts=run.prompts, responses=responses)
