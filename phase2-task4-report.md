# Phase 2 Task 4 报告 — MCP 工具接线 + 冒烟（四项承接全部落实）

- **状态**: 完成
- **Commit**: `1f107b9` — `phase2: MCP tools wired to sandbox executor (carry-forwards)`（已 push origin main）
- **测试**: `uv run pytest` → **50 passed**（新增 23 项 MCP 工具层测试，含 Task 1/2/3 既有 27 项）；`uv run ruff check src tests` → All checks passed
- **冒烟**: 真实 apps/api(8787，Bearer 认证) + 真实 spc_mvp.db，经 **MCP 客户端（mcp python sdk，streamable-http → 127.0.0.1:8902/mcp）** 执行，**4 条断言全过**（见下）；REST 面（8901 `/run_logic` `/query`）亦人工验证通过

## 工具面（mcp/server.py 注册）

| 工具 | 入参 | 行为 |
| --- | --- | --- |
| `ontology_ping` | — | 连通性 echo（Task 1 既有） |
| `ontology_run_logic` | `{logic_name: Literal[spc_detect/rca_rank/rca_evidence], params?: object}` | `validate_logic_params`（承接②）→ 服务级单例 `executor.run_registered`（承接③）→ JSON 结果 content；`CircularCallError`/`MaxDepthError` → isError content 原消息（承接①）；`ValueError`/`RuntimeError`（未注册/执行失败/回调 D5 失败）→ isError 原文 |
| `ontology_query` | `{entity, filters?, limit?=100, offset?=0}` | 走 `OntologyCallbackClient.query_rows`（HTTP 回调 apps/api `/api/v1/ontology/query`）→ `{"rows": [...], "rowCount": n}`；回调失败 → isError 原文 |

错误面实现为**工具函数直接返回 `CallToolResult(isError=True, content=[TextContent(原消息)])`**（mcp 1.x SDK 原生支持该返回类型直通协议层），消息不加任何前缀——`Error executing tool` 的 SDK 包装被绕开，保证"原样透传供 LLM 自纠"。`logic_name` 用 `Literal` 注解使暴露的 inputSchema 带 enum（三值），运行期另有 `未注册函数: X` 防御（registry 与 Literal 背离时兜底）。

## 四项承接落实

| 承接项 | 落实 |
| --- | --- |
| ① 循环/深度 → isError | `ontology_run_logic` 捕获 `CircularCallError`/`MaxDepthError` → isError content `str(err)` 原文（单测断言消息逐字相等且无 `Error executing tool` 前缀；经 monkeypatch 单例 `run_registered` 触发守卫路径——三函数内核体本身不产生递归） |
| ② 参数校验接管 | `functions/registry.py::validate_logic_params(logic_name, params)`：未注册 → `未注册函数: X`；required 缺失（含显式 null）→ `缺少必填参数 X`（多项"；"连接）；string/array 类型粗校验 → `参数 X 类型错误: 期望 array，实为 str`。MCP 工具与 REST `/run_logic` 共用同一实现（原元枢 validate_parameters 职责的落点，职责落在工具注册层） |
| ③ registry 装配一次 | `core/executor.py::assemble_functions()` 全量装配 `FUNCTIONS → RegisteredFunction`（inline 包裹 + param_schemas）；`api/deps.py::get_executor()` 服务级单例在构造时传入全量注册表，此后 `run_registered` **不在每次调用覆盖写** `self.functions`（仅实例缺失该条目时装配一次，单例路径零写入；单测断言调用前后 `self.functions` 逐项相等且同对象） |
| ④ conn_or_none 死参 | `run_registered` 首行 `assert conn_or_none is None`（保留形参兼容 T3 调用形态，误传 sqlite conn 显式 AssertionError；单测覆盖） |

## 新增/修改文件

| 文件 | 内容 |
| --- | --- |
| `core/executor.py` | 新增 `build_registered_function` / `assemble_functions`；`run_registered` 重写（③装配一次 + ④assert None；docstring 更新） |
| `functions/registry.py` | 新增 `validate_logic_params` + `_TYPE_CHECKS`（承接②，string/array 粗校验） |
| `api/deps.py` | 新增 `get_executor()` 服务级单例（config → OntologyCallbackClient + UnifiedSandbox + assemble_functions）与 `reset_executor()`（测试复位，关闭 HTTP 连接池） |
| `mcp/server.py` | 注册 `ontology_run_logic` / `ontology_query`；`_json_result`/`_error_result`（CallToolResult 直通）；承接①②的捕获与转换 |
| `api/server.py` | 可选 REST 面：`POST /run_logic`（同校验/同执行器/同错误文案，错误 → HTTP 400 detail 原文）、`POST /query`（回调失败 → 502） |
| `core/callbacks.py` | **新增 `adapt_named_params` 适配**（见"冒烟发现与修复"） |
| `tests/test_mcp_tools.py` | 23 项新测试（工具注册面 enum/三函数真数据流/守卫异常 isError 原文/参数校验失败三态/ontology_query 行数据与回调失败/承接③④固化/参数适配 4 项） |

## 环境配置（本次落地的持久变更）

