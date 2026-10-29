"""Phase 2 Task 4 — MCP 工具层接线测试（ontology_run_logic / ontology_query）。

- 工具经进程内 FastMCP 面调用（``mcp.call_tool``，与协议层同一条 Tool.run 链路）；
  执行器走服务级单例（api.deps.get_executor），回调注入进程内 FakeCallbackClient
  （与 test_spc_functions 同一份数据面），不经 HTTP。
- 承接项①：CircularCallError / MaxDepthError → isError content，消息原样透传
  （断言无 SDK 的 ``Error executing tool`` 前缀）。
- 承接项②：按 FunctionSpec.input_schema 的必填缺失 / string-array 类型粗校验 →
  isError content（``缺少必填参数 X``）；未注册 → isError（``未注册函数: X``）。
- 承接项③：registry 装配一次——服务级单例构造时 assemble_functions() 全量装配，
  run_registered 不在每次调用覆盖写 self.functions。
- 承接项④：run_registered 的 conn_or_none 死参 assert None。
"""
from __future__ import annotations

import asyncio
import json

import pytest

# 与 test_spc_functions.py 同一份数据面（fake 回调表 + 基线聚合行）。
from test_spc_functions import BASELINE, DETECT_TABLES, EVIDENCE_TABLES, RANK_TABLES

from ontology_logic.api import deps
from ontology_logic.api.deps import get_executor, reset_executor
from ontology_logic.core.executor import (
    CircularCallError,
    MaxDepthError,
    RegisteredFunction,
)
from ontology_logic.functions.registry import FUNCTIONS, validate_logic_params
from ontology_logic.mcp.server import mcp, ontology_run_logic

WINDOW_START, WINDOW_END = "2026-09-21", "2026-10-20"


class FakeCallbackClient:
    """OntologyCallbackClient 同接口的进程内假件（表数据 + 翻页/gte 过滤）。"""

    def __init__(self, tables: dict[str, list[dict]], baseline_row: tuple):
        self.tables = tables
        self.baseline_row = baseline_row

    def query_rows(self, entity_name, filters, limit=100, offset=0, apply_rules=False):
        rows = self.tables.get(entity_name, [])
        for key, cond in (filters or {}).items():
            if isinstance(cond, dict) and "gte" in cond:
                rows = [r for r in rows if r[key] >= cond["gte"]]
            else:
                rows = [r for r in rows if r[key] == cond]
        return rows[offset : offset + limit]

    def execute_sql(self, sql, params=None):
        return {
            "columns": ["n", "sum_x", "sum_x2"],
            "rows": [list(self.baseline_row)],
            "rowCount": 1,
        }

    def traverse_rows(self, from_entity, from_filters, to_entity, limit=100):
        return []

    def close(self) -> None:
        """reset_executor 复位单例时会调用（OntologyCallbackClient 同接口）。"""


@pytest.fixture()
def wired():
    """服务级单例 + 进程内 fake 回调（不经 HTTP）；结束后复位单例。"""
    executor = get_executor()
    assert deps._executor is executor  # 单例
    original = executor.callbacks
    executor.callbacks = FakeCallbackClient(DETECT_TABLES | RANK_TABLES | EVIDENCE_TABLES, BASELINE)
    yield executor
    executor.callbacks = original
    reset_executor()


def call_tool(name: str, arguments: dict):
    """经 FastMCP 进程内入口调用工具（与协议层同一 Tool.run 链路）。"""
    return asyncio.run(mcp.call_tool(name, arguments))


def result_text(result) -> str:
    assert len(result.content) == 1
    return result.content[0].text


# --- 1. 工具注册面 -----------------------------------------------------------------


def test_tools_registered_with_enum_surface():
    tools = {t.name: t for t in asyncio.run(mcp.list_tools())}
    assert {"ontology_ping", "ontology_run_logic", "ontology_query"} <= set(tools)
    schema = tools["ontology_run_logic"].inputSchema
    properties = schema["properties"]
    assert properties["logic_name"].get("enum") == ["spc_detect", "rca_rank", "rca_evidence"]
    # params 为可选 object（Optional[dict] 在 pydantic 下可能呈 anyOf 形态）
    params_schema = properties["params"]
    types = {params_schema.get("type")}
    for sub in params_schema.get("anyOf", []):
        types.add(sub.get("type"))
    assert "object" in types


