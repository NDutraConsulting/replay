from datetime import datetime
from typing import Literal

from pydantic import BaseModel


class DecisionStep(BaseModel):
    """One level of the knowledge-base routing walk (category, then sub category, then file), as recorded in
    knowledge_base_choice: what the agent was offered and what it selected."""

    step: Literal["category", "subcategory", "file"]
    options: list[dict]
    """What the agent was offered: [{"id": ..., "name": ...}]"""
    chosen: dict | None = None
    """{"id", "name"} of the selection; None when the agent chose nothing (outcome none/invalid)."""
    model: str | None = None
    reason: str | None = None
    outcome: Literal["chosen", "none", "invalid"] = "chosen"
    """chosen: a valid selection. none: the agent said nothing is relevant. invalid: no usable choice after a retry."""
    at: datetime
    version_id: str | None = None
    """On a `file` step: the uuid of the version of the file whose text the agent was given (None on older records)."""
    version_number: int | None = None
    kb_version_deleted: bool = False
    """That version has since been deleted: the choice stays readable by name, the text is gone."""
