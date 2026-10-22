"""FunctionRuntimeExecutor: core execution engine with call_function injection,
circular call detection, and max depth enforcement.

移植自元枢 ``backend/app/services/function_runtime/executor.py``，裁剪点：
- 去掉 SQLAlchemy Session / FunctionRegistry / session_factory / 版本快照
  （version_id → FunctionExecutor.execute_snapshot）路径；函数源码改由进程内
  RegisteredFunction 注册表提供（MCP 工具注册层 Task 4 负责装配）。
- 去掉 entity_ids / function_ids 授权 DB 过滤与 validate_parameters 校验：
  授权由 apps/api 回调侧承担，参数校验由 MCP 工具注册层承担。
- _build_ontology_helpers 改为 apps/api REST 回调（D5：硬超时、不重试），
  helper 签名与元枢一致；update_object 写路径裁剪（shim 内为 unavailable 桩）。

保留的元枢语义：单函数 timeout、调用链 total_timeout、call_function 递归、
循环调用检测（CircularCallError）、最大深度（MaxDepthError）、参数类型强制收口
（_coerce_params，JSON 数字字符串 → 数值）、ExecResult 形状与错误文案。
"""
from __future__ import annotations

import logging
import time
from typing import Any, NamedTuple

from ontology_logic.core.callbacks import OntologyCallbackClient
from ontology_logic.core.models import ExecContext, ExecResult, FunctionWriteRequested, ParamSchema
from ontology_logic.core.sandbox import UnifiedSandbox

logger = logging.getLogger(__name__)


class CircularCallError(Exception):
    pass


class MaxDepthError(Exception):
    pass


class RegisteredFunction(NamedTuple):
    """进程内函数注册表条目（替代元枢 DB FunctionRegistry 的最小形态）。

    param_schemas 供 _coerce_params 按声明类型强制转换入参，未声明则原样透传。
    """

    callable_name: str
    func_name: str  # 源码内的入口函数名（元枢 FunctionMeta.func_name）
    code: str
    param_schemas: tuple[ParamSchema, ...] = ()


def _coerce_param(value: Any, declared_type: str) -> Any:
    """按函数声明的参数类型强制转换入参。

    入参多来自 JSON(MCP/HTTP)，数字常被传成字符串(如 "50")，函数内部
    直接参与数值运算会抛 '<' not supported between int and str。这里按
    ParamSchema.type 收口转换，转换失败则原样返回(交由函数自身校验)。
    """
    if value is None:
        return None
    t = (declared_type or "").lower()
    try:
        if t in ("number", "float", "double", "decimal"):
            return float(value)
        if t in ("integer", "int"):
            if isinstance(value, bool):
                return value
            numeric = float(value)
            return int(numeric) if numeric.is_integer() else value
        if t in ("boolean", "bool"):
            if isinstance(value, str):
                normalized = value.strip().lower()
                if normalized in ("true", "1", "yes", "y"):
                    return True
                if normalized in ("false", "0", "no", "n"):
                    return False
                return value
            return bool(value)
        if t in ("string", "str", "text"):
            return value if isinstance(value, str) else str(value)
    except (TypeError, ValueError):
        return value
    return value


def _coerce_params(params: dict, param_schemas: list) -> dict:
    """按声明的参数 schema 逐项做类型强制，未声明的参数保持原样。"""
    if not params or not param_schemas:
        return params
    type_by_name = {p.name: p.type for p in param_schemas if getattr(p, "name", None)}
    coerced = dict(params)
    for name, decl_type in type_by_name.items():
        if name in coerced:
            coerced[name] = _coerce_param(coerced[name], decl_type)
    return coerced


