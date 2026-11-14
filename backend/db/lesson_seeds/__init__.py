"""Lesson content that is checked into the code. `lesson_service.seed` upserts it into lessons.db on every start."""

from db.lesson_seeds.avatars import AVATARS
from db.lesson_seeds.chat_start_conversation import CHAT_START_CONVERSATION
from db.lesson_seeds.replay_compare_models import REPLAY_COMPARE_MODELS

LESSONS = [CHAT_START_CONVERSATION, REPLAY_COMPARE_MODELS]

__all__ = ["AVATARS", "LESSONS"]
