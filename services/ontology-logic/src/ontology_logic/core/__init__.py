"""ontology-logic function sandbox core — ported from 元枢 function_runtime.

Components:
- models: FunctionMeta / ExecContext / ExecResult / FunctionWriteRequested / ParamSchema
  plus the timeout/depth constants (30s single call / 120s chain / depth 10).
- sandbox: UnifiedSandbox — AST validator + restricted execution environment
  (verbatim semantic port; whitelist / underscore / dangerous-call verdicts identical).
- executor: FunctionRuntimeExecutor — single-function execution with call_function
  recursion, chain timeout, circular-call detection (CircularCallError) and
  max-depth enforcement (MaxDepthError). DB/registry/snapshot paths cut.
- callbacks: OntologyCallbackClient — HTTP data helpers against apps/api
  /api/v1/ontology/* (D5 contract: hard timeout, never retried).
"""

from ontology_logic.core.callbacks import OntologyCallbackClient
from ontology_logic.core.executor import (
    CircularCallError,
    FunctionRuntimeExecutor,
    MaxDepthError,
    RegisteredFunction,
    assemble_functions,
    build_registered_function,
)
from ontology_logic.core.models import (
    DEFAULT_MAX_DEPTH,
    DEFAULT_TIMEOUT_SEC,
    DEFAULT_TOTAL_TIMEOUT_SEC,
    ExecContext,
    ExecResult,
    FunctionMeta,
    FunctionWriteRequested,
    ParamSchema,
)
from ontology_logic.core.sandbox import UnifiedSandbox, ValidationResult

__all__ = [
    "CircularCallError",
    "DEFAULT_MAX_DEPTH",
    "DEFAULT_TIMEOUT_SEC",
    "DEFAULT_TOTAL_TIMEOUT_SEC",
    "ExecContext",
    "ExecResult",
    "FunctionMeta",
    "FunctionRuntimeExecutor",
    "FunctionWriteRequested",
    "MaxDepthError",
    "OntologyCallbackClient",
    "ParamSchema",
    "RegisteredFunction",
    "UnifiedSandbox",
    "ValidationResult",
    "assemble_functions",
    "build_registered_function",
]
