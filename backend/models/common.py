from pydantic import BaseModel


class StopResponse(BaseModel):
    stopped: bool
    """False when there was nothing to stop (safe to call repeatedly)."""
