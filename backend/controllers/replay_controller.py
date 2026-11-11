from config import Settings
from models.common import StopResponse
from models.replay_run import (
    ApiLog,
    CreateReplayRunRequest,
    ReplayRunView,
    SavedLogprobs,
    SavedReplay,
    SavedReplaySummary,
    StepRequest,
    UpdateReplayRunRequest,
)
from models.user import User
from services import replay_service as service


async def create(settings: Settings, user: User, request: CreateReplayRunRequest) -> ReplayRunView:
    return await service.create(settings, user, request)


async def current(settings: Settings, user: User) -> ReplayRunView:
    return await service.current(settings, user)


async def update(settings: Settings, user: User, run_id: str, request: UpdateReplayRunRequest) -> ReplayRunView:
    return await service.update(settings, user, run_id, request)


async def step(settings: Settings, user: User, run_id: str, request: StepRequest) -> ReplayRunView:
    return await service.step(settings, user, run_id, request)


async def stop(settings: Settings, user: User, run_id: str, request_id: str | None = None) -> StopResponse:
    return await service.stop(settings, user, run_id, request_id)


async def save(settings: Settings, user: User, run_id: str) -> ReplayRunView:
    return await service.save(settings, user, run_id)


async def list_saved(settings: Settings, user: User) -> list[SavedReplaySummary]:
    return await service.list_saved(settings, user)


async def get_logprobs(settings: Settings, user: User, saved_id: str) -> SavedLogprobs:
    return await service.get_logprobs(settings, user, saved_id)


async def get_api_log(settings: Settings, user: User, saved_id: str) -> ApiLog:
    return await service.get_api_log(settings, user, saved_id)


async def get_saved(settings: Settings, user: User, saved_id: str) -> SavedReplay:
    return await service.get_saved(settings, user, saved_id)
