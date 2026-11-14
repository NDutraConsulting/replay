from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    DATABASE_PATH: str = "app.db"
    KNOWLEDGE_DB_PATH: str = "knowledgebase.db"
    """The knowledge base lives in its own SQLite file (categories, sub categories, files, and the routing choices)."""
    LOG_DB_PATH: str = "Log.db"
    """The raw API log (each REST call made to the model provider during a replay) lives in its own SQLite file."""
    LESSONS_DB_PATH: str = "lessons.db"
    """The guided lessons (content and each user's progress) live in their own SQLite file."""
    ENCRYPTION_KEY: str = ""
    """Fernet key for provider API keys (see services/crypto_service.py)."""
    OPENAI_API_KEY: str = ""
    """Optional. A server-wide OpenAI key, set by hand in .env. It appears on every account's Account page as one more API,
    labelled "OpenAI (server key)", next to the APIs the account added itself. It is read only there. Leave empty for none."""
    OPENAI_BASE_URL: str = "https://api.openai.com/v1"
    """The API URL used with OPENAI_API_KEY."""
    OPENAI_MODELS: str = (
        "gpt-6.1-sol,gpt-6.1-terra,gpt-6-luna,gpt-5.6-sol,gpt-5.6-terra,gpt-5.6-luna,gpt-5.5,gpt-5.4,gpt-5.4-mini"
    )
    """Comma-separated model IDs offered when OPENAI_API_KEY is used."""
    LOG_LEVEL: str = "INFO"
    LLM_TIMEOUT_SECONDS: float = 30.0
    COOKIE_SECURE: bool = False
    SESSION_MAX_AGE_DAYS: int = 30
    PASSWORD_HASH_ITERATIONS: int = 600_000
    DEMO_PASSWORD: str = "demo"
    DEMO_DELAY_SECONDS: float = 0.6
    """Pause before a canned demo reply, so the Stop button has something to stop."""
    BLOCK_PRIVATE_LLM_URLS: bool = False
    """Refuse provider URLs that resolve to private/loopback/link-local addresses (SSRF guard)."""
    MAX_UPLOAD_BYTES: int = 200 * 1024
    """Hard cap on how much of an upload is read (a guard, so a huge file is never buffered)."""
    KB_MAX_DOCUMENT_BYTES: int = 10 * 1024
    """A knowledge base file may hold at most this many UTF-8 bytes. The whole file is sent to a model, so a larger text
    must be split into smaller files (this tool has no semantic search over a vector database)."""
    MAX_USER_PROMPTS: int = Field(default=10, ge=1, le=200)
    """The most prompts one conversation may hold, and the most one replay may run. A chat that has reached it must start
    a new conversation; a replay of a longer chat uses its first prompts. Set it in .env."""
    KB_ROUTING_ENABLED: bool = True
    """When an agent answers, first walk its knowledge base (category > sub category > file) and use the chosen file.
    Costs up to three extra model calls per answer; switch off to answer without the knowledge base."""


settings = Settings()


def get_settings() -> Settings:
    return settings