# --- 2. 三函数调用（MCP 层 → 单例执行器 → fake 回调） --------------------------------


def test_run_logic_spc_detect_via_mcp(wired):
    result = call_tool("ontology_run_logic", {"logic_name": "spc_detect", "params": {}})
    assert result.isError is False
    payload = json.loads(result_text(result))
    anchor = payload["anchor"]
    assert anchor["baseline"]["ucl3"] == 6.4495
    assert anchor["anom_wafer_n"] == 3
    assert anchor["anom_lot_n"] == 2
    assert anchor["first_violation_day"] == "2026-09-21"


def test_run_logic_rca_rank_and_evidence_chain_via_mcp(wired):
    rank = call_tool("ontology_run_logic", {"logic_name": "rca_rank", "params": {}})
    assert rank.isError is False
    ranking = json.loads(result_text(rank))
    assert ranking["top1"] == ranking["ranking"][0]["factor"]
    assert "CH_B" in [cd["factor"] for cd in ranking["ranking"]]  # 腔体候选在榜（真数据冒烟再验 top1）
    assert ranking["top_chamber"] == "CH_B"

    evidence = call_tool(
        "ontology_run_logic",
        {
            "logic_name": "rca_evidence",
            "params": {
                "candidates": ranking["ranking"],
                "window_start": WINDOW_START,
                "window_end": WINDOW_END,
                "onset": "2026-09-21",
            },
        },
    )
    assert evidence.isError is False
    payload = json.loads(result_text(evidence))
    assert payload["gate"] == "auto_ticket"
    assert payload["confidence"] == payload["hypotheses"][0]["final_weight"]
    assert 0.70 <= payload["confidence"] < 1.0


def test_run_logic_default_params_object_optional(wired):
    """params 缺省（None → {}）：spc_detect 无必填参数，可直接调用。"""
    result = call_tool("ontology_run_logic", {"logic_name": "spc_detect"})
    assert result.isError is False
    assert json.loads(result_text(result))["anchor"]["station"] == "PVD_TI"


# --- 3. 承接项①：循环/深度异常 → isError content 原样透传 ----------------------------


@pytest.mark.parametrize(
    ("exc", "message"),
    [
        (CircularCallError, "检测到循环调用 (circular): rca_rank → hop → rca_rank"),
        (MaxDepthError, "超过最大递归深度 (depth): 10"),
    ],
)
def test_run_logic_guard_errors_become_iserror_verbatim(wired, monkeypatch, exc, message):
    """守卫类型异常被工具层捕获转 isError，消息原样（无 SDK 前缀）。"""

    def raise_guard(conn_or_none, callable_name, params, query_callbacks=None, *, context=None):
        raise exc(message)

    monkeypatch.setattr(wired, "run_registered", raise_guard)
    result = call_tool("ontology_run_logic", {"logic_name": "spc_detect", "params": {}})
    assert result.isError is True
    assert result_text(result) == message  # 原样透传
    assert "Error executing tool" not in result_text(result)


# --- 4. 承接项②：参数校验（required 缺失 / 类型粗校验 / 未注册） ---------------------


def test_run_logic_missing_required_param_iserror(wired):
    result = call_tool("ontology_run_logic", {"logic_name": "rca_evidence", "params": {}})
    assert result.isError is True
    assert result_text(result) == "缺少必填参数 candidates"


def test_run_logic_null_required_param_iserror(wired):
    result = call_tool(
        "ontology_run_logic", {"logic_name": "rca_evidence", "params": {"candidates": None}}
    )
    assert result.isError is True
    assert result_text(result) == "缺少必填参数 candidates"


