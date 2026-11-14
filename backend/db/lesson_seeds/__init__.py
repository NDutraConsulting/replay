"""Lesson content that is checked into the code. `lesson_service.seed` upserts it into lessons.db on every start."""

from db.lesson_seeds.avatars import AVATARS
from db.lesson_seeds.chat_start_conversation import CHAT_START_CONVERSATION

LESSONS = [CHAT_START_CONVERSATION]

__all__ = ["AVATARS", "LESSONS"]
