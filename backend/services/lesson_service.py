"""Guided lessons: content comes from db/lesson_seeds (upserted into lessons.db), progress is saved per user."""

import json

from config import Settings
from db.lesson_seeds import AVATARS, LESSONS
from errors import not_found, validation_error
from models.lesson import LessonDetail, LessonProgress, LessonSummary, ProgressUpdate
from models.user import User
from repositories import conversation_repository, lesson_repository
from services import settings_service


async def seed(settings: Settings) -> None:
    """Idempotent. Run at startup and by scripts/seed_db.py; also run when a lesson is missing (lessons.db was deleted)."""
    await lesson_repository.seed(settings.LESSONS_DB_PATH, AVATARS, LESSONS)


async def _ensure_sample(settings: Settings, user: User, slug: str, sample_json: str | None) -> None:
    """A lesson with a sample chat (its `sample_conversation`) puts it in the user's chat history: the lesson opens it from
    File > Open. It uses the user's saved model (or the first one they have), like a new chat does."""
    if not sample_json:
        return
    sample = json.loads(sample_json)
    preferences = await settings_service.get_preferences(settings, user)
    models = await settings_service.available_models(settings, user)
    await conversation_repository.ensure_lesson_sample(
        settings.DATABASE_PATH,
        user.user_id,
        f"lesson-{slug}-{user.user_id}",
        name=sample["name"],
        agent_id=sample["agent_id"],
        model=preferences.model if settings_service.model_known(models, preferences.model) else models[0],
        temperature=sample["temperature"],
        brief_replies=sample["brief_replies"],
        messages=sample["messages"],
    )


async def list_for_user(settings: Settings, user: User) -> list[LessonSummary]:
    rows = await lesson_repository.list_lessons(settings.LESSONS_DB_PATH, user.user_id)
    if not rows:  # the file was deleted under the running server and rebuilt empty
        await seed(settings)
        rows = await lesson_repository.list_lessons(settings.LESSONS_DB_PATH, user.user_id)
    for r in rows:
        await _ensure_sample(settings, user, r["slug"], r["sample_json"])
    return [
        LessonSummary(
            slug=r["slug"],
            page=r["page"],
            title=r["title"],
            summary=r["summary"],
            step_count=r["step_count"],
            progress=lesson_repository.progress_view(
                None
                if r["status"] is None
                else {"status": r["status"], "current_step": r["current_step"], "lesson_version": r["lesson_version"]},
                r["version"],
            ),
        )
        for r in rows
    ]


async def _load(settings: Settings, user: User, slug: str) -> dict:
    found = await lesson_repository.get_lesson(settings.LESSONS_DB_PATH, user.user_id, slug)
    if found is None:
        await seed(settings)  # a deleted-and-rebuilt lessons.db has no lessons yet
        found = await lesson_repository.get_lesson(settings.LESSONS_DB_PATH, user.user_id, slug)
    if found is None:
        raise not_found("Lesson")
    return found


async def get(settings: Settings, user: User, slug: str) -> LessonDetail:
    found = await _load(settings, user, slug)
    lesson = found["lesson"]
    await _ensure_sample(settings, user, slug, lesson["sample_json"])
    return LessonDetail(
        slug=lesson["slug"],
        page=lesson["page"],
        title=lesson["title"],
        summary=lesson["summary"],
        version=lesson["version"],
        steps=found["steps"],
        progress=lesson_repository.progress_view(found["progress"], lesson["version"]),
    )


async def save_progress(settings: Settings, user: User, slug: str, update: ProgressUpdate) -> LessonProgress:
    found = await _load(settings, user, slug)
    last = found["steps"][-1].position
    if not 0 <= update.step <= last:
        raise validation_error(f"step: must be from 0 to {last}.")
    current = lesson_repository.progress_view(found["progress"], found["lesson"]["version"])
    status = update.status
    if current.status == "completed" and status != "completed":
        return current  # completed is sticky; restart to go again
    await lesson_repository.put_progress(
        settings.LESSONS_DB_PATH, user.user_id, slug, found["lesson"]["version"], update.step, status
    )
    return LessonProgress(status=status, current_step=update.step)


async def restart(settings: Settings, user: User, slug: str) -> LessonProgress:
    await _load(settings, user, slug)
    await lesson_repository.delete_progress(settings.LESSONS_DB_PATH, user.user_id, slug)
    return LessonProgress()