def test_run_logic_wrong_param_type_iserror(wired):
    result = call_tool(
        "ontology_run_logic", {"logic_name": "rca_evidence", "params": {"candidates": "not-a-list"}}
    )
    assert result.isError is True
    assert result_text(result) == "参数 candidates 类型错误: 期望 array，实为 str"


def test_run_logic_unregistered_iserror():
    """未注册 logic → isError（经工具函数直调；Literal 面 + 运行期防御双口径）。"""
    result = ontology_run_logic("ghost_function", {})
    assert result.isError is True
    assert result_text(result) == "未注册函数: ghost_function"


def test_validate_logic_params_unit():
    assert validate_logic_params("spc_detect", {}) is None
    assert validate_logic_params("spc_detect", {"case_id": "C-1"}) is None
    assert validate_logic_params("ghost_function", {}) == "未注册函数: ghost_function"
    assert validate_logic_params("rca_evidence", {}) == "缺少必填参数 candidates"
    assert (
        validate_logic_params("rca_evidence", {"candidates": {"a": 1}})
        == "参数 candidates 类型错误: 期望 array，实为 dict"
    )
    assert validate_logic_params("rca_evidence", {"candidates": []}) is None


# --- 5. ontology_query（走 apps/api 回调客户端接口） ---------------------------------


def test_query_tool_returns_rows(wired):
    result = call_tool("ontology_query", {"entity": "AnomWafer", "filters": {}, "limit": 2})
    assert result.isError is False
    payload = json.loads(result_text(result))
    assert len(payload["rows"]) == 2
    assert payload["rowCount"] == 2


def test_query_tool_filters_and_offset(wired):
    result = call_tool(
        "ontology_query",
        {"entity": "AnomWafer", "filters": {"lot_id": "L1"}, "limit": 100, "offset": 1},
    )
    assert result.isError is False
    payload = json.loads(result_text(result))
    assert payload["rowCount"] == 1  # L1 有 2 行，offset=1 翻页后剩 1 行
    assert payload["rows"][0]["rs_ti_mean"] == 7.1


def test_query_tool_callback_failure_iserror(wired):
    """回调失败（D5）→ isError 原文透传。"""

    class Failing:
        def query_rows(self, *args, **kwargs):
            raise RuntimeError("ontology 回调 /api/v1/ontology/query 失败（D5 不重试）: boom")

    original = wired.callbacks
    wired.callbacks = Failing()
    try:
        result = call_tool("ontology_query", {"entity": "AnomWafer", "filters": {}})
        assert result.isError is True
        assert result_text(result) == "ontology 回调 /api/v1/ontology/query 失败（D5 不重试）: boom"
    finally:
        wired.callbacks = original


# --- 6. 承接项③④：装配一次 + 死参断言 ----------------------------------------------


def test_executor_singleton_assembled_once():
    """服务级单例：构造时全量装配（承接项③）；重复获取同一实例。"""
    reset_executor()
    try:
        first = get_executor()
        second = get_executor()
        assert first is second
        assert set(first.functions) == set(FUNCTIONS)  # 构造时全量装配
        for name, entry in first.functions.items():
            assert entry.func_name == "inline_function"
            assert entry.code.startswith("def inline_function(params):")
            assert entry.callable_name == name
    finally:
        reset_executor()


def test_run_registered_does_not_overwrite_functions_per_call():
    """run_registered 不在每次调用覆盖写 self.functions（承接项③）。"""
    reset_executor()
    try:
        executor = get_executor()
        executor.callbacks = FakeCallbackClient(DETECT_TABLES, BASELINE)
        before = dict(executor.functions)
        executor.run_registered(None, "spc_detect", {})
        after = dict(executor.functions)
        assert before == after  # 零写入
        assert before["spc_detect"] is after["spc_detect"]  # 同一装配条目
    finally:
        reset_executor()


