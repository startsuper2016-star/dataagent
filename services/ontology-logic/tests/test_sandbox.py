"""Phase 2 Task 2 — 沙箱移植测试（元枢 function_runtime → ontology_logic.core）。

移植判据：沙箱对同一段代码的接受/拒绝判定与元枢版完全一致
（白名单 / 下划线 / 危险调用三类逐一核对），执行侧覆盖
超时（settrace deadline）/ 循环调用 / 深度 / 回调适配（D5 契约）。

回调在单测层用进程内 FakeCallbackClient stub（不经 HTTP）；
HTTP 真实回调的冒烟验证在 Task 4 进行，此处仅以 httpx.MockTransport
核对 OntologyCallbackClient 的 D5 传输契约。
"""
from __future__ import annotations

import json
import time

import httpx
import pytest

from ontology_logic.core.callbacks import OntologyCallbackClient
from ontology_logic.core.executor import (
    CircularCallError,
    FunctionRuntimeExecutor,
    MaxDepthError,
    RegisteredFunction,
)
from ontology_logic.core.models import ExecContext
from ontology_logic.core.sandbox import UnifiedSandbox


class FakeCallbackClient:
    """进程内回调 stub：与 OntologyCallbackClient 助手方法同形，不经 HTTP。"""

    def __init__(self, rows: list[dict] | None = None, error: Exception | None = None):
        self.rows = rows or []
        self.error = error
        self.calls: list[tuple] = []

    def query_rows(self, entity_name, filters, limit=100, offset=0):
        self.calls.append(("query_rows", entity_name, filters, limit, offset))
        if self.error is not None:
            raise self.error
        return self.rows

    def execute_sql(self, sql, params=None):
        self.calls.append(("execute_sql", sql, params))
        if self.error is not None:
            raise self.error
        return {"columns": ["n"], "rows": [[1]], "rowCount": 1}

    def traverse_rows(self, from_entity, from_filters, to_entity, limit=100):
        self.calls.append(("traverse_rows", from_entity, from_filters, to_entity, limit))
        if self.error is not None:
            raise self.error
        return [{"n": 1}]


def _executor(callbacks: FakeCallbackClient | None = None) -> FunctionRuntimeExecutor:
    return FunctionRuntimeExecutor(UnifiedSandbox(), callbacks or FakeCallbackClient())


# --- 1. import 白名单（与元枢逐一相同：numpy 拒绝 / os 属禁止类 / 白名单内放行） ----


def test_import_whitelist_rejects_numpy():
    sandbox = UnifiedSandbox()
    assert not sandbox.validate("import numpy\n").valid
    assert not sandbox.validate("from numpy import array\n").valid
    # os 在 FORBIDDEN_IMPORTS（元枢同一分类文案："禁止导入模块"）
    errors = sandbox.validate("import os\n").errors
    assert any("禁止导入模块: os" in e for e in errors)
    # 白名单内模块与 MODULE_EXPORTS 成员正常接受
    assert sandbox.validate("import json\nimport math\nfrom collections import Counter\n").valid
    # 校验失败在执行层表现为 ValueError（元枢同一文案）
    with pytest.raises(ValueError, match="代码校验失败"):
        UnifiedSandbox().execute("import numpy\n", "f", {})


# --- 2. 禁下划线标识符 -----------------------------------------------------------


def test_underscore_identifiers_rejected():
    """与元枢判定逐一相同：def _f 的"定义"放行（元枢 FunctionDef.name 非 Name 节点），
    任何"引用"（x = _a / _f() / 下划线属性）一律拒绝。"""
    sandbox = UnifiedSandbox()
    assert sandbox.validate("def _f():\n    return 1\n").valid  # 定义本身放行（元枢同判）
    assert not sandbox.validate("x = _a\n").valid
    assert not sandbox.validate("def _f():\n    return 1\n\n_f()\n").valid
    assert not sandbox.validate("import json\njson._default_encoder\n").valid
    errors = sandbox.validate("def _f():\n    return 1\n\n_f()\n").errors
    assert any("禁止访问私有名称: _f" in e for e in errors)
    errors = sandbox.validate("x = _a\n").errors
    assert any("禁止访问私有名称: _a" in e for e in errors)


# --- 3. 正常执行 -----------------------------------------------------------------


def test_plain_function_execution():
    ex = _executor()
    ex.register(RegisteredFunction("f", "f", "def f(params):\n    return params.get('x') * 2\n"))
    result = ex.execute("f", {"x": 2})
    assert result.success is True
    assert result.result == 4
    assert result.call_trace == ["f"]


# --- 4. import math + math.sqrt --------------------------------------------------


def test_math_import_execution():
    ex = _executor()
    ex.register(
        RegisteredFunction("f", "f", "import math\n\ndef f(params):\n    return math.sqrt(params.get('x'))\n")
    )
    result = ex.execute("f", {"x": 16})
    assert result.success is True
    assert result.result == 4.0


# --- 5. 回调成功：函数消费 query_objects fake 数据 --------------------------------


