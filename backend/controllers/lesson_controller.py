"""Lessons: thin orchestration between the routes and lesson_service."""

from config import Settings
from models.lesson import LessonDetail, LessonProgress, LessonSummary, ProgressUpdate
from models.user import User
from services import lesson_service


async def list_lessons(settings: Settings, user: User) -> list[LessonSummary]:
    return await lesson_service.list_for_user(settings, user)


async def get_lesson(settings: Settings, user: User, slug: str) -> LessonDetail:
    return await lesson_service.get(settings, user, slug)


async def save_progress(settings: Settings, user: User, slug: str, update: ProgressUpdate) -> LessonProgress:
    return await lesson_service.save_progress(settings, user, slug, update)


async def restart(settings: Settings, user: User, slug: str) -> LessonProgress:
    return await lesson_service.restart(settings, user, slug)
