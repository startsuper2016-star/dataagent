"""Function runtime data models — ported verbatim from 元枢
``backend/app/services/function_runtime/models.py``.

超时常量：单函数 30s / 调用链 120s / 递归深度 10（元枢 ExecContext 默认值，
此处提为具名常量供 config / 执行器引用，数值语义不变）。

FunctionWriteRequested 继承 BaseException：在 stop-the-world 语义下脚本的
except Exception 处理器无法把一次预览变成真实写入（写路径在本部署中由
apps/api 承担，本类仅保留类型以维持 ExecContext.failure_outcome 契约）。
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal

# 单函数执行超时（秒）
DEFAULT_TIMEOUT_SEC = 30
# call_function 调用链总超时（秒）
DEFAULT_TOTAL_TIMEOUT_SEC = 120
# 最大递归深度
DEFAULT_MAX_DEPTH = 10


@dataclass
class ParamSchema:
    name: str
    type: str
    required: bool
    description: str
    schema: dict = field(default_factory=dict)


@dataclass
class FunctionMeta:
    callable_name: str
    description: str
    type: Literal["logic", "action"]
    params: list[ParamSchema]
    return_type: str
    source_path: str
    func_name: str
    ontology_id: str | int | None
    checksum: str


@dataclass
class ExecContext:
    call_stack: list[str] = field(default_factory=list)
    max_depth: int = DEFAULT_MAX_DEPTH
    timeout_sec: int = DEFAULT_TIMEOUT_SEC
    total_timeout_sec: int = DEFAULT_TOTAL_TIMEOUT_SEC
    ontology_id: str | int | None = None
    _chain_start: float | None = None
    # 融合裁剪说明：以下授权/写路径字段为元枢原形保留（entity/function 授权过滤与
    # update_object 写入由 apps/api 承担）；在本部署中它们保持惰性，仅维持
    # failure_outcome / FunctionWriteRequested 契约形状不变。
    version_id: str | None = None
    entity_ids: frozenset[str] | None = None
    function_ids: frozenset[str] | None = None
    user: Any = None
    action_mode: Literal["read", "simulation", "confirm", "execute"] = "read"
    allowed_tools: frozenset[str] | None = None
    committed_writes: list[dict] = field(default_factory=list)
    active_write: dict | None = None

    def check_entity(self, entity_id):
        if self.entity_ids is not None and entity_id not in self.entity_ids:
            raise PermissionError("对象不在当前授权范围内")

    def failure_outcome(self, error):
        outcome = getattr(error, "outcome", None)
        if outcome in {"unknown", "committed_unrecorded"}:
            return outcome
        if self.active_write is not None:
            return "unknown"
        return "partial_committed" if self.committed_writes else outcome


class FunctionWriteRequested(BaseException):
    """Stop before a write; script exception handlers cannot turn a preview into a write."""
    def __init__(self, request):
        self.request = request


@dataclass
class ExecResult:
    success: bool
    result: Any
    error: str | None
    execution_ms: int
    call_trace: list[str]
    outcome: str | None = None
    requested_write: dict | None = None
    committed_writes: list[dict] = field(default_factory=list)
