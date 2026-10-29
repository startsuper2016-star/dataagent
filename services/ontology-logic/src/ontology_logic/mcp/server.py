"""ontology-logic MCP server — expose the logic sandbox as MCP tools.

Tools (Phase 2 Task 4):
- ontology_ping: connectivity echo.
- ontology_run_logic: run one registered logic function (spc_detect/rca_rank/
  rca_evidence) through the sandbox executor (executor.run_registered), returning
  the JSON result as content.
- ontology_query: query entity rows via the apps/api HTTP callback
  (POST /api/v1/ontology/query), returning row data.

错误面（T2 评审承接项①②）：
- CircularCallError / MaxDepthError → isError content，错误消息原样透传（供 LLM 自纠）；
- 参数校验（validate_logic_params，按 FunctionSpec.input_schema）→ isError content；
- 未注册 logic / 回调失败（RuntimeError）→ isError content。

Transport: streamable-http by default (same family as datalink's
streamable-http mode), stdio available via ONTOLOGY_LOGIC_MCP_TRANSPORT.

Run with: uv run python -m ontology_logic.mcp.server
"""

import json
import logging
from typing import Literal

from mcp.server.fastmcp import FastMCP
from mcp.types import CallToolResult, TextContent

from ontology_logic.api.deps import get_config, get_executor
from ontology_logic.core.executor import CircularCallError, MaxDepthError
from ontology_logic.functions.registry import validate_logic_params

logger = logging.getLogger(__name__)

# logic_name 的 enum 面（与 registry.FUNCTIONS 一致；运行期另有未注册防御）。
LogicName = Literal["spc_detect", "rca_rank", "rca_evidence"]

mcp = FastMCP("ontology-logic")


# --- 结果面（isError content 承接项①：消息原样透传，不加前缀） --------------------


def _json_result(payload) -> CallToolResult:
    """成功面：JSON 结果作为 text content 返回（isError=False）。"""
    return CallToolResult(
        content=[TextContent(type="text", text=json.dumps(payload, ensure_ascii=False))],
        isError=False,
    )


def _error_result(message: str) -> CallToolResult:
    """isError content：错误消息原样透传（CircularCallError/MaxDepthError/
    参数校验/未注册/回调失败），供 LLM 读取后自纠。"""
    return CallToolResult(content=[TextContent(type="text", text=message)], isError=True)


# --- 工具 -----------------------------------------------------------------------


@mcp.tool()
def ontology_ping() -> dict:
    """Connectivity check for the ontology-logic MCP server.

    Always succeeds — returns an echo payload so clients can verify
    transport wiring before calling real logic tools.
    """
    return {"pong": True, "service": "ontology-logic"}


@mcp.tool()
def ontology_run_logic(logic_name: LogicName, params: dict | None = None) -> CallToolResult:
    """Run one registered SPC/RCA logic function in the sandbox and return its JSON result.

    Args:
        logic_name: One of "spc_detect" (SPC 离群检测锚定，输出 {anchor})、
            "rca_rank" (根因候选因子统计排名，输出 {ranking, top1, ...})、
            "rca_evidence" (根因证据评分与门控，输出 {conclusion, confidence, gate, ...}；
            需在 params.candidates 传入 rca_rank 输出的 ranking 列表).
        params: 函数入参对象（可选；rca_evidence 必填 candidates）。

    Returns:
        JSON 结果 content；错误时 isError content（消息原样，可直接自纠）。
    """
    payload = dict(params or {})
    # 承接项②：按 FunctionSpec.input_schema 做 required/类型校验（未注册同口径）。
    invalid = validate_logic_params(logic_name, payload)
    if invalid is not None:
        return _error_result(invalid)
    try:
        result = get_executor().run_registered(None, logic_name, payload)
    except (CircularCallError, MaxDepthError) as err:
        # 承接项①：循环/深度守卫错误原样透传（供 LLM 自纠）。
        logger.warning("ontology_run_logic(%s) guard error: %s", logic_name, err)
        return _error_result(str(err))
    except (ValueError, RuntimeError) as err:
        # 未注册函数 / 函数执行失败（含 D5 回调失败）→ isError 原文。
        logger.warning("ontology_run_logic(%s) failed: %s", logic_name, err)
        return _error_result(str(err))
    return _json_result(result)


@mcp.tool()
def ontology_context() -> CallToolResult:
    """Return the ontology business context: entities, approved bindings,
    relations, and registered logic functions.

    This is the semantic grounding source for agent runs — tells the agent
    WHAT business objects exist, HOW they relate, and WHAT computations
    are available. Call this before making domain-specific queries.
    """
    try:
        executor = get_executor()
        bindings = executor.callbacks.query_rows(
            "__ontology_bindings__", {}, limit=200
        )
        relations = executor.callbacks.query_rows(
            "__ontology_relations__", {}, limit=200
        )
        functions = [
            {"callable_name": spec.callable_name, "description": spec.description,
             "input_schema": spec.input_schema}
            for spec in executor.get_function_specs()
        ]
    except RuntimeError as err:
        logger.warning("ontology_context failed: %s", err)
        return _error_result(str(err))
    return _json_result({
        "bindings": bindings,
        "relations": relations,
        "logic_functions": functions,
    })


