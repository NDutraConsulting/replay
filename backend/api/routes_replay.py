from fastapi import APIRouter, Depends

from api.deps import get_current_user
from config import Settings, get_settings
from controllers import replay_controller as controller
from models.common import StopResponse
from models.replay_run import (
    ApiLog,
    CreateReplayRunRequest,
    ReplayRunView,
    SavedLogprobs,
    SavedReplay,
    SavedReplaySummary,
    StepRequest,
    StopStepRequest,
    UpdateReplayRunRequest,
)
from models.user import User

router = APIRouter()


@router.post("/api/replay-runs", response_model=ReplayRunView, status_code=201)
async def create_run(
    request: CreateReplayRunRequest, settings: Settings = Depends(get_settings), user: User = Depends(get_current_user)
):
    return await controller.create(settings, user, request)


@router.get("/api/replay-runs/current", response_model=ReplayRunView)
async def current_run(settings: Settings = Depends(get_settings), user: User = Depends(get_current_user)):
    return await controller.current(settings, user)


@router.patch("/api/replay-runs/{run_id}", response_model=ReplayRunView)
async def update_run(
    run_id: str,
    request: UpdateReplayRunRequest,
    settings: Settings = Depends(get_settings),
    user: User = Depends(get_current_user),
):
    return await controller.update(settings, user, run_id, request)


@router.post("/api/replay-runs/{run_id}/steps", response_model=ReplayRunView)
async def step_run(
    run_id: str,
    request: StepRequest,
    settings: Settings = Depends(get_settings),
    user: User = Depends(get_current_user),
):
    return await controller.step(settings, user, run_id, request)


@router.post("/api/replay-runs/{run_id}/stop", response_model=StopResponse)
async def stop_run(
    run_id: str,
    request: StopStepRequest | None = None,
    settings: Settings = Depends(get_settings),
    user: User = Depends(get_current_user),
):
    return await controller.stop(settings, user, run_id, request.request_id if request else None)


@router.post("/api/replay-runs/{run_id}/save", response_model=ReplayRunView)
async def save_run(run_id: str, settings: Settings = Depends(get_settings), user: User = Depends(get_current_user)):
    return await controller.save(settings, user, run_id)


@router.get("/api/saved-replays", response_model=list[SavedReplaySummary])
async def list_saved(settings: Settings = Depends(get_settings), user: User = Depends(get_current_user)):
    return await controller.list_saved(settings, user)


@router.get("/api/saved-replays/{saved_id}/logprobs", response_model=SavedLogprobs)
async def get_logprobs(
    saved_id: str, settings: Settings = Depends(get_settings), user: User = Depends(get_current_user)
):
    return await controller.get_logprobs(settings, user, saved_id)


@router.get("/api/saved-replays/{saved_id}/api-log", response_model=ApiLog)
async def get_api_log(
    saved_id: str, settings: Settings = Depends(get_settings), user: User = Depends(get_current_user)
):
    return await controller.get_api_log(settings, user, saved_id)


@router.get("/api/saved-replays/{saved_id}", response_model=SavedReplay)
async def get_saved(saved_id: str, settings: Settings = Depends(get_settings), user: User = Depends(get_current_user)):
    return await controller.get_saved(settings, user, saved_id)
