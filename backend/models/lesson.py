from typing import Literal

from pydantic import BaseModel

LessonStatus = Literal["in_progress", "completed", "skipped"]
"""A lesson a user has not started has no progress row; the API reports that as `not_started`."""
ListedStatus = Literal["not_started", "in_progress", "completed", "skipped"]


class LessonAvatar(BaseModel):
    avatar_slug: str
    file: str
    alt: str
    facing: str


class LessonStep(BaseModel):
    position: int
    title: str
    body: str
    target: str | None
    action: str
    action_arg: str | None
    on_next: str
    on_target_gone: str
    advance_on: str | None = None
    placement: str
    avatar: LessonAvatar


class LessonProgress(BaseModel):
    status: ListedStatus = "not_started"
    current_step: int = 0


class LessonSummary(BaseModel):
    slug: str
    page: str
    title: str
    summary: str
    step_count: int
    progress: LessonProgress


class LessonDetail(BaseModel):
    slug: str
    page: str
    title: str
    summary: str
    version: int
    steps: list[LessonStep]
    progress: LessonProgress


class ProgressUpdate(BaseModel):
    step: int
    status: LessonStatus = "in_progress"
