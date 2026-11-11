"""Idempotent startup seeding (the database persists, so everything here is safe to repeat)."""

from pathlib import Path

from config import Settings
from controllers import account_controller
from db.connection import get_connection

_SEED_AGENTS = Path(__file__).parent.parent / "db" / "seed_agents.sql"


def seed_agents(db_path: str) -> None:
    conn = get_connection(db_path)
    try:
        conn.executescript(_SEED_AGENTS.read_text())
        conn.commit()
    finally:
        conn.close()


async def seed_all(settings: Settings) -> None:
    seed_agents(settings.DATABASE_PATH)
    await account_controller.ensure_demo_account(settings)
