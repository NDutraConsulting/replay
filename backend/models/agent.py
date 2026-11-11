from pydantic import BaseModel


class Agent(BaseModel):
    agent_id: str
    name: str
    system_prompt: str
    """Server-side only; GET /api/agents never returns it."""


class AgentView(BaseModel):
    id: str
    name: str
