from fastapi import UploadFile

from config import Settings
from models.knowledge_base import (
    CategoryView,
    CreateCategoryRequest,
    CreateDocumentRequest,
    CreateSubcategoryRequest,
    DocumentView,
    KnowledgeBaseTree,
    SubcategoryView,
    UpdateDocumentRequest,
    UploadResponse,
)
from models.user import User
from services import knowledge_base_service as service
from services.knowledge_base_service import UploadedFile


async def get_tree(settings: Settings, user: User, agent_id: str) -> KnowledgeBaseTree:
    return await service.get_tree(settings, user, agent_id)


async def reset(
    settings: Settings, user: User, agent_id: str, delete_conversations: bool | None = None
) -> KnowledgeBaseTree:
    return await service.reset(settings, user, agent_id, delete_conversations)


async def create_category(
    settings: Settings, user: User, agent_id: str, request: CreateCategoryRequest
) -> CategoryView:
    return await service.create_category(settings, user, agent_id, request)


async def delete_category(
    settings: Settings, user: User, category_id: str, delete_conversations: bool | None = None
) -> None:
    await service.delete_category(settings, user, category_id, delete_conversations)


async def create_subcategory(
    settings: Settings, user: User, category_id: str, request: CreateSubcategoryRequest
) -> SubcategoryView:
    return await service.create_subcategory(settings, user, category_id, request)


async def delete_subcategory(
    settings: Settings, user: User, subcategory_id: str, delete_conversations: bool | None = None
) -> None:
    await service.delete_subcategory(settings, user, subcategory_id, delete_conversations)


async def create_document(
    settings: Settings, user: User, subcategory_id: str, request: CreateDocumentRequest
) -> DocumentView:
    return await service.create_document(settings, user, subcategory_id, request)


async def upload_documents(
    settings: Settings, user: User, subcategory_id: str, files: list[UploadFile], status: str
) -> UploadResponse:
    """Reads each upload with a hard cap (one byte past the size limit) so an oversized file is never fully buffered."""
    uploaded = [
        UploadedFile(
            filename=file.filename or "untitled.txt",
            content_type=file.content_type or "",
            data=await file.read(settings.KB_MAX_DOCUMENT_BYTES + 1),
        )
        for file in files
    ]
    return await service.upload_documents(settings, user, subcategory_id, uploaded, status)


async def get_document(settings: Settings, user: User, document_id: str) -> DocumentView:
    return await service.get_document(settings, user, document_id)


async def update_document(
    settings: Settings, user: User, document_id: str, request: UpdateDocumentRequest
) -> DocumentView:
    return await service.update_document(settings, user, document_id, request)


async def delete_document(
    settings: Settings, user: User, document_id: str, delete_conversations: bool | None = None
) -> None:
    await service.delete_document(settings, user, document_id, delete_conversations)
