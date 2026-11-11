from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

DocumentStatus = Literal["current", "pending-review", "malicious-active", "quarantined", "archived"]
DEFAULT_STATUS: DocumentStatus = "pending-review"
MAX_CONTENT_CHARS = 200_000


class Category(BaseModel):
    category_id: str
    user_id: str
    agent_id: str
    name: str
    created_at: datetime


class Subcategory(BaseModel):
    subcategory_id: str
    category_id: str
    name: str
    created_at: datetime


class KnowledgeDocument(BaseModel):
    document_id: str
    subcategory_id: str
    title: str
    content: str
    status: DocumentStatus
    created_at: datetime
    updated_at: datetime
    version_id: str | None = None
    """The uuid of the version that holds the file's current text."""
    version_number: int | None = None
    size_bytes: int = 0
    """UTF-8 size of the current text (the limit is KB_MAX_DOCUMENT_BYTES)."""


# ---- requests (emptiness/duplicates are checked in the service so the messages match the UI)
class CreateCategoryRequest(BaseModel):
    name: str = Field(max_length=200)


class CreateSubcategoryRequest(BaseModel):
    name: str = Field(max_length=200)


class CreateDocumentRequest(BaseModel):
    title: str = Field(max_length=200)
    content: str = Field(default="", max_length=MAX_CONTENT_CHARS)
    status: DocumentStatus = DEFAULT_STATUS


class UpdateDocumentRequest(BaseModel):
    title: str | None = Field(default=None, max_length=200)
    content: str | None = Field(default=None, max_length=MAX_CONTENT_CHARS)
    status: DocumentStatus | None = None


# ---- responses
class DocumentView(BaseModel):
    document_id: str
    subcategory_id: str
    title: str
    content: str
    status: DocumentStatus
    created_at: datetime
    updated_at: datetime
    version_id: str | None = None
    version_number: int | None = None
    size_bytes: int = 0


class SubcategoryView(BaseModel):
    subcategory_id: str
    name: str
    documents: list[DocumentView] = []


class CategoryView(BaseModel):
    category_id: str
    name: str
    subcategories: list[SubcategoryView] = []


class KnowledgeBaseTree(BaseModel):
    agent_id: str
    categories: list[CategoryView]


class UploadResult(BaseModel):
    filename: str
    ok: bool
    document: DocumentView | None = None
    error: str | None = None
    error_code: str | None = None
    """kb_document_too_large when the file is over the size limit (the page shows its "split it" popup)."""


class UploadResponse(BaseModel):
    results: list[UploadResult]
