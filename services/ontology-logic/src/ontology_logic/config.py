"""Configuration for the ontology-logic sidecar service.

Sections mirror the datalink_config.example.json style (server / api / llm)
but are simplified: every value is loaded from environment variables with
sane defaults — no JSON config file required.

Env vars:
    ONTOLOGY_LOGIC_HOST            REST bind host          (default 127.0.0.1)
    ONTOLOGY_LOGIC_PORT            REST bind port          (default 8901)
    ONTOLOGY_API_BASE_URL          apps/api callback base  (default http://127.0.0.1:8787)
    ONTOLOGY_SERVICE_TOKEN         Bearer token for callbacks (default "")
    ONTOLOGY_LOGIC_CALLBACK_TIMEOUT  Callback hard timeout s (default 5.0, D5 contract)
    ONTOLOGY_LOGIC_LLM_MODEL       Optional LLM model      (default "")
    ONTOLOGY_LOGIC_LLM_API_KEY     Optional LLM api key    (default "")
    ONTOLOGY_LOGIC_LLM_BASE_URL    Optional LLM base url   (default "")
    ONTOLOGY_LOGIC_MCP_HOST        MCP bind host           (default 127.0.0.1)
    ONTOLOGY_LOGIC_MCP_PORT        MCP bind port           (default 8902)
    ONTOLOGY_LOGIC_MCP_TRANSPORT   MCP transport           (default streamable-http)
"""

import os

from pydantic import BaseModel, Field


class ServerConfig(BaseModel):
    """REST API server (uvicorn) bind settings — localhost only by default."""

    host: str = Field(default="127.0.0.1", description="Bind host (service stays on loopback)")
    port: int = Field(default=8901, ge=1, le=65535, description="Bind port")


class ApiConfig(BaseModel):
    """Callback settings for data access against apps/api ontology routes.

    D5 contract: hard timeout, no retry — a failed callback raises
    RuntimeError instead of being retried.
    """

    api_base_url: str = Field(
        default="http://127.0.0.1:8787",
        description="apps/api base URL (ontology routes live under /api/v1/ontology/*)",
    )
    service_token: str = Field(default="", description="Bearer token sent on callback requests")
    callback_timeout_seconds: float = Field(
        default=5.0,
        gt=0,
        description="Hard timeout for HTTP callbacks (D5): fail fast, never retry",
    )


class LLMConfig(BaseModel):
    """Optional LLM section — empty by default so no LLM feature is enabled."""

    model: str = Field(default="", description="Model name (e.g. gpt-4o, deepseek-chat). Empty = disabled")
    api_key: str = Field(default="", description="API key for the OpenAI-compatible endpoint")
    base_url: str = Field(default="", description="API endpoint base URL (empty = provider default)")


class McpConfig(BaseModel):
    """MCP server bind settings (default: streamable-http on loopback)."""

    host: str = Field(default="127.0.0.1", description="MCP bind host")
    port: int = Field(default=8902, ge=1, le=65535, description="MCP bind port")
    transport: str = Field(
        default="streamable-http",
        description="MCP transport: 'streamable-http' (default) or 'stdio'",
    )


class OntologyLogicConfig(BaseModel):
    """Top-level ontology-logic configuration."""

    server: ServerConfig = Field(default_factory=ServerConfig, description="REST API server settings")
    api: ApiConfig = Field(default_factory=ApiConfig, description="apps/api callback settings")
    llm: LLMConfig = Field(default_factory=LLMConfig, description="Optional LLM settings")
    mcp: McpConfig = Field(default_factory=McpConfig, description="MCP server settings")

    @classmethod
    def from_env(cls) -> "OntologyLogicConfig":
        """Build a config from ONTOLOGY_* environment variables."""

        def _env(name: str) -> str:
            return os.environ.get(name, "").strip()

        return cls(
            server=ServerConfig(
                host=_env("ONTOLOGY_LOGIC_HOST") or ServerConfig().host,
                port=int(_env("ONTOLOGY_LOGIC_PORT") or ServerConfig().port),
            ),
            api=ApiConfig(
                api_base_url=_env("ONTOLOGY_API_BASE_URL") or ApiConfig().api_base_url,
                service_token=_env("ONTOLOGY_SERVICE_TOKEN"),
                callback_timeout_seconds=float(
                    _env("ONTOLOGY_LOGIC_CALLBACK_TIMEOUT") or ApiConfig().callback_timeout_seconds
                ),
            ),
            llm=LLMConfig(
                model=_env("ONTOLOGY_LOGIC_LLM_MODEL"),
                api_key=_env("ONTOLOGY_LOGIC_LLM_API_KEY"),
                base_url=_env("ONTOLOGY_LOGIC_LLM_BASE_URL"),
            ),
            mcp=McpConfig(
                host=_env("ONTOLOGY_LOGIC_MCP_HOST") or McpConfig().host,
                port=int(_env("ONTOLOGY_LOGIC_MCP_PORT") or McpConfig().port),
                transport=_env("ONTOLOGY_LOGIC_MCP_TRANSPORT") or McpConfig().transport,
            ),
        )
