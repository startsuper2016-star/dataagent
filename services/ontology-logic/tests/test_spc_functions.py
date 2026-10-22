"""Phase 2 Task 3 — 统计内核 + RCA 三函数注册测试。

- 四段内核字符串的逐字节搬移判据：SHA-256 对搬移时自元枢
  ``backend/scripts/spc_kernel.py`` 计算的摘要逐一锁定（COMMON/BODY_*）。
- 三函数真数据流：进程内 fake 回调实现（query_objects 支持 gte 过滤与
  offset/limit 翻页、call_complex_sql 返回聚合行），不经 HTTP；
  rca_evidence 消费 rca_rank 的真实输出（与元枢 run_offline 同链路）。
- 循环/深度异常经 run_registered 类型化穿透（MCP 层可见）。
- ValueError 核对（承接项①）：静态 AST 检查三段函数体内不存在包裹
  query_objects/call_complex_sql/traverse 调用的 except 块（实体缺失现为
  RuntimeError，D5 回调口径），并核对唯一的 ``except Exception`` 位置。
"""
from __future__ import annotations

import ast
import hashlib

import pytest

from ontology_logic.core.executor import (
    CircularCallError,
    FunctionRuntimeExecutor,
    MaxDepthError,
    RegisteredFunction,
    wrap_inline_body,
)
from ontology_logic.core.models import DEFAULT_MAX_DEPTH, ExecContext
from ontology_logic.core.sandbox import UnifiedSandbox
from ontology_logic.functions import spc_kernel
from ontology_logic.functions.registry import FUNCTIONS, FunctionSpec

# 搬移时自元枢源文件逐字节计算的摘要（backend/scripts/spc_kernel.py）。
KERNEL_DIGESTS = {
    "COMMON": "702d369da3360ab30657750b3f77e3dcbca456c2d89f7f22bc65f9b47eb7663c",
    "BODY_DETECT": "34d418d3731510d4ea70c7ff880f292de4905090513080c048bf38f99418a953",
    "BODY_RANK": "4383b8408f090fdc0b2d1a3c75c01eb2a3cf63c45d12f2903fa021b7bfac60b1",
    "BODY_EVIDENCE": "e959ff309433ae3cfc38231503c16a9770b915c54328557044c9f8a48e87a1c0",
}


# --- 进程内 fake 回调（不走 HTTP）-------------------------------------------------


def _fake_callbacks(tables: dict[str, list[dict]], baseline_row: tuple):
    """query_callbacks 实现映射：返回 (mapping, calls)。

    - query_objects 支持 ``{key: {'gte': v}}`` 范围过滤与 offset/limit 翻页
      （与元枢 helper 同签名，供 AnomWafer 翻页循环消费）；
    - call_complex_sql 返回 WaferFact 基线聚合行（n, sum_x, sum_x2）；
    - calls 记录每次调用（供 D5「不重试」计数断言）。
    """
    calls: list[tuple] = []

    def query_objects(entity_name, filters, limit=100, offset=0):
        calls.append(("query_objects", entity_name, dict(filters or {}), limit, offset))
        rows = tables.get(entity_name, [])
        for key, cond in (filters or {}).items():
            if isinstance(cond, dict) and "gte" in cond:
                rows = [r for r in rows if r[key] >= cond["gte"]]
            else:
                rows = [r for r in rows if r[key] == cond]
        return rows[offset : offset + limit]

    def call_complex_sql(sql, params=None):
        calls.append(("call_complex_sql", sql, params))
        return {"columns": ["n", "sum_x", "sum_x2"], "rows": [list(baseline_row)], "rowCount": 1}

    def traverse(from_entity, from_filters, to_entity, limit=100):
        calls.append(("traverse", from_entity, to_entity, limit))
        return []

    mapping = {"query_objects": query_objects, "call_complex_sql": call_complex_sql, "traverse": traverse}
    return mapping, calls