@mcp.tool()
def ontology_query(
    entity: str,
    filters: dict | None = None,
    limit: int = 100,
    offset: int = 0,
    apply_rules: bool = False,
) -> CallToolResult:
    """Query rows of one ontology entity through the apps/api HTTP callback.

    Args:
        entity: 实体名（如 AnomWafer、RcaDaily、ToolEvent）。
        filters: 等值/范围过滤条件（如 {"lot_id": "L1"}、{"stat_date": {"gte": "2026-09-21"}}）。
        limit: 返回行数上限（默认 100）。
        offset: 翻页偏移（默认 0）。

    Returns:
        {"rows": [dict], "rowCount": n}；apply_rules=True 时每行附 rule_conclusions 结论标注。
        回调失败时 isError content（D5 原文）。
    """
    try:
        rows = get_executor().callbacks.query_rows(
            entity, filters or {}, limit=limit, offset=offset, apply_rules=apply_rules
        )
    except RuntimeError as err:
        # 回调失败（D5 契约：超时/非 200/错误信封）→ isError 原文透传。
        logger.warning("ontology_query(%s) failed: %s", entity, err)
        return _error_result(str(err))
    return _json_result({"rows": rows, "rowCount": len(rows)})


def start_mcp_server(host: str = "", port: int = 0, transport: str = "") -> None:
    """Start the MCP server.

    Args:
        host: Bind host. Empty = ONTOLOGY_LOGIC_MCP_HOST or 127.0.0.1.
        port: Bind port. 0 = ONTOLOGY_LOGIC_MCP_PORT or 8902.
        transport: 'streamable-http' (default) or 'stdio'.
    """
    config = get_config()
    mcp.settings.host = host or config.mcp.host
    mcp.settings.port = port or config.mcp.port
    effective_transport = transport or config.mcp.transport

    logger.info(
        "Starting ontology-logic MCP server (%s) on %s:%s",
        effective_transport,
        mcp.settings.host,
        mcp.settings.port,
    )
    mcp.run(transport=effective_transport)


@mcp.tool()
def ontology_run_action(
    action_code: str,
    params: dict | None = None,
    mode: Literal["simulate", "execute"] = "execute",
) -> CallToolResult:
    """Run one ontology action (agent-invokable contract) and return its result.

    Args:
        action_code: 行为英文标识（见 ontology_context 的 actions 清单或治理台行为页签）。
        params: 行为参数契约要求的入参对象（可选；必填参数缺失会失败）。
        mode: simulate=仿真预览（≤20 行，不留痕）；execute=执行并留痕。
    """
    try:
        result = get_executor().callbacks.run_action(action_code, params or {}, mode)
    except RuntimeError as err:
        logger.warning("ontology_run_action(%s) failed: %s", action_code, err)
        return _error_result(str(err))
    return _json_result(result)


@mcp.tool()
def ontology_eval_rule(
    rule_name: str,
    entity: str | None = None,
    filters: dict | None = None,
    limit: int = 10,
) -> CallToolResult:
    """Evaluate one ontology inference/validation rule against bound data.

    Args:
        rule_name: 规则名（见 ontology_context 的 rules 清单，含 expr 可读表达式）。
        entity: 可选，限定作用对象（不同对象存在同名规则时必填）。
        filters: 可选行级过滤（如 {"station": "PVD_TI"}），与规则条件 AND 组合。
        limit: 预览行数上限（默认 10，最大 100）；每行附 rule_conclusion 结论标注。
    """
    try:
        result = get_executor().callbacks.eval_rule(rule_name, entity, filters, limit)
    except RuntimeError as err:
        logger.warning("ontology_eval_rule(%s) failed: %s", rule_name, err)
        return _error_result(str(err))
    return _json_result(result)


@mcp.tool()
def ontology_apply_rules(
    entity: str,
    filters: dict | None = None,
    limit: int = 50,
) -> CallToolResult:
    """Apply ALL enabled inference rules of one ontology entity to its bound data.

    Args:
        entity: 实体名（本体管理清单中的对象）。
        filters: 可选行级过滤（如 {"station": "PVD_TI"}）。
        limit: 行数上限（默认 50，最大 200）；每行附 rule_labels 结论标注数组。

    Returns:
        {rulesApplied, rulesSkipped?, rows, rowCount}——规则派生属性的一次性批量标注，
        适合回答「这批数据里哪些行命中了我们的业务规则」。
    """
    try:
        result = get_executor().callbacks.apply_rules(entity, filters, limit)
    except RuntimeError as err:
        logger.warning("ontology_apply_rules(%s) failed: %s", entity, err)
        return _error_result(str(err))
    return _json_result(result)


if __name__ == "__main__":
    start_mcp_server()