1. **repo 根 `.env` 追加 `ONTOLOGY_SERVICE_TOKEN=<随机 64hex>`**（任务授权动作：原 .env 未配置该键，8787 实例的服务 token 认证处于关闭态）。重启 apps/api 后 Bearer 认证生效。
2. **apps/api 重启**（原 PID 19880 → 现 19608）：以 cwd=`apps/api` 重启（关键：`METADATA_DB_PATH=storage/metadata/workbench.sqlite` 相对 cwd——live workbench 在 `apps/api/storage/metadata/workbench.sqlite`，root `storage/metadata/` 是另一个近空库，首次重启曾误用）。dotenv 从 repo 根 `.env` 读取 token（`index.ts` 按 import.meta.url 解析，与 cwd 无关）。
3. **workbench 元数据补一条迁移遗漏绑定**：live workbench（14 绑定 + SPC_MVP_SQLITE）缺 `WindowConfig` 实体，而 spc_kernel BODY_DETECT 首行 `query_objects('WindowConfig', {})` 是窗口唯一事实源。自元枢 `ontology.db` 原样取数补齐（id/attribute_id 全部保留元枢原值，绑定 `cfg_window` 表、status=approved、datasource 指向 fusion SPC_MVP_SQLITE）：实体 `aa85a43d-bcb4-5377-acfc-46376899b58a`（published）+ 4 属性 + 绑定 `02881d63-5d55-4ec3-9a2a-20996c4b276a`。现 workbench 为 **15 绑定**。插入前经存在性守卫（幂等），已验证 apps/api `/ontology/query` 可查（`[{id:"win", window_start:"2026-09-21", window_end:"2026-10-21", baseline_days:60}]`）。

## 冒烟发现与修复（Task 4 接线的实质问题）

**内核命名参数 vs apps/api SQL 路由契约不匹配**：kernel `call_complex_sql("…WHERE process_date < :ws", {"ws": …})` 用元枢式命名占位符；apps/api `executeOntologySql → inlineParams` 只接受 `p<N>[_<M>]` 键（400 `参数键名不合法: ws`）。T3 金标核对用的是进程内 fake 回调，未暴露此契约缝隙。

修复：`core/callbacks.py::adapt_named_params`（D5 回调出口处适配，apps/api 与字节锁死的内核均不改）——键按字典序确定性改名为 `p1..pN`，SQL 中 `:key` 词边界占位符同步重写；键已全符合契约或为空则原样直通。4 项单测覆盖（单键/前缀歧义 `\b`/直通/MockTransport 请求体断言）。

## 冒烟结果（MCP 客户端，真实链路 8902 → 8787 → spc_mvp.db）

方式：`uv run python -m ontology_logic.mcp.server` 起 MCP（8902，streamable-http）；`mcp` python sdk `streamablehttp_client` + `ClientSession` 逐工具调用（`/tmp/smoke_mcp.py`，脚本化断言）。REST 面以 curl 对 8901 复核。

| # | 断言 | 实测 | 结果 |
| --- | --- | --- | --- |
| 1 | `ontology_run_logic(spc_detect)` → ucl3≈4.8481 / anom_wafer_n=243 / anom_lot_n=41 | ucl3=**4.8481**、anom_wafer_n=**243**、anom_lot_n=**41**（首检日 2026-09-21、anomaly=high，与 T3 金标一致） | PASS |
| 2 | `ontology_run_logic(rca_rank)` → top1 含 CH_B | top1=**"PVD01_CH_B 前后偏移"**（top_chamber=PVD01_CH_B，3 候选） | PASS |
| 3 | `ontology_run_logic(rca_evidence, candidates=ranking)` → confidence≈0.874 / gate=auto_ticket | confidence=**0.874**、gate=**auto_ticket**（结论：PVD01_CH_B 换靶 Target #7→#8） | PASS |
| 4 | `ontology_query(AnomWafer, {}, 3)` → 3 行 | rowCount=**3**（首行 lot L26-080 / PVD01_CH_B） | PASS |

附加验证：协议层传未注册名（`ghost_fn`）→ Literal enum 校验拒绝（协议级 isError，枚举面生效）；REST `/run_logic` 缺 candidates → HTTP 400 `{"detail":"缺少必填参数 candidates"}`（与 MCP isError 同文案）；`/query` → 3 行。

## 疑虑 / 偏差说明

1. **`window_end` 语义差**：kernel 输出 `window_end = win_days[-1]['stat_date']`（异常窗末日=数据末日），非 cfg_window 的 2026-10-21；冒烟断言未涉及，与元枢原版行为一致。
2. **"未注册 → isError" 双口径**：协议层传非法名走 `Literal` 的 pydantic 校验（SDK 错误文案，含三值枚举提示，仍 isError 可自纠）；`未注册函数: X` 原文出现在 registry 与 Literal 背离时（单测以直调函数覆盖）。属 enum 面 + 运行期防御的预期分层。
3. **WindowConfig 绑定补齐属 workbench 数据变更**：非代码提交内容（元数据在 gitignore 的 storage 内）。若后续迁移任务重放 `migrate-yuanshu.ts`，建议把 WindowConfig 纳入 P14 → P15 实体清单（本次补齐脚本逻辑已在本报告记录，可重放）。
4. **confidence 0.874 vs T3 报告的 0.875**：T3 金标为 `0.875`（round 显示），本次 MCP 实测 0.874，任务断言口径 `≈0.874`——两者同源（0.6/0.4 融合权重的舍入显示差），非偏差。
5. **服务留存状态**：apps/api(8787, PID 19608, token 已启用) 与 ontology-logic MCP(8902, PID 61064) 保持运行（Task 5 工作台接线直接可用）；冒烟用 REST uvicorn(8901) 已停。