class FunctionRuntimeExecutor:
    def __init__(
        self,
        sandbox: UnifiedSandbox,
        callbacks: OntologyCallbackClient,
        functions: dict[str, RegisteredFunction] | None = None,
    ):
        self.sandbox = sandbox
        self.callbacks = callbacks
        self.functions: dict[str, RegisteredFunction] = dict(functions or {})

    def register(self, entry: RegisteredFunction) -> None:
        """Register one function unit (元枢 registry.set 的进程内等价物）。"""
        self.functions[entry.callable_name] = entry

    def execute(
        self, callable_name: str, params: dict, context: ExecContext | None = None
    ) -> ExecResult:
        start = time.time()
        if context is None:
            context = ExecContext(call_stack=[])

        # Initialize chain start time on first call
        if context._chain_start is None:
            context._chain_start = time.time()

        # Enforce total chain timeout
        elapsed_chain = time.time() - context._chain_start
        if elapsed_chain > context.total_timeout_sec:
            return ExecResult(
                success=False,
                result=None,
                error=f"调用链总超时 (>{context.total_timeout_sec}s)",
                execution_ms=int((time.time() - start) * 1000),
                call_trace=list(context.call_stack),
            )

        meta = self.functions.get(callable_name)
        if meta is None:
            return ExecResult(
                success=False,
                result=None,
                error=f"函数 '{callable_name}' 未找到 (not found)",
                execution_ms=int((time.time() - start) * 1000),
                call_trace=list(context.call_stack),
            )

        # Max depth enforcement (checked first to handle self-recursion)
        if len(context.call_stack) >= context.max_depth:
            raise MaxDepthError(f"超过最大递归深度 (depth): {context.max_depth}")

        # Circular call detection (A -> B -> A pattern, excludes self-recursion
        # which is handled by max depth above)
        if callable_name in context.call_stack and callable_name != context.call_stack[-1]:
            raise CircularCallError(
                f"检测到循环调用 (circular): {' → '.join(context.call_stack)} → {callable_name}"
            )

        context.call_stack.append(callable_name)

        try:
            # 按声明的参数类型强制转换入参(JSON 传来的 "50" → 50)
            params = _coerce_params(params, list(meta.param_schemas))
            # 融合裁剪：原元枢 validate_parameters / 授权过滤职责由 MCP 工具注册层
            # 与 apps/api 回调侧承担。
            namespace = {
                "params": params,
                "call_function": self._build_call_function(context),
                **self._build_ontology_helpers(),
            }
            # Calculate remaining time for this individual call
            remaining = context.total_timeout_sec - (time.time() - context._chain_start)
            effective_timeout = max(1, int(min(context.timeout_sec, remaining)))
            result = self.sandbox.execute(
                meta.code, meta.func_name, namespace, timeout=effective_timeout
            )
            elapsed = int((time.time() - start) * 1000)
            return ExecResult(
                success=True,
                result=result,
                error=None,
                execution_ms=elapsed,
                call_trace=list(context.call_stack),
                outcome="committed" if context.committed_writes else None,
                committed_writes=list(context.committed_writes),
            )
        except (CircularCallError, MaxDepthError):
            raise
        except FunctionWriteRequested as request:
            return ExecResult(success=True, result=None, error=None,
                execution_ms=int((time.time()-start)*1000), call_trace=list(context.call_stack),
                outcome="simulated" if context.action_mode == "simulation" else "pending_confirmation",
                requested_write=request.request)
        except Exception as e:
            elapsed = int((time.time() - start) * 1000)
            return ExecResult(
                success=False,
                result=None,
                error=str(e),
                execution_ms=elapsed,
                call_trace=list(context.call_stack),
                outcome=context.failure_outcome(e),
                committed_writes=list(context.committed_writes),
            )
        finally:
            context.call_stack.pop()

    def _build_call_function(self, context: ExecContext):
        """Build the call_function helper injected into sandbox namespace."""
        def call_function(name: str, params: dict) -> Any:
            # 融合裁剪：原元枢版本快照 / DB 执行器分支删除，统一走进程内注册表递归。
            result = self.execute(name, params, context)
            if result.requested_write:
                raise FunctionWriteRequested(result.requested_write)
            if not result.success:
                error = RuntimeError(f"call_function('{name}') failed: {result.error}")
                error.outcome = result.outcome
                raise error
            return result.result
        return call_function

    def _build_ontology_helpers(self) -> dict[str, Any]:
        """Build query_object/query_objects/call_complex_sql/traverse helpers for sandbox.

        融合裁剪：原元枢直接调 SQLAlchemy 服务（EntityDataService / execute_ontology_sql /
        关系图 BFS 编 SQL），本版统一改为 apps/api REST 回调（D5：硬超时、不重试）。
        helper 签名与返回形态与元枢一致：
        - query_object  → dict | None（单行字典化，无行返回 None）
        - query_objects → list[dict]
        - call_complex_sql → {columns, rows, rowCount}（行不字典化）
        - traverse → list[dict]
        update_object 裁剪：写路径由 apps/api 承担，沙箱内经 shim unavailable 桩拒绝。
        """
        client = self.callbacks

        def query_object(entity_name: str, filters: dict) -> dict | None:
            rows = client.query_rows(entity_name, filters or {}, limit=1, offset=0)
            return rows[0] if rows else None

        def query_objects(entity_name: str, filters: dict, limit: int = 100, offset: int = 0) -> list[dict]:
            return client.query_rows(entity_name, filters or {}, limit=limit, offset=offset)

        def call_complex_sql(sql: str, params: dict | None = None) -> dict:
            return client.execute_sql(sql, params)

        def traverse(from_entity: str, from_filters: dict, to_entity: str, limit: int = 100) -> list[dict]:
            return client.traverse_rows(from_entity, from_filters or {}, to_entity, limit)

        return {
            "query_object": query_object,
            "query_objects": query_objects,
            "call_complex_sql": call_complex_sql,
            "traverse": traverse,
        }