def test_run_registered_fresh_executor_assembles_once():
    """非单例实例：首个调用装配一次，后续调用复用（不覆盖）。"""
    from ontology_logic.core.executor import FunctionRuntimeExecutor, assemble_functions
    from ontology_logic.core.sandbox import UnifiedSandbox

    executor = FunctionRuntimeExecutor(
        UnifiedSandbox(), None, functions=assemble_functions()
    )
    assert set(executor.functions) == set(FUNCTIONS)
    executor.callbacks = FakeCallbackClient(DETECT_TABLES, BASELINE)
    anchor = executor.run_registered(None, "spc_detect", {})["anchor"]
    assert anchor["anom_wafer_n"] == 3
    assert "spc_detect" in executor.functions


def test_run_registered_conn_none_assert():
    """承接项④：conn_or_none 死参显式拒绝（误传 conn 抛 ValueError，-O 下不失效）。"""
    reset_executor()
    try:
        executor = get_executor()
        executor.callbacks = FakeCallbackClient(DETECT_TABLES, BASELINE)
        with pytest.raises(ValueError, match="conn_or_none"):
            executor.run_registered(object(), "spc_detect", {})
    finally:
        reset_executor()


def test_register_helper_builds_all_entries():
    from ontology_logic.core.executor import assemble_functions, build_registered_function

    assembled = assemble_functions()
    assert set(assembled) == {"spc_detect", "rca_rank", "rca_evidence"}
    for name, entry in assembled.items():
        assert isinstance(entry, RegisteredFunction)
        assert entry == build_registered_function(name)  # 确定性装配


# --- 7. 命名参数适配（apps/api /ontology/sql 的 p<N> 键白名单） -----------------------


def test_adapt_named_params_renames_to_p_contract():
    from ontology_logic.core.callbacks import adapt_named_params

    sql = "SELECT count(*) AS n FROM WaferFact WHERE process_date < :ws"
    adapted_sql, adapted = adapt_named_params(sql, {"ws": "2026-09-21"})
    assert adapted_sql == "SELECT count(*) AS n FROM WaferFact WHERE process_date < :p1"
    assert adapted == {"p1": "2026-09-21"}


def test_adapt_named_params_multiple_keys_and_word_boundary():
    from ontology_logic.core.callbacks import adapt_named_params

    sql = "SELECT :b - :a AS d WHERE x < :ab"  # a 是 ab 的前缀（\b 防误替换）
    adapted_sql, adapted = adapt_named_params(sql, {"ab": 3, "a": 1, "b": 2})
    # 键按字典序编号：a→p1, ab→p2, b→p3
    assert adapted_sql == "SELECT :p3 - :p1 AS d WHERE x < :p2"
    assert adapted == {"p1": 1, "p2": 3, "p3": 2}


def test_adapt_named_params_passthrough_p_keys_and_empty():
    from ontology_logic.core.callbacks import adapt_named_params

    sql = "SELECT * FROM t WHERE d < :p1"
    assert adapt_named_params(sql, {"p1": 5}) == (sql, {"p1": 5})
    assert adapt_named_params(sql, {"p1_2": "x"}) == (sql, {"p1_2": "x"})
    assert adapt_named_params(sql, None) == (sql, {})
    assert adapt_named_params(sql, {}) == (sql, {})


def test_execute_sql_sends_adapted_params_over_http():
    """execute_sql 出口：改名后的 SQL/params 才上 HTTP（MockTransport 断言请求体）。"""
    import httpx

    from ontology_logic.core.callbacks import OntologyCallbackClient

    bodies: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        import json as _json

        bodies.append(_json.loads(request.content))
        return httpx.Response(
            200, json={"success": True, "data": {"columns": ["n"], "rows": [[1]], "rowCount": 1}}
        )

    client = OntologyCallbackClient(
        "http://callback.test", service_token="t", transport=httpx.MockTransport(handler)
    )
    try:
        result = client.execute_sql(
            "SELECT count(*) AS n FROM WaferFact WHERE process_date < :ws", {"ws": "2026-09-21"}
        )
        assert result["rowCount"] == 1
        assert bodies[0]["sql"].endswith(":p1")
        assert bodies[0]["params"] == {"p1": "2026-09-21"}
    finally:
        client.close()
