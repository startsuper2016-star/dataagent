# Phase 2 Task 3 报告 — 统计内核 + RCA 三函数注册（承接项①③落实）

- **状态**: 完成
- **Commit**: `d52983d` — `phase2: spc kernel + rca functions registered (carry-forwards applied)`（已 push origin main）
- **测试**: `uv run pytest` → **27 passed**（新增 12 = 搬移判据 1 + 注册表 2 + 三函数真数据流 3 + 防御/异常 4 + ValueError 静态核对 1 + inline 包裹形状 1；含 Task 1/2 既有 15 项）；`uv run ruff check src tests` → All checks passed
- **金标核对**（开发期验证，不入库）：以元枢 `local-data/spc_mvp/spc_mvp.db` 为数据源、按元枢离线 shim 语义构造进程内 query_callbacks，`run_registered` 三函数全链路输出与元枢原版 `run_offline` **逐项一致**：baseline `{n:1990, mean:4.6018, sigma:0.0821, ucl3:4.8481}`、`anom_wafer_n=243`、首检日 `2026-09-21`、异常 31 日、top1 `PVD01_CH_B 前后偏移`、门控 `auto_ticket`、置信度 `0.875`。（计划中 Task 4 写的 UCL=4.8405 为旧库基线——当前元枢库原版跑出同样是 4.8481，移植无偏差，见"疑虑"。）

## 新增 / 修改文件

| 文件 | 内容 |
| --- | --- |
| `services/ontology-logic/src/ontology_logic/functions/spc_kernel.py` | 元枢 `backend/scripts/spc_kernel.py` 的 `COMMON` / `BODY_DETECT` / `BODY_RANK` / `BODY_EVIDENCE` 四段字符串**逐字节搬移**（脚本化按行段拷贝，非手抄；SHA-256 摘要锁定，见下表）。元枢离线 runner（run_offline/sqlite shim/其余 BODY_*）不随迁 |
| `src/ontology_logic/functions/registry.py` | `FunctionSpec`（name/callable_name/description/input_schema/body/tags）+ `FUNCTIONS: dict[str, FunctionSpec]`（callable_name → spec，spc_detect/rca_rank/rca_evidence 三条）；input_schema 从元枢 grounding 注册值照抄（workbench `ont_functions.input_schema` 实测值） |
| `src/ontology_logic/functions/__init__.py` | 导出 `FUNCTIONS` / `FunctionSpec` |
| `src/ontology_logic/core/executor.py` | ① 承接项③ version_id 防御：`ExecContext.version_id` 非空 → `raise RuntimeError("独立侧车不支持 version_id 执行")`；② 新增 `run_registered(conn_or_none, callable_name, params, query_callbacks, *, context=None)` 便捷入口；③ `execute`/`_build_call_function`/`_build_ontology_helpers` 增加 `query_callbacks` 进程内回调实现映射的透传（None 回落 self.callbacks HTTP 回调，行为不变） |
| `tests/test_spc_functions.py` | 12 项测试（见下） |

## 内核字符串逐字节搬移判据（SHA-256，元枢源文件 ↔ 侧车副本）

| 常量 | 字节数 | SHA-256 |
| --- | --- | --- |
| COMMON | 3604 | `702d369da3360ab30657750b3f77e3dcbca456c2d89f7f22bc65f9b47eb7663c` |
| BODY_DETECT | 6345 | `34d418d3731510d4ea70c7ff880f292de4905090513080c048bf38f99418a953` |
| BODY_RANK | 9529 | `4383b8408f090fdc0b2d1a3c75c01eb2a3cf63c45d12f2903fa021b7bfac60b1` |
| BODY_EVIDENCE | 7182 | `e959ff309433ae3cfc38231503c16a9770b915c54328557044c9f8a48e87a1c0` |

搬移方式：脚本按源文件行段（含原版分段注释横幅）拷贝后，import 双侧模块逐常量做 `==` 全等比对（全部 OK），测试内以摘要断言锁死防后续走样。三段 BODY 通过 `UnifiedSandbox.validate`（包裹后）全部 valid。

## run_registered 设计（供 Task 4 MCP 层消费）

```
run_registered(conn_or_none, callable_name, params, query_callbacks, *, context=None) -> result
```

- `conn_or_none`：预留形参（元枢离线 runner 的 sqlite conn 直连形态）；本部署数据访问一律走 `query_callbacks`，传 None 即可。
- `query_callbacks`：`{"query_objects", "call_complex_sql", "traverse"}` 回调实现映射（与元枢 helper 同签名）；None 回落 `self.callbacks`（HTTP 回调）；缺失项落 unavailable 桩（`当前执行入口未提供 X 能力`，与 sandbox shim 同文案）。
- 内部：registry 取 spec → 以元枢 inline 模式包裹（`def inline_function(params): result=None; <body>; return result`，`wrap_inline_body`）→ 转成 `RegisteredFunction`（param_schemas 由 input_schema 生成，入参仍经 `_coerce_params` 类型收口）→ 注册进 `self.functions` → `self.execute(...)`。
- **循环/深度守卫复用 execute() 链路**：内联条目进注册表后，同链 `call_function` 递归共享同一 ExecContext，`CircularCallError` / `MaxDepthError`（T2 改为抛类型异常）从 run_registered 原样穿透到 MCP 层；`context` 关键字参数默认 None=新链，编排/测试可传共享 context（Task 4 单工具调用无需关心）。
- 其余运行期异常收敛为 `RuntimeError`（携带 ExecResult.error 原文与 outcome），供 MCP isError content。