WINDOW_CFG = [{"window_start": "2026-09-21", "window_end": "2026-09-22"}]
BASELINE = (60, 240.0, 1000.0)  # n=60, mean=4.0, var=2/3 → sigma≈0.8165, UCL3≈6.4495

DETECT_TABLES = {
    "WindowConfig": WINDOW_CFG,
    "RcaDaily": [
        {"stat_date": "2026-09-21", "n": 3, "n_over_ucl": 2},
        {"stat_date": "2026-09-22", "n": 3, "n_over_ucl": 1},
    ],
    "AnomWafer": [
        {"lot_id": "L1", "rs_ti_mean": 6.8},
        {"lot_id": "L1", "rs_ti_mean": 7.1},
        {"lot_id": "L2", "rs_ti_mean": 6.9},
    ],
    "SpcCase": [],
}

RANK_TABLES = {
    "WindowConfig": WINDOW_CFG,
    "RcaFdcCorr": [{"n": 24, "sum_x": 1200.0, "sum_x2": 60100.0, "sum_y": 100.0, "sum_y2": 430.0, "sum_xy": 5029.0}],
    "RcaChamberRate": [
        {"chamber_id": "CH_B", "win_n": 10, "win_anom_n": 8},
        {"chamber_id": "CH_A", "win_n": 10, "win_anom_n": 1},
    ],
    "RcaChamberComp": [
        {"chamber_id": "CH_B", "grp": "win", "n": 10, "sum_x": 50.0, "sum_x2": 255.0},
        {"chamber_id": "CH_B", "grp": "base", "n": 20, "sum_x": 60.0, "sum_x2": 186.0},
    ],
    "RcaFdcGroup": [
        {"grp": "anom", "n": 8, "sum_x": 320.0, "sum_x2": 12820.0},
        {"grp": "ctrl", "n": 16, "sum_x": 800.0, "sum_x2": 40080.0},
    ],
    "RcaAnomLot": [{"lot_id": "L1", "anom_n": 5}, {"lot_id": "L2", "anom_n": 3}],
}

EVIDENCE_TABLES = {
    "ToolEvent": [
        {
            "id": 1,
            "event_type": "PM",
            "chamber_id": "CH_B",
            "event_start": "2026-09-21",
            "event_end": "2026-09-22",
            "event_desc": "换靶后功率匹配未复校，异常偏移未恢复",
        },
        {
            "id": 2,
            "event_type": "PM",
            "chamber_id": "CH_A",
            "event_start": "2026-09-25",
            "event_end": "2026-09-25",
            "event_desc": "例行保养，无异常",
        },
    ]
}


def _executor(callbacks=None) -> FunctionRuntimeExecutor:
    # self.callbacks 传 None：run_registered 一律走显式 query_callbacks（不经 HTTP）。
    return FunctionRuntimeExecutor(UnifiedSandbox(), callbacks)


# --- 1. 逐字节搬移判据 -------------------------------------------------------------


def test_kernel_strings_byte_digests():
    """四段常量与元枢源文件逐字节一致（SHA-256 锁定，防搬运走样）。"""
    for const, digest in KERNEL_DIGESTS.items():
        value = getattr(spc_kernel, const)
        assert isinstance(value, str)
        assert hashlib.sha256(value.encode("utf-8")).hexdigest() == digest, const
    # 三段 BODY 均含 COMMON（元枢同构：BODY_x = COMMON + r'''...'''）
    common = spc_kernel.COMMON
    assert spc_kernel.BODY_DETECT.startswith(common)
    assert spc_kernel.BODY_RANK.startswith(common)
    assert spc_kernel.BODY_EVIDENCE.startswith(common)


# --- 2. 注册表 -------------------------------------------------------------------


