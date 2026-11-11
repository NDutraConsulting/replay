"""Per-user knowledge bases: categories > sub categories > text files, each file with a review status.

Rules ported from the old browser implementation (agents-api.js): names are unique case-insensitively,
file names get ".txt" when they have no extension, new files default to "pending-review", uploads are
small text files only. A file holds at most 10 KB (KB_MAX_DOCUMENT_BYTES): the whole file is sent to a model.
"""

import re
from dataclasses import dataclass

from config import Settings
from db import seed_knowledge_bases
from errors import AppError, conflict, not_found, validation_error
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
    UploadResult,
)
from models.user import User
from repositories import (
    agent_repository,
    api_log_repository,
    conversation_repository,
    kb_choice_repository,
    kb_repository,
    message_repository,
    replay_run_repository,
    user_repository,
)
from repositories.kb_repository import DuplicateName

STATUSES = ("current", "pending-review", "malicious-active", "quarantined", "archived")
MAX_FILES_PER_UPLOAD = 20
_TEXT_NAME = re.compile(r"\.(txt|md|markdown|log|csv|json|ya?ml)$", re.IGNORECASE)
_HAS_EXTENSION = re.compile(r"\.[A-Za-z0-9]{1,5}$")


@dataclass
class UploadedFile:
    filename: str
    content_type: str
    data: bytes
    """At most KB_MAX_DOCUMENT_BYTES + 1 bytes: one byte over the limit is enough to reject the file."""


def normalize_title(title: str) -> str:
    """Slashes become dashes; ".txt" is appended when the name has no extension."""
    title = re.sub(r"[\\/]+", "-", title.strip())
    return title if not title or _HAS_EXTENSION.search(title) else title + ".txt"


def _check_status(status: str) -> None:
    if status not in STATUSES:
        raise validation_error("Unknown status.")


SPLIT_ADVICE = (
    "You need to split your content into smaller documents. Or if you want to customize this tool you could build a "
    "vector DB for semantic search. This tool does not currently support semantic search."
)


def too_large_message(settings: Settings, what: str = "This content") -> str:
    return f"{what} is larger than {settings.KB_MAX_DOCUMENT_BYTES // 1024} KB. {SPLIT_ADVICE}"


def _check_size(settings: Settings, content: str) -> None:
    """A file holds at most KB_MAX_DOCUMENT_BYTES of UTF-8. The whole file is sent to a model, so nothing is cut."""
    if len(content.encode()) > settings.KB_MAX_DOCUMENT_BYTES:
        raise AppError(422, "kb_document_too_large", too_large_message(settings))


def _document_view(doc) -> DocumentView:
    return DocumentView(**doc.model_dump())


async def _tree(settings: Settings, user: User, agent_id: str) -> KnowledgeBaseTree:
    categories = await kb_repository.get_tree(settings.KNOWLEDGE_DB_PATH, user.user_id, agent_id)
    return KnowledgeBaseTree(agent_id=agent_id, categories=categories)


async def _require_agent(settings: Settings, agent_id: str) -> None:
    if await agent_repository.get(settings.DATABASE_PATH, agent_id) is None:
        raise not_found("Agent")


async def ensure_seeded(settings: Settings, user: User, agent_id: str) -> None:
    """Every way into an agent's knowledge base seeds the defaults first (once), so new data never
    ends up beside an unseeded base that would be seeded later."""
    await _require_agent(settings, agent_id)
    await kb_repository.ensure_seeded(
        settings.KNOWLEDGE_DB_PATH, user.user_id, agent_id, seed_knowledge_bases.categories_for(agent_id)
    )


async def get_tree(settings: Settings, user: User, agent_id: str) -> KnowledgeBaseTree:
    await ensure_seeded(settings, user, agent_id)
    return await _tree(settings, user, agent_id)


async def reset(
    settings: Settings, user: User, agent_id: str, delete_conversations: bool | None = None
) -> KnowledgeBaseTree:
    """ "Restore defaults": replace this user's knowledge base for the agent with the seed data. Every file it held
    is deleted, so records that used one are settled first (see _settle_records_that_used)."""
    await _require_agent(settings, agent_id)
    await _settle_records_that_used(
        settings,
        user,
        await kb_repository.version_ids_for_agent(settings.KNOWLEDGE_DB_PATH, user.user_id, agent_id),
        delete_conversations,
    )
    await kb_repository.reset(
        settings.KNOWLEDGE_DB_PATH, user.user_id, agent_id, seed_knowledge_bases.categories_for(agent_id)
    )
    return await _tree(settings, user, agent_id)