def test_callback_query_objects_consumed():
    fake = FakeCallbackClient(rows=[{"region": "east", "qty": 3}, {"region": "east", "qty": 4}])
    ex = _executor(fake)
    ex.register(
        RegisteredFunction(
            "f",
            "f",
            "def f(params):\n"
            "    rows = query_objects('spc_record', {'region': params.get('region')})\n"
            "    return sum(r['qty'] for r in rows)\n",
        )
    )
    result = ex.execute("f", {"region": "east"})
    assert result.success is True
    assert result.result == 7
    # fake 收到的实参与元枢 helper 签名一致
    assert fake.calls == [("query_rows", "spc_record", {"region": "east"}, 100, 0)]


# --- 6. 回调失败（D5 不重试）：异常正常进入函数作用域并向上传播 ---------------------


def test_callback_error_propagates_without_retry():
    fake = FakeCallbackClient(error=RuntimeError("ontology 回调超时（D5 不重试）"))
    ex = _executor(fake)
    # (a) 函数内可捕获 RuntimeError —— 异常正常传播进函数作用域
    ex.register(
        RegisteredFunction(
            "catcher",
            "catcher",
            "def catcher(params):\n"
            "    try:\n"
            "        query_objects('spc_record', {})\n"
            "        return 'no-error'\n"
            "    except RuntimeError as err:\n"
            "        return 'caught'\n",
        )
    )
    assert ex.execute("catcher", {}).result == "caught"
    # (b) 不捕获 → 执行失败，错误原文进入 ExecResult.error，且每次调用只打一发（无重试）
    ex.register(
        RegisteredFunction("plain", "plain", "def plain(params):\n    return query_objects('spc_record', {})\n")
    )
    result = ex.execute("plain", {})
    assert result.success is False
    assert "D5" in result.error
    assert len([c for c in fake.calls if c[0] == "query_rows"]) == 2  # catcher + plain 各一次


# --- 7. settrace 行级 deadline 超时（Windows 无 SIGALRM 的既有限制如实保留） -------


def test_settrace_deadline_timeout():
    ex = _executor()
    ex.register(RegisteredFunction("spin", "spin", "def spin(params):\n    while True:\n        pass\n"))
    start = time.monotonic()
    result = ex.execute("spin", {}, context=ExecContext(timeout_sec=1))
    elapsed = time.monotonic() - start
    assert result.success is False
    assert "函数执行超时" in result.error
    assert elapsed < 5  # deadline trace 生效，不挂死
    # 沙箱层直接契约：TimeoutError
    with pytest.raises(TimeoutError):
        UnifiedSandbox().execute("def spin(params):\n    while True:\n        pass\n", "spin", {}, timeout=1)


# --- 8. 循环调用 f → g → f --------------------------------------------------------


def test_circular_call_detected():
    ex = _executor()
    ex.register(RegisteredFunction("f", "f", "def f(params):\n    return call_function('g', params)\n"))
    ex.register(RegisteredFunction("g", "g", "def g(params):\n    return call_function('f', params)\n"))
    with pytest.raises(CircularCallError, match="循环调用"):
        ex.execute("f", {})


# --- 9. 自递归触达最大深度（MaxDepthError） ---------------------------------------


def test_self_recursion_depth_limit():
    ex = _executor()
    ex.register(RegisteredFunction("r", "r", "def r(params):\n    return call_function('r', params)\n"))
    with pytest.raises(MaxDepthError, match="最大递归深度"):
        ex.execute("r", {})


# --- OntologyCallbackClient D5 传输契约（httpx.MockTransport，不发真实网络请求） ----


def test_callback_client_success_envelope():
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/api/v1/ontology/query"
        assert request.headers["Authorization"] == "Bearer tok-123"
        assert json.loads(request.content) == {"entity": "spc", "filters": {"a": 1}, "limit": 5, "offset": 2}
        return httpx.Response(
            200, json={"success": True, "data": {"columns": ["a"], "rows": [[1], [2]], "rowCount": 2}}
        )

    client = OntologyCallbackClient("http://api.test", service_token="tok-123", transport=httpx.MockTransport(handler))
    try:
        assert client.query_rows("spc", {"a": 1}, limit=5, offset=2) == [{"a": 1}, {"a": 2}]
    finally:
        client.close()


def test_callback_client_error_envelope_raises_once():
    calls: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        return httpx.Response(
            400,
            json={"success": False, "error": {"code": "BAD_REQUEST", "message": "未知实体: ghost"}},
        )

    client = OntologyCallbackClient("http://api.test", transport=httpx.MockTransport(handler))
    try:
        with pytest.raises(RuntimeError, match="未知实体: ghost"):
            client.query_rows("ghost", {})
        assert len(calls) == 1  # D5：失败即抛，绝不重试
    finally:
        client.close()


def test_callback_client_transport_timeout_raises():
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectTimeout("connection timed out")

    client = OntologyCallbackClient("http://api.test", transport=httpx.MockTransport(handler))
    try:
        with pytest.raises(RuntimeError, match="D5 不重试"):
            client.execute_sql("SELECT 1", {})
    finally:
        client.close()


def test_callback_client_default_timeout_is_d5_five_seconds():
    client = OntologyCallbackClient("http://api.test")
    client.close()
    assert client.timeout.connect == 2.0
    assert client.timeout.read == 5.0
