"""The sample conversation a new user starts with (db/seeds/sample_conversation.json)."""

import json
from functools import cache
from pathlib import Path

_SEED_FILE = Path(__file__).parent / "seeds" / "sample_conversation.json"


@cache
def messages() -> list[dict]:
    """[{role, content, demo}] in order."""
    return json.loads(_SEED_FILE.read_text(encoding="utf-8"))