def test_registry_specs_match_grounding():
    assert set(FUNCTIONS) == {"spc_detect", "rca_rank", "rca_evidence"}
    for spec in FUNCTIONS.values():
        assert isinstance(spec, FunctionSpec)
        assert spec.tags == ["logic"]
        assert spec.body.startswith(spc_kernel.COMMON)
    # input_schema 与元枢 grounding 注册值一致（workbench ont_functions.input_schema）
    assert FUNCTIONS["spc_detect"].input_schema == [
        {"name": "case_id", "type": "string", "required": False,
         "description": "Case 编号；提供时校验 Case 声明窗口与当前应用窗口一致"},
    ]
    assert FUNCTIONS["rca_rank"].input_schema == [
        {"name": "window_start", "type": "string", "required": False, "description": "分析窗起点"},
    ]
    assert FUNCTIONS["rca_evidence"].input_schema == [
        {"name": "candidates", "type": "array", "required": True, "description": "rca_rank 输出的 ranking 列表"},
        {"name": "window_start", "type": "string", "required": False, "description": "分析窗起点"},
        {"name": "window_end", "type": "string", "required": False, "description": "分析窗终点"},
        {"name": "onset", "type": "string", "required": False, "description": "异常起始日"},
    ]


def test_wrap_inline_body_shape():
    code = wrap_inline_body("result = params.get('x')\nresult = result * 2\n")
    assert code == (
        "def inline_function(params):\n"
        "    result = None\n"
        "    result = params.get('x')\n"
        "    result = result * 2\n"
        "    return result\n"
    )
    assert UnifiedSandbox().validate(code).valid


# --- 3. 三函数真数据流（fake 回调）-------------------------------------------------


def test_run_registered_spc_detect():
    callbacks, calls = _fake_callbacks(DETECT_TABLES, BASELINE)
    ex = _executor()
    anchor = ex.run_registered(None, "spc_detect", {}, callbacks)["anchor"]
    assert anchor["station"] == "PVD_TI"
    assert anchor["window_start"] == "2026-09-21"
    assert anchor["window_end"] == "2026-09-22"
    assert anchor["baseline"] == {"n": 60, "mean": 4.0, "sigma": 0.8165, "ucl3": 6.4495}
    assert anchor["first_violation_day"] == "2026-09-21"
    assert anchor["anom_days"] == 2
    assert anchor["win_wafer_n"] == 6
    assert anchor["anom_wafer_n"] == 3
    assert anchor["wafer_list_truncated"] is False
    assert anchor["anom_lot_n"] == 2
    assert anchor["anom_lots"] == ["L1", "L2"]
    assert anchor["anomaly"] == "high"
    assert anchor["magnitude_sigma"] == 3.8  # (7.1-4.0)/0.8165
    assert anchor["rule"].startswith("I-chart 3-sigma")
    # RcaDaily 走 gte 范围过滤；基线走 call_complex_sql（各至少一次）
    assert any(c[1] == "RcaDaily" and c[2] == {"stat_date": {"gte": "2026-09-21"}} for c in calls)
    assert any(c[0] == "call_complex_sql" for c in calls)


def test_run_registered_rca_rank():
    callbacks, _ = _fake_callbacks(RANK_TABLES, BASELINE)
    ex = _executor()
    result = ex.run_registered(None, "rca_rank", {}, callbacks)
    assert set(result) == {"ranking", "top1", "top_chamber", "rates_concentrate", "lot_hint"}
    assert result["top_chamber"] == "CH_B"
    assert result["rates_concentrate"] is True
    assert result["top1"] == result["ranking"][0]["factor"]
    scores = [cd["score"] for cd in result["ranking"]]
    assert scores == sorted(scores, reverse=True)
    for cd in result["ranking"]:
        for key in ("factor", "kind", "dim", "test", "stat", "p", "p_adj", "effect", "coverage", "n", "score"):
            assert key in cd, (cd["factor"], key)
    # 因子面：腔体检出率卡方 + 腔体前后偏移 Welch t + FDC 组间对比
    factors = [cd["factor"] for cd in result["ranking"]]
    assert "CH_B" in factors
    assert "CH_B 前后偏移" in factors
    assert "RF_Power_Mean (FDC)" in factors
    assert result["lot_hint"] == {"top_lot": "L1", "n": 5, "concentration": 0.56}


