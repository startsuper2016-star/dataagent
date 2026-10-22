"""SPC/RCA 函数注册表 — 三函数 FunctionSpec + 代码体装配。

供 Task 4 MCP 工具层（``ontology_run_logic``）与
``executor.FunctionRuntimeExecutor.run_registered`` 消费：

- ``FUNCTIONS[callable_name]`` → FunctionSpec（callable_name 索引）；
- ``input_schema`` 从元枢 grounding 注册值照抄（workbench ``ont_functions.input_schema``，
  见元枢 ``backend/scripts/spc_mvp_grounding.py`` FUNCTIONS 定义）；
- ``body`` 为沙箱内联执行的函数体源码（COMMON + BODY_xxx，语句序列而非完整函数
  定义），由 executor 以元枢 inline 模式包裹后经 UnifiedSandbox 执行。
"""
from __future__ import annotations

from dataclasses import dataclass, field

from ontology_logic.functions.spc_kernel import BODY_DETECT, BODY_EVIDENCE, BODY_RANK


@dataclass
class FunctionSpec:
    """一个可注册执行的 logic 函数。

    name/callable_name/description/input_schema/tags 与元枢 grounding 注册值一致；
    input_schema 元素形如 ``{name, type, required, description}``（executor 侧会转成
    ParamSchema 做参数类型强制收口）。
    """

    name: str
    callable_name: str
    description: str
    input_schema: list[dict]
    body: str
    tags: list[str] = field(default_factory=list)


FUNCTIONS: dict[str, FunctionSpec] = {
    spec.callable_name: spec
    for spec in (
        FunctionSpec(
            name="SPC异常检测锚定",
            callable_name="spc_detect",
            description=(
                "SPC 离群检测锚定：以窗口前全部数据为基线，I-chart 3σ 判异（wafer 均值粒度，"
                "规避 site 级伪重复），输出异常锚点（窗口/UCL/首检日/异常 Wafer 与 Lot 清单）。"
                "输入可选 window_start/mon_end，输出 {anchor}。"
            ),
            input_schema=[
                {
                    "name": "case_id",
                    "type": "string",
                    "required": False,
                    "description": "Case 编号；提供时校验 Case 声明窗口与当前应用窗口一致",
                },
            ],
            body=BODY_DETECT,
            tags=["logic"],
        ),
        FunctionSpec(
            name="RCA候选因子排名",
            callable_name="rca_rank",
            description=(
                "根因候选因子统计排名：腔体检出率卡方检验（含 Cramér's V）、腔体均值偏移 Welch t、"
                "FDC RF_Power 组间对比与相关，Benjamini-Hochberg FDR 校正后按定义公式评分排序。"
                "输出 {ranking, top1, top_chamber, lot_hint}。"
            ),
            input_schema=[
                {"name": "window_start", "type": "string", "required": False, "description": "分析窗起点"},
            ],
            body=BODY_RANK,
            tags=["logic"],
        ),
        FunctionSpec(
            name="RCA证据评分与门控",
            callable_name="rca_evidence",
            description=(
                "根因证据评分与置信度门控：将机台事件与异常窗对齐，按 QwenPaw 四维"
                "（时间覆盖度/方向一致性/维度吻合度/证据明确度各 25%）评分，与统计分融合"
                "（0.6/0.4）输出排序假设；置信度≥0.70 自动开单，0.40~0.70 仅报告，<0.40 归档。"
                "输出为候选根因+证据链，非因果定论。需传入 rca_rank 的 candidates。"
            ),
            input_schema=[
                {
                    "name": "candidates",
                    "type": "array",
                    "required": True,
                    "description": "rca_rank 输出的 ranking 列表",
                },
                {"name": "window_start", "type": "string", "required": False, "description": "分析窗起点"},
                {"name": "window_end", "type": "string", "required": False, "description": "分析窗终点"},
                {"name": "onset", "type": "string", "required": False, "description": "异常起始日"},
            ],
            body=BODY_EVIDENCE,
            tags=["logic"],
        ),
    )
}


# --- 承接项②：MCP/REST 工具层参数校验（validate_parameters 职责的落点） --------------

_TYPE_CHECKS: dict[str, tuple[type, str]] = {
    # 类型粗校验只覆盖 string/array（三函数 input_schema 仅出现这两类声明）。
    "string": (str, "string"),
    "str": (str, "string"),
    "text": (str, "string"),
    "array": (list, "array"),
    "list": (list, "array"),
}


def validate_logic_params(logic_name: str, params: dict) -> str | None:
    """按 FunctionSpec.input_schema 校验工具入参，返回错误消息（None = 通过）。

    MCP 工具注册层（``ontology_run_logic``）与 REST 面（``/run_logic``）共用：
    - logic_name 未注册 → ``未注册函数: X``；
    - required 参数缺失（或显式 null）→ ``缺少必填参数 X``（多项以"；"连接）；
    - string/array 类型粗校验失败 → ``参数 X 类型错误: 期望 <t>，实为 <实际类型>``。
    错误消息经 MCP isError content 原样透传，供 LLM 自纠。
    """
    spec = FUNCTIONS.get(logic_name)
    if spec is None:
        return f"未注册函数: {logic_name}"
    missing = [
        item["name"]
        for item in spec.input_schema
        if item.get("required") and params.get(item["name"]) is None
    ]
    if missing:
        return "；".join(f"缺少必填参数 {name}" for name in missing)
    for item in spec.input_schema:
        value = params.get(item["name"])
        if value is None:
            continue
        declared = str(item.get("type") or "").lower()
        check = _TYPE_CHECKS.get(declared)
        if check is not None and not isinstance(value, check[0]):
            expected = check[1]
            return f"参数 {item['name']} 类型错误: 期望 {expected}，实为 {type(value).__name__}"
    return None