## 测试覆盖（tests/test_spc_functions.py，12 项）

1. **搬移判据**：四段常量 SHA-256 与元枢源文件摘要逐一相等；三段 BODY 均以 COMMON 开头。
2. **注册表**：FUNCTIONS 恰含三函数；tags==["logic"]；input_schema 与元枢 grounding 实测值逐字段一致。
3. **inline 包裹形状**：`wrap_inline_body` 输出逐字符断言（`def inline_function(params): result=None; <body>; return result`）且过沙箱校验。
4. **spc_detect 真数据流**：fake 回调（gte 过滤 + offset/limit 翻页），断言 anchor 全结构（station/window/baseline{n,mean,sigma,ucl3}={60,4.0,0.8165,6.4495}、首检日、anom_wafer_n=3、lots、magnitude_sigma=3.8、truncated=False）及 RcaDaily gte 过滤与 call_complex_sql 调用实况。
5. **rca_rank 真数据流**：卡方/Welch/FDC 三类候选齐备、评分降序、top1==ranking[0].factor、rates_concentrate、top_chamber、lot_hint。
6. **rca_evidence 链路**：消费 rca_rank 真实输出（元枢 run_offline 同链路），final_weight 降序、真因（CH_B 换靶）dim_match/dir/evidence 全 1.0、红鲱鱼（CH_A 例行）低分、gate=auto_ticket、confidence==top final_weight。
7. **未注册函数** → ValueError。
8. **version_id 防御**（承接项③）：execute 与 run_registered 双入口均 `RuntimeError("独立侧车不支持 version_id 执行")`。
9. **回调失败 D5**：RuntimeError 上抛不吞、单发不重试（调用计数=1）。
10. **缺失回调实现** → unavailable 桩（spc_detect 不用 traverse 照常完成）。
11. **循环/深度经 run_registered 可见**：共享 context 预置两跳后第三跳 `CircularCallError`；栈满 10 层 `MaxDepthError`（文案断言）。
12. **ValueError 静态核对**（承接项①，AST）：三段函数体无 `except ValueError`；`query_objects/call_complex_sql/traverse` 调用不在任何 except 块内；spc_detect/rca_rank 零 except；rca_evidence 唯一 `except Exception` 位于 `dayno` 日期解析兜底（非回调包裹，原样保留并记录）。

## 承接项落实

| 承接项 | 落实 |
| --- | --- |
| ① ValueError 核对 | 三段 BODY 中 `query_objects` 周围**无任何 `except ValueError` 包裹**（BODY_DETECT 的两处 `raise ValueError` 是显式业务校验：Case 不存在/窗口不一致，语义保留）；唯一宽兜底是 BODY_EVIDENCE `dayno` 的 `except Exception`（纯字符串日期解析，不涉及回调），测试以 AST 断言固化并记录。实体缺失错误类型已随 D5 回调口径变为 RuntimeError，测试 9 项验证其可穿透。 |
| ③ version_id 防御 | `execute()` 入口处 `context.version_id is not None → raise RuntimeError("独立侧车不支持 version_id 执行")`；run_registered 经同一入口生效。 |

## 疑虑 / 偏差说明

1. **spc_detect 的 input_schema 与任务描述括注不一致**：任务括注写 `window_start/mon_end`，但元枢 grounding 实际注册值（`spc_mvp_grounding.py` 与 workbench `ont_functions.input_schema` 实测一致）是 `case_id`（可选 string，校验 Case 声明窗口）。任务要求"从元枢 grounding 时的定义照抄"，故**照抄为 case_id**；description 原文（含"输入可选 window_start/mon_end"字样）也照抄未改——元枢侧该描述与 schema 本就不一致，属元枢原文瑕疵，未修。
2. **金标 UCL=4.8405 → 4.8481**：计划 Task 4 的金标数字基于旧库；当前元枢库用**元枢原版内核**跑出即 4.8481（n=1990/mean=4.6018/sigma=0.0821），侧车移植版输出与其逐项一致（anom_wafer_n=243 仍吻合）。移植无偏差，Task 4 冒烟断言建议改用 4.8481 基线。
3. **run_registered 的 `context` 关键字参数**：任务签名四参；为满足"循环/深度异常类型从 MCP 层可见（run_registered 会抛出）"，追加 keyword-only `context=None`（默认新链，四参调用形态完全兼容），并使编排层可共享调用链状态。
4. **`conn_or_none` 当前未使用**：按任务签名保留（元枢离线 runner 的 conn 直连形态）；实现走 query_callbacks（D5 口径），docstring 已注明传 None 即可。
5. **RegisteredFunction.param_schemas 由 input_schema 生成**：三函数 schema 仅 string/array 类型，`_coerce_params` 对其 no-op（原样透传），不影响统计数值。
