"""Shared dependencies for ontology-logic REST API routes.

Same dependency-injection pattern as datalink's api/deps.py: a cached
config loader so every route sees the same effective configuration, plus
the service-level executor singleton wired once (承接项③) — sandbox +
apps/api HTTP callback client + fully assembled function registry.
"""

from functools import lru_cache

from ontology_logic.config import OntologyLogicConfig
from ontology_logic.core.callbacks import OntologyCallbackClient
from ontology_logic.core.executor import FunctionRuntimeExecutor, assemble_functions
from ontology_logic.core.sandbox import UnifiedSandbox


@lru_cache(maxsize=1)
def get_config() -> OntologyLogicConfig:
    """Load the process-wide configuration from environment variables."""
    return OntologyLogicConfig.from_env()


def reset_config() -> None:
    """Drop the cached config (used by tests and after env changes)."""
    get_config.cache_clear()


# 服务级单例（承接项③）：进程内唯一执行器。构造时一次性装配函数注册表
# （assemble_functions），MCP 工具层与 REST 面共享，均不在每次调用覆盖写。
_executor: FunctionRuntimeExecutor | None = None


def get_executor() -> FunctionRuntimeExecutor:
    """Return the process-wide executor singleton (built lazily from config)."""
    global _executor
    if _executor is None:
        config = get_config()
        callbacks = OntologyCallbackClient(
            api_base_url=config.api.api_base_url,
            service_token=config.api.service_token,
            timeout_seconds=config.api.callback_timeout_seconds,
        )
        _executor = FunctionRuntimeExecutor(
            sandbox=UnifiedSandbox(),
            callbacks=callbacks,
            functions=assemble_functions(),
        )
    return _executor


def reset_executor() -> None:
    """Drop the executor singleton, closing its HTTP callback pool (tests/env reload)."""
    global _executor
    if _executor is not None:
        _executor.callbacks.close()
        _executor = None
