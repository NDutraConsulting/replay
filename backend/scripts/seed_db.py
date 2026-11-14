"""Build the databases and run every seeder, without starting the server.

Usage:
  uv run python scripts/seed_db.py

It does what the server does at startup, plus the knowledge bases the app would otherwise seed lazily:
  1. creates the database files and applies every migration (app.db, knowledgebase.db, Log.db, lessons.db)
  2. seeds the agents and the demo account (demo / DEMO_PASSWORD, default demo)
  3. seeds the demo user's knowledge base for every agent
  4. seeds the guided lessons

Idempotent: safe to run on an existing database (it only fills in what is missing). `./run-site.sh reset` runs
scripts/reset_db.py and then this, so a wiped install is fully built before the servers start.
"""

import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from config import settings  # noqa: E402
from db.connection import init_db  # noqa: E402
from errors import AppError  # noqa: E402
from services import knowledge_base_service, lesson_service, seed_service  # noqa: E402

DEMO_USERNAME = "demo"


async def seed() -> list[tuple[str, int]]:
    await seed_service.seed_all(settings)  # the agents and the demo account
    await lesson_service.seed(settings)
    return await knowledge_base_service.seed_for_user(settings, DEMO_USERNAME)


def main() -> int:
    applied = init_db(
        settings.DATABASE_PATH, settings.KNOWLEDGE_DB_PATH, settings.LOG_DB_PATH, settings.LESSONS_DB_PATH
    )
    print(
        f"Databases ready ({'migrations applied: ' + ', '.join(map(str, applied)) if applied else 'no new migrations'})."
    )
    try:
        knowledge = asyncio.run(seed())
    except AppError as exc:
        print(f"Error: {exc.message}", file=sys.stderr)
        return 1
    print("Guided lessons seeded.")
    print(f"Agents and the demo account seeded (login: {DEMO_USERNAME} / DEMO_PASSWORD, default demo).")
    for agent_id, categories in knowledge:
        print(f"Knowledge base seeded: {DEMO_USERNAME} / {agent_id}: {categories} categories")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
