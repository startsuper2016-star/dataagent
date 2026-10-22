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
from ontology_logic.functions.registry import FUNCTIONS

logger = logging.getLogger(__name__)

# 元枢 inline 模式包裹后的入口函数名（function_runtime 在线模式同款）。
INLINE_FUNC_NAME = "inline_function"


class CircularCallError(Exception):
    pass


class MaxDepthError(Exception):
    pass


def wrap_inline_body(body: str, func_name: str = INLINE_FUNC_NAME) -> str:
    """按元枢 inline 模式包裹函数体语句序列。

    元枢离线 runner（spc_kernel.run_body）与在线模式同构：
    ``def inline_function(params): result=None; <body 逐行缩进>; return result``。
    spc_kernel 的 BODY_* 是语句序列（非完整函数定义），包裹后才可经沙箱执行。
    """
    indented = "\n".join("    " + line for line in body.splitlines())
    return f"def {func_name}(params):\n    result = None\n" + indented + "\n    return result\n"


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
        self,
        callable_name: str,
        params: dict,
        context: ExecContext | None = None,
        *,
        query_callbacks: dict | None = None,
    ) -> ExecResult:
        start = time.time()
        if context is None:
            context = ExecContext(call_stack=[])

        # 承接项③：版本快照路径随 SQLAlchemy 侧裁剪，独立侧车不支持 version_id 执行。
        if context.version_id is not None:
            raise RuntimeError("独立侧车不支持 version_id 执行")

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
                "call_function": self._build_call_function(context, query_callbacks),
                **self._build_ontology_helpers(query_callbacks),
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

    def _build_call_function(self, context: ExecContext, query_callbacks: dict | None = None):
        """Build the call_function helper injected into sandbox namespace."""
        def call_function(name: str, params: dict) -> Any:
            # 融合裁剪：原元枢版本快照 / DB 执行器分支删除，统一走进程内注册表递归。
            # query_callbacks 透传：同一调用链内的嵌套调用复用同一套回调实现。
            result = self.execute(name, params, context, query_callbacks=query_callbacks)
            if result.requested_write:
                raise FunctionWriteRequested(result.requested_write)
            if not result.success:
                error = RuntimeError(f"call_function('{name}') failed: {result.error}")
                error.outcome = result.outcome
                raise error
            return result.result
        return call_function

    def _build_ontology_helpers(self, query_callbacks: dict | None = None) -> dict[str, Any]:
        """Build query_object/query_objects/call_complex_sql/traverse helpers for sandbox.

        融合裁剪：原元枢直接调 SQLAlchemy 服务（EntityDataService / execute_ontology_sql /
        关系图 BFS 编 SQL），本版统一改为 apps/api REST 回调（D5：硬超时、不重试）。
        helper 签名与返回形态与元枢一致：
        - query_object  → dict | None（单行字典化，无行返回 None）
        - query_objects → list[dict]
        - call_complex_sql → {columns, rows, rowCount}（行不字典化）
        - traverse → list[dict]
        update_object 裁剪：写路径由 apps/api 承担，沙箱内经 shim unavailable 桩拒绝。

        query_callbacks：进程内回调实现映射（run_registered 传入，key 为
        query_object/query_objects/call_complex_sql/traverse，值为与上述签名一致的
        可调用对象）；None 时回落 self.callbacks（HTTP 回调）。缺失项落 unavailable
        桩（与 sandbox shim 同文案），沙箱内调用即抛 RuntimeError。
        """
        if query_callbacks is not None:
            def _unavailable(name: str):
                def invoke(*args, **kwargs):
                    raise RuntimeError(f"当前执行入口未提供 {name} 能力")
                return invoke

            return {
                "query_object": query_callbacks.get("query_object", _unavailable("query_object")),
                "query_objects": query_callbacks.get("query_objects", _unavailable("query_objects")),
                "call_complex_sql": query_callbacks.get("call_complex_sql", _unavailable("call_complex_sql")),
                "traverse": query_callbacks.get("traverse", _unavailable("traverse")),
            }

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

    def run_registered(
        self,
        conn_or_none,
        callable_name: str,
        params: dict,
        query_callbacks: dict | None = None,
        *,
        context: ExecContext | None = None,
    ) -> Any:
        """Execute one function from the static registry (functions.registry.FUNCTIONS).

        MCP 工具层（Task 4 ``ontology_run_logic``）的执行入口：

        - conn_or_none：预留形参（元枢离线 runner 的 sqlite conn 直连形态）；本部署
          函数内数据访问一律经 query_callbacks（apps/api 回调实现），传 None 即可。
        - query_callbacks：``{"query_objects", "call_complex_sql", "traverse"}`` 回调
          实现映射（与元枢 helper 同签名）；None 时回落 self.callbacks（HTTP 回调）。
        - 包裹形态沿用元枢 inline 模式：``def inline_function(params): result=None;
          <body>; return result``（spc_kernel 的 BODY 是语句序列）。
        - 内联条目注册进 self.functions：call_function 递归与循环（CircularCallError）/
          深度（MaxDepthError）守卫复用 execute() 同一链路，类型化异常原样穿透到
          MCP 层；其余运行期异常收敛为 RuntimeError（携带 ExecResult.error 原文）。
        - context：默认 None = 新调用链；编排/测试可传入共享 ExecContext 使跨函数
          调用链共享循环/深度/链超时状态。
        """
        spec = FUNCTIONS.get(callable_name)
        if spec is None:
            raise ValueError(f"未注册函数: {callable_name}")
        entry = RegisteredFunction(
            callable_name=callable_name,
            func_name=INLINE_FUNC_NAME,
            code=wrap_inline_body(spec.body),
            param_schemas=tuple(
                ParamSchema(
                    name=item["name"],
                    type=item.get("type", "string"),
                    required=bool(item.get("required", False)),
                    description=item.get("description", ""),
                )
                for item in spec.input_schema
            ),
        )
        # 注册进进程内注册表（幂等覆盖）：同链 call_function 递归与守卫复用 execute()。
        self.register(entry)
        result = self.execute(callable_name, params, context, query_callbacks=query_callbacks)
        if not result.success:
            error = RuntimeError(result.error or "函数执行失败")
            error.outcome = result.outcome
            raise error
        return result.result
