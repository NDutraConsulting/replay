from fastapi import APIRouter, Depends

from api.deps import get_current_user
from config import Settings, get_settings
from controllers import lesson_controller
from models.lesson import LessonDetail, LessonProgress, LessonSummary, ProgressUpdate
from models.user import User

router = APIRouter()


@router.get("/api/lessons", response_model=list[LessonSummary])
async def list_lessons(settings: Settings = Depends(get_settings), user: User = Depends(get_current_user)):
    return await lesson_controller.list_lessons(settings, user)


@router.get("/api/lessons/{slug}", response_model=LessonDetail)
async def get_lesson(slug: str, settings: Settings = Depends(get_settings), user: User = Depends(get_current_user)):
    return await lesson_controller.get_lesson(settings, user, slug)


@router.put("/api/lessons/{slug}/progress", response_model=LessonProgress)
async def put_progress(
    slug: str,
    update: ProgressUpdate,
    settings: Settings = Depends(get_settings),
    user: User = Depends(get_current_user),
):
    return await lesson_controller.save_progress(settings, user, slug, update)


@router.post("/api/lessons/{slug}/restart", response_model=LessonProgress)
async def restart_lesson(slug: str, settings: Settings = Depends(get_settings), user: User = Depends(get_current_user)):
    return await lesson_controller.restart(settings, user, slug)
