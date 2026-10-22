"""SPC/RCA registered logic functions.

- spc_kernel: 统计内核函数体字符串（COMMON + BODY_DETECT/BODY_RANK/BODY_EVIDENCE，
  元枢 ``backend/scripts/spc_kernel.py`` 逐字节搬移）。
- registry: ``FUNCTIONS`` 注册表（callable_name → FunctionSpec），input_schema
  与元枢 grounding 注册值一致，供 executor.run_registered 与 MCP 工具层消费。
"""

from ontology_logic.functions.registry import FUNCTIONS, FunctionSpec, validate_logic_params

__all__ = ["FUNCTIONS", "FunctionSpec", "validate_logic_params"]