def test_run_registered_rca_evidence_chain():
    """rca_evidence 消费 rca_rank 真实输出（元枢 run_offline 同链路）。"""
    rank_callbacks, _ = _fake_callbacks(RANK_TABLES, BASELINE)
    ev_callbacks, ev_calls = _fake_callbacks(EVIDENCE_TABLES, BASELINE)
    ex = _executor()
    rank = ex.run_registered(None, "rca_rank", {}, rank_callbacks)
    result = ex.run_registered(
        None,
        "rca_evidence",
        {"candidates": rank["ranking"], "window_start": "2026-09-21",
         "window_end": "2026-10-20", "onset": "2026-09-21"},
        ev_callbacks,
    )
    assert set(result) == {"conclusion", "confidence", "gate", "gate_action", "hypotheses", "disclaimer"}
    assert any(c[1] == "ToolEvent" for c in ev_calls)
    hypotheses = result["hypotheses"]
    assert [h["event_id"] for h in hypotheses] == [1, 2]  # 按 final_weight 降序
    weights = [h["final_weight"] for h in hypotheses]
    assert weights == sorted(weights, reverse=True)
    for h in hypotheses:
        assert {"time_cov", "dir", "dim_match", "evidence", "evidence_weight", "final_weight"} <= set(h)
    # 真因事件：CH_B 换靶（时间对齐 + 方向提示 + 维度吻合 + 证据明确）
    assert hypotheses[0]["dim_match"] == 1.0
    assert hypotheses[0]["evidence"] == 1.0
    assert hypotheses[0]["dir"] == 1.0
    # 红鲱鱼（CH_A 例行保养）证据明确度低、维度不吻合
    assert hypotheses[1]["dim_match"] == 0.0
    assert hypotheses[1]["evidence"] == 0.5
    # 门控与置信度
    assert result["gate"] == "auto_ticket"
    assert result["confidence"] == hypotheses[0]["final_weight"]
    assert 0.70 <= result["confidence"] < 1.0


# --- 4. 注册表与执行入口防御 -------------------------------------------------------


def test_run_registered_unknown_function_raises():
    ex = _executor()
    with pytest.raises(ValueError, match="未注册函数"):
        ex.run_registered(None, "ghost_function", {}, None)


def test_version_id_rejected_carryover_3():
    """承接项③：ExecContext.version_id 非空时显式拒绝（版本快照路径随 SQLAlchemy 裁剪）。"""
    ex = _executor()
    with pytest.raises(RuntimeError, match="独立侧车不支持 version_id 执行"):
        ex.execute("f", {}, context=ExecContext(version_id="v-1"))
    callbacks, _ = _fake_callbacks(DETECT_TABLES, BASELINE)
    with pytest.raises(RuntimeError, match="独立侧车不支持 version_id 执行"):
        ex.run_registered(None, "spc_detect", {}, callbacks, context=ExecContext(version_id="v-1"))


def test_run_registered_callback_error_raises_once():
    """D5：回调失败归一 RuntimeError 向上抛（run_registered 不吞），且不重试。"""
    calls: list[tuple] = []

    def failing_query_objects(entity_name, filters, limit=100, offset=0):
        calls.append((entity_name, dict(filters or {})))
        raise RuntimeError("ontology 回调 /api/v1/ontology/query 失败: D5 不重试")

    ex = _executor()
    stub_callbacks = {
        "query_objects": failing_query_objects,
        "call_complex_sql": lambda s, p=None: {},
        "traverse": lambda *a, **k: [],
    }
    with pytest.raises(RuntimeError, match="D5 不重试"):
        ex.run_registered(None, "spc_detect", {}, stub_callbacks)
    assert len(calls) == 1  # 单发不重试