async def seed_for_user(
    settings: Settings, username: str, agent_ids: list[str] | None = None, reset: bool = False
) -> list[tuple[str, int]]:
    """The seeder (used by scripts/seed_knowledge.py): seed a named user's knowledge base for the given agents
    (default: all). Idempotent: an agent that is already seeded is left alone. With `reset`, each is replaced with
    the defaults. Returns [(agent_id, number of categories)]."""
    user = await user_repository.get_by_username(settings.DATABASE_PATH, username)
    if user is None:
        raise not_found("User")
    known = [a.agent_id for a in await agent_repository.list_all(settings.DATABASE_PATH)]
    wanted = agent_ids or known
    unknown = [a for a in wanted if a not in known]
    if unknown:
        raise validation_error(f"Unknown agent: {', '.join(unknown)}. Known agents: {', '.join(known)}.")
    results: list[tuple[str, int]] = []
    for agent_id in wanted:
        data = seed_knowledge_bases.categories_for(agent_id)
        if reset:
            await kb_repository.reset(settings.KNOWLEDGE_DB_PATH, user.user_id, agent_id, data)
        else:
            await kb_repository.ensure_seeded(settings.KNOWLEDGE_DB_PATH, user.user_id, agent_id, data)
        tree = await kb_repository.get_tree(settings.KNOWLEDGE_DB_PATH, user.user_id, agent_id)
        results.append((agent_id, len(tree)))
    return results


# ---- categories
async def create_category(
    settings: Settings, user: User, agent_id: str, request: CreateCategoryRequest
) -> CategoryView:
    await ensure_seeded(settings, user, agent_id)
    name = request.name.strip()
    if not name:
        raise validation_error("Enter a category name.")
    try:
        category = await kb_repository.create_category(settings.KNOWLEDGE_DB_PATH, user.user_id, agent_id, name)
    except DuplicateName as exc:
        raise conflict("duplicate_name", f'A category named "{name}" already exists.') from exc
    return CategoryView(category_id=category.category_id, name=category.name, subcategories=[])


async def _settle_records_that_used(
    settings: Settings, user: User, version_ids: list[str], delete_conversations: bool | None
) -> None:
    """Deleting a file (or a sub category or category holding files) deletes their versions. Conversations and replays
    that were answered with those versions stay readable by name and are flagged "version deleted", but the user is asked
    first whether to delete those records too. The server cannot ask mid-request, so the first call answers 409 with the
    counts; the client asks and repeats the call with `delete_conversations` true or false. Either way the files go."""
    chats = await message_repository.conversations_using(settings.DATABASE_PATH, user.user_id, version_ids)
    replays = await replay_run_repository.runs_owned(
        settings.DATABASE_PATH,
        user.user_id,
        await kb_choice_repository.replay_runs_using(settings.KNOWLEDGE_DB_PATH, user.user_id, version_ids),
    )
    if not chats and not replays:
        return
    if delete_conversations is None:
        raise AppError(
            409,
            "kb_version_in_use",
            f"{len(chats)} conversation(s) and {len(replays)} replay(s) were answered with this. "
            "Deleting it flags them as using a deleted version. Delete those records too?",
            details={"conversations": len(chats), "replays": len(replays)},
        )
    if delete_conversations:
        await conversation_repository.delete_many(settings.DATABASE_PATH, user.user_id, chats)
        await kb_choice_repository.delete_scope(settings.KNOWLEDGE_DB_PATH, user.user_id, "chat", chats)
        await replay_run_repository.delete_many(settings.DATABASE_PATH, user.user_id, replays)
        await kb_choice_repository.delete_scope(settings.KNOWLEDGE_DB_PATH, user.user_id, "replay", replays)
        await api_log_repository.delete_runs(settings.LOG_DB_PATH, user.user_id, replays)


async def delete_category(
    settings: Settings, user: User, category_id: str, delete_conversations: bool | None = None
) -> None:
    if await kb_repository.get_category(settings.KNOWLEDGE_DB_PATH, user.user_id, category_id) is None:
        raise not_found("Category")
    versions = await kb_repository.version_ids_under(settings.KNOWLEDGE_DB_PATH, category_id=category_id)
    await _settle_records_that_used(settings, user, versions, delete_conversations)
    await kb_repository.delete_category(settings.KNOWLEDGE_DB_PATH, category_id)


# ---- sub categories
async def create_subcategory(
    settings: Settings, user: User, category_id: str, request: CreateSubcategoryRequest
) -> SubcategoryView:
    category = await kb_repository.get_category(settings.KNOWLEDGE_DB_PATH, user.user_id, category_id)
    if category is None:
        raise not_found("Category")
    name = request.name.strip()
    if not name:
        raise validation_error("Enter a sub category name.")
    try:
        sub = await kb_repository.create_subcategory(settings.KNOWLEDGE_DB_PATH, category_id, name)
    except DuplicateName as exc:
        raise conflict("duplicate_name", f'"{category.name}" already has a sub category named "{name}".') from exc
    return SubcategoryView(subcategory_id=sub.subcategory_id, name=sub.name, documents=[])


