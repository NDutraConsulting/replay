"""Seed a user's knowledge base with the default content (db/kb_seeds/knowledge_bases.json).

Usage:
  uv run python scripts/seed_knowledge.py                        seed the demo user, every agent (idempotent)
  uv run python scripts/seed_knowledge.py --username alice       another user
  uv run python scripts/seed_knowledge.py --agent research       only one agent (repeat --agent for several)
  uv run python scripts/seed_knowledge.py --reset                REPLACE the chosen knowledge bases with the defaults

Without --reset an agent that is already seeded is left untouched, so it is safe to run any time. The app also seeds
each user lazily the first time they open an agent's knowledge base; this script is for development, demos and tests.
"""

import argparse
import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from config import settings  # noqa: E402
from errors import AppError  # noqa: E402
from services import knowledge_base_service  # noqa: E402


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--username", default="demo")
    parser.add_argument("--agent", action="append", dest="agents")
    parser.add_argument("--reset", action="store_true", help="replace the knowledge bases with the defaults")
    args = parser.parse_args(argv)
    try:
        results = asyncio.run(
            knowledge_base_service.seed_for_user(settings, args.username, args.agents, reset=args.reset)
        )
    except AppError as exc:
        print(f"Error: {exc.message}", file=sys.stderr)
        return 1
    verb = "reset to the defaults" if args.reset else "ready"
    for agent_id, categories in results:
        print(f"{args.username} / {agent_id}: {categories} categories ({verb})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
