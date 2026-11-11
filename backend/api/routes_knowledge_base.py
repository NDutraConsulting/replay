from fastapi import APIRouter, Depends, File, Form, Response, UploadFile

from api.deps import get_current_user
from config import Settings, get_settings
from controllers import knowledge_base_controller as controller
from models.knowledge_base import (
    DEFAULT_STATUS,
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

router = APIRouter()


@router.get("/api/agents/{agent_id}/knowledge-base", response_model=KnowledgeBaseTree)
async def get_knowledge_base(
    agent_id: str, settings: Settings = Depends(get_settings), user: User = Depends(get_current_user)
):
    return await controller.get_tree(settings, user, agent_id)


@router.post("/api/agents/{agent_id}/knowledge-base/reset", response_model=KnowledgeBaseTree)
async def reset_knowledge_base(
    agent_id: str,
    delete_conversations: bool | None = None,
    settings: Settings = Depends(get_settings),
    user: User = Depends(get_current_user),
):
    return await controller.reset(settings, user, agent_id, delete_conversations)


@router.post("/api/agents/{agent_id}/categories", response_model=CategoryView, status_code=201)
async def create_category(
    agent_id: str,
    request: CreateCategoryRequest,
    settings: Settings = Depends(get_settings),
    user: User = Depends(get_current_user),
):
    return await controller.create_category(settings, user, agent_id, request)


@router.delete("/api/categories/{category_id}", status_code=204)
async def delete_category(
    category_id: str,
    delete_conversations: bool | None = None,
    settings: Settings = Depends(get_settings),
    user: User = Depends(get_current_user),
):
    await controller.delete_category(settings, user, category_id, delete_conversations)
    return Response(status_code=204)


@router.post("/api/categories/{category_id}/subcategories", response_model=SubcategoryView, status_code=201)
async def create_subcategory(
    category_id: str,
    request: CreateSubcategoryRequest,
    settings: Settings = Depends(get_settings),
    user: User = Depends(get_current_user),
):
    return await controller.create_subcategory(settings, user, category_id, request)


@router.delete("/api/subcategories/{subcategory_id}", status_code=204)
async def delete_subcategory(
    subcategory_id: str,
    delete_conversations: bool | None = None,
    settings: Settings = Depends(get_settings),
    user: User = Depends(get_current_user),
):
    await controller.delete_subcategory(settings, user, subcategory_id, delete_conversations)
    return Response(status_code=204)


@router.post("/api/subcategories/{subcategory_id}/documents", response_model=DocumentView, status_code=201)
async def create_document(
    subcategory_id: str,
    request: CreateDocumentRequest,
    settings: Settings = Depends(get_settings),
    user: User = Depends(get_current_user),
):
    return await controller.create_document(settings, user, subcategory_id, request)


@router.post("/api/subcategories/{subcategory_id}/documents:upload", response_model=UploadResponse)
async def upload_documents(
    subcategory_id: str,
    files: list[UploadFile] = File(...),
    status: str = Form(DEFAULT_STATUS),
    settings: Settings = Depends(get_settings),
    user: User = Depends(get_current_user),
):
    return await controller.upload_documents(settings, user, subcategory_id, files, status)


@router.get("/api/documents/{document_id}", response_model=DocumentView)
async def get_document(
    document_id: str, settings: Settings = Depends(get_settings), user: User = Depends(get_current_user)
):
    return await controller.get_document(settings, user, document_id)


@router.patch("/api/documents/{document_id}", response_model=DocumentView)
async def update_document(
    document_id: str,
    request: UpdateDocumentRequest,
    settings: Settings = Depends(get_settings),
    user: User = Depends(get_current_user),
):
    return await controller.update_document(settings, user, document_id, request)


@router.delete("/api/documents/{document_id}", status_code=204)
async def delete_document(
    document_id: str,
    delete_conversations: bool | None = None,
    settings: Settings = Depends(get_settings),
    user: User = Depends(get_current_user),
):
    await controller.delete_document(settings, user, document_id, delete_conversations)
    return Response(status_code=204)
