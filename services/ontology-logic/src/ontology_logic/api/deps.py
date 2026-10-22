"""Shared dependencies for ontology-logic REST API routes.

Same dependency-injection pattern as datalink's api/deps.py: a cached
config loader so every route sees the same effective configuration.
"""

from functools import lru_cache

from ontology_logic.config import OntologyLogicConfig


@lru_cache(maxsize=1)
def get_config() -> OntologyLogicConfig:
    """Load the process-wide configuration from environment variables."""
    return OntologyLogicConfig.from_env()


def reset_config() -> None:
    """Drop the cached config (used by tests and after env changes)."""
    get_config.cache_clear()
