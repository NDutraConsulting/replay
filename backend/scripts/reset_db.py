"""Deletes the SQLite database files. Destructive and opt-in: requires --yes.

Usage:
  uv run python scripts/reset_db.py --yes                  delete app.db, knowledgebase.db AND Log.db
  uv run python scripts/reset_db.py --yes --only=app       only app.db (accounts, chats, replays, settings)
  uv run python scripts/reset_db.py --yes --only=knowledge only knowledgebase.db (the knowledge bases)
  uv run python scripts/reset_db.py --yes --only=log       only Log.db (the raw API log; nothing else depends on it)

The files are rebuilt (migrations + seeds) on the next server start. Resetting only app.db leaves knowledge base
rows and API logs for users that no longer exist, so the default deletes all three.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from config import settings  # noqa: E402


def main(argv: list[str]) -> int:
    if "--yes" not in argv:
        print("Refusing to delete the database without --yes.")
        return 2
    only = next((a.split("=", 1)[1] for a in argv if a.startswith("--only=")), "all")
    targets = {
        "app": [settings.DATABASE_PATH],
        "knowledge": [settings.KNOWLEDGE_DB_PATH],
        "log": [settings.LOG_DB_PATH],
    }
    targets["all"] = targets["app"] + targets["knowledge"] + targets["log"]
    if only not in targets:
        print(f"Unknown --only={only}. Use app, knowledge, log or leave it out for all three.")
        return 2
    for name in targets[only]:
        db_path = Path(name)
        for suffix in ("", "-journal", "-wal", "-shm"):
            Path(f"{db_path}{suffix}").unlink(missing_ok=True)
        print(f"Deleted {db_path} (and any WAL/journal files).")
    print("They will be rebuilt on the next start.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