async def delete_subcategory(
    settings: Settings, user: User, subcategory_id: str, delete_conversations: bool | None = None
) -> None:
    if await kb_repository.get_subcategory(settings.KNOWLEDGE_DB_PATH, user.user_id, subcategory_id) is None:
        raise not_found("Sub category")
    versions = await kb_repository.version_ids_under(settings.KNOWLEDGE_DB_PATH, subcategory_id=subcategory_id)
    await _settle_records_that_used(settings, user, versions, delete_conversations)
    await kb_repository.delete_subcategory(settings.KNOWLEDGE_DB_PATH, subcategory_id)


# ---- documents
async def create_document(
    settings: Settings, user: User, subcategory_id: str, request: CreateDocumentRequest
) -> DocumentView:
    if await kb_repository.get_subcategory(settings.KNOWLEDGE_DB_PATH, user.user_id, subcategory_id) is None:
        raise not_found("Sub category")
    title = normalize_title(request.title)
    if not title:
        raise validation_error("Enter a file name.")
    _check_status(request.status)
    _check_size(settings, request.content)
    try:
        doc = await kb_repository.create_document(
            settings.KNOWLEDGE_DB_PATH, subcategory_id, title, request.content, request.status
        )
    except DuplicateName as exc:
        raise conflict("duplicate_name", f'"{title}" already exists in this sub category.') from exc
    return _document_view(doc)


def _check_upload(settings: Settings, file: UploadedFile) -> tuple[str, str | None] | None:
    """Returns (error message, error code), or None when the file is acceptable; also validates the decoded text."""
    if not _TEXT_NAME.search(file.filename) and not file.content_type.startswith("text/"):
        return f'"{file.filename}" is not a text file.', None
    if len(file.data) > settings.KB_MAX_DOCUMENT_BYTES:
        return too_large_message(settings, f'"{file.filename}"'), "kb_document_too_large"
    try:
        text = file.data.decode("utf-8")
    except UnicodeDecodeError:
        return f'"{file.filename}" is not valid UTF-8 text.', None
    if "\x00" in text:
        return f'"{file.filename}" is not a text file.', None
    return None


async def upload_documents(
    settings: Settings, user: User, subcategory_id: str, files: list[UploadedFile], status: str
) -> UploadResponse:
    if await kb_repository.get_subcategory(settings.KNOWLEDGE_DB_PATH, user.user_id, subcategory_id) is None:
        raise not_found("Sub category")
    _check_status(status)
    if not files:
        raise validation_error("Choose at least one file.")
    if len(files) > MAX_FILES_PER_UPLOAD:
        raise validation_error(f"Upload at most {MAX_FILES_PER_UPLOAD} files at a time.")
    results: list[UploadResult] = []
    for file in files:
        rejected = _check_upload(settings, file)
        if rejected:
            results.append(UploadResult(filename=file.filename, ok=False, error=rejected[0], error_code=rejected[1]))
            continue
        try:
            doc = await create_document(
                settings,
                user,
                subcategory_id,
                CreateDocumentRequest(title=file.filename, content=file.data.decode("utf-8"), status=status),
            )
        except AppError as exc:
            results.append(UploadResult(filename=file.filename, ok=False, error=exc.message, error_code=exc.code))
        else:
            results.append(UploadResult(filename=file.filename, ok=True, document=doc))
    return UploadResponse(results=results)


async def get_document(settings: Settings, user: User, document_id: str) -> DocumentView:
    found = await kb_repository.get_document(settings.KNOWLEDGE_DB_PATH, user.user_id, document_id)
    if found is None:
        raise not_found("Document")
    return _document_view(found[0])


async def update_document(
    settings: Settings, user: User, document_id: str, request: UpdateDocumentRequest
) -> DocumentView:
    found = await kb_repository.get_document(settings.KNOWLEDGE_DB_PATH, user.user_id, document_id)
    if found is None:
        raise not_found("Document")
    document = found[0]
    title = normalize_title(request.title) if request.title is not None else document.title
    content = request.content if request.content is not None else document.content
    status = request.status if request.status is not None else document.status
    if not title:
        raise validation_error("Enter a file name.")
    _check_status(status)
    _check_size(settings, content)
    try:
        await kb_repository.update_document(settings.KNOWLEDGE_DB_PATH, document_id, title, content, status)
    except DuplicateName as exc:
        raise conflict("duplicate_name", f'"{title}" already exists in this sub category.') from exc
    return await get_document(settings, user, document_id)


async def delete_document(
    settings: Settings, user: User, document_id: str, delete_conversations: bool | None = None
) -> None:
    if await kb_repository.get_document(settings.KNOWLEDGE_DB_PATH, user.user_id, document_id) is None:
        raise not_found("Document")
    versions = await kb_repository.version_ids_under(settings.KNOWLEDGE_DB_PATH, document_id=document_id)
    await _settle_records_that_used(settings, user, versions, delete_conversations)
    await kb_repository.delete_document(settings.KNOWLEDGE_DB_PATH, document_id)
