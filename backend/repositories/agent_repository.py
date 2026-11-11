import sqlite3

from db.connection import run_in_db
from models.agent import Agent


def _row_to_agent(row: sqlite3.Row) -> Agent:
    return Agent(agent_id=row["agent_id"], name=row["name"], system_prompt=row["system_prompt"])


async def list_all(db_path: str) -> list[Agent]:
    def _list(conn: sqlite3.Connection) -> list[Agent]:
        return [_row_to_agent(r) for r in conn.execute("SELECT * FROM agents ORDER BY sort_order, agent_id")]

    return await run_in_db(db_path, _list)


async def get(db_path: str, agent_id: str) -> Agent | None:
    def _get(conn: sqlite3.Connection) -> Agent | None:
        row = conn.execute("SELECT * FROM agents WHERE agent_id = ?", (agent_id,)).fetchone()
        return _row_to_agent(row) if row else None

    return await run_in_db(db_path, _get)
