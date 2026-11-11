"""Default knowledge bases, loaded from db/kb_seeds/knowledge_bases.json.

Shape: {agent_id: [{name, subcategories: [{name, documents: [{title, status, content}]}]}]}
Each user gets a copy per agent the first time they read it (see services/knowledge_base_service.py).
"""

import json
from functools import cache
from pathlib import Path

_SEED_FILE = Path(__file__).parent / "kb_seeds" / "knowledge_bases.json"


@cache
def _load() -> dict[str, list[dict]]:
    return json.loads(_SEED_FILE.read_text(encoding="utf-8"))


def categories_for(agent_id: str) -> list[dict]:
    return _load().get(agent_id, [])