def test_run_registered_missing_callback_impl_is_unavailable_stub():
    """缺省回调实现落 unavailable 桩（与 sandbox shim 同文案），不影响其余回调注入。"""
    callbacks, _ = _fake_callbacks(DETECT_TABLES, BASELINE)
    callbacks.pop("traverse")
    ex = _executor()
    ex.run_registered(None, "spc_detect", {}, callbacks)  # spc_detect 不用 traverse → 正常完成


def test_run_registered_circular_and_depth_visible_at_mcp_layer():
    """循环/深度守卫复用 execute() 链路：类型化异常从 run_registered 穿透（MCP 层可见）。

    经 MCP 编排共享同一 ExecContext 时，rca_rank → hop → call_function('rca_rank')
    的第三跳即循环；此处以预置调用栈模拟前两跳已完成。
    """
    callbacks, _ = _fake_callbacks(RANK_TABLES, BASELINE)
    ex = _executor()
    ex.run_registered(None, "rca_rank", {}, callbacks)  # 注册内联条目（供 call_function 递归）
    assert "rca_rank" in ex.functions
    assert ex.functions["rca_rank"].func_name == "inline_function"
    ex.register(
        RegisteredFunction("hop", "hop", "def hop(params):\n    return call_function('rca_rank', params)\n")
    )
    circular_ctx = ExecContext()
    circular_ctx.call_stack.extend(["rca_rank", "hop"])
    with pytest.raises(CircularCallError, match="循环调用"):
        ex.run_registered(None, "rca_rank", {}, callbacks, context=circular_ctx)

    depth_ctx = ExecContext()
    depth_ctx.call_stack.extend(["r"] * DEFAULT_MAX_DEPTH)
    with pytest.raises(MaxDepthError, match="最大递归深度"):
        ex.run_registered(None, "rca_rank", {}, callbacks, context=depth_ctx)


# --- 5. ValueError 核对（承接项①）：回调调用不被 except ValueError 包裹 -------------


def _except_handlers(code: str) -> list[ast.ExceptHandler]:
    return [n for n in ast.walk(ast.parse(code)) if isinstance(n, ast.ExceptHandler)]


def _callback_calls_inside_except(body: str) -> list[str]:
    """函数体内被 except 块包裹的数据回调调用（query_objects 等）清单。"""
    hits: list[str] = []
    for node in _except_handlers(wrap_inline_body(body)):
        for sub in ast.walk(node):
            if (
                isinstance(sub, ast.Call)
                and isinstance(sub.func, ast.Name)
                and sub.func.id in {"query_object", "query_objects", "call_complex_sql", "traverse"}
            ):
                hits.append(sub.func.id)
    return hits


def test_no_except_valueerror_wrapping_callbacks():
    """三段函数体：无 ``except ValueError``；数据回调调用不在任何 except 块内。

    元枢实体缺失曾抛 ValueError、现由 apps/api 400 错误信封归一为 RuntimeError
    （D5 口径）；BODY_DETECT 中两处 ``raise ValueError`` 为显式业务校验（Case 不存在 /
    窗口不一致），语义保留。
    """
    for name in ("spc_detect", "rca_rank", "rca_evidence"):
        body = FUNCTIONS[name].body
        assert "except ValueError" not in body, name
        assert _callback_calls_inside_except(body) == [], name
    assert _except_handlers(wrap_inline_body(FUNCTIONS["spc_detect"].body)) == []
    assert _except_handlers(wrap_inline_body(FUNCTIONS["rca_rank"].body)) == []
    # BODY_EVIDENCE 唯一的宽 except：dayno 日期解析兜底（非回调包裹），照原样保留并在此记录
    evidence_handlers = _except_handlers(wrap_inline_body(FUNCTIONS["rca_evidence"].body))
    assert len(evidence_handlers) == 1
    assert isinstance(evidence_handlers[0].type, ast.Name)
    assert evidence_handlers[0].type.id == "Exception"
