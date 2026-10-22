# Fusion Phase 2 — services/ontology-logic (Python Logic Sidecar) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** 在 DataFoundry monorepo 内新增 `services/ontology-logic`（Python FastAPI + MCP）：承载元枢函数沙箱与纯 Python 统计内核，经 MCP 暴露 `ontology_run_logic` 等工具，使 RCA 能力在 DataFoundry 产品内可用。

**Architecture:** 仿 `services/datalink` 先例——独立 Python 服务住在 TS monorepo（裁决 D3：统计不进 TS）。沙箱代码从元枢 `backend/app/services/function_runtime/` 移植（去 SQLAlchemy）；函数内的数据访问（query_objects/call_complex_sql/traverse）改为 **HTTP 回调 apps/api 的 `/api/v1/ontology/*` 路由**（Bearer service-token，裁决 D5 超时契约：5s 硬超时+失败转 RuntimeError 不重试）。

**Tech Stack:** Python ≥3.11 / FastAPI + uv / pytest / MCP（mcp python sdk，同 datalink）/ 无 ORM。

## Global Constraints

- 沙箱红线随迁：import 白名单、禁 `_` 前缀标识符、禁 numpy/scipy、单函数 30s/链 120s/深度 10。
- 回调契约（D5）：HTTP 客户端 5s 硬超时、不重试、失败抛 RuntimeError；回调目标=apps/api `/api/v1/ontology/{query,sql,traverse}` + Bearer service-token。
- 统计内核与 RCA 函数体从元枢 `backend/scripts/spc_kernel.py` 原样搬移（纯 Python，零改动语义）。
- pytest 全绿 + 手工 MCP 冒烟（datalink 先例：uv run python -m datalink.mcp 之类）。
- 服务只绑 127.0.0.1（内网），MCP/REST 双面。

---

### Task 1: 服务骨架 + MCP echo

**Files:**
- Create: `services/ontology-logic/pyproject.toml`（uv，fastapi/uvicorn/mcp/httpx/pytest）
- Create: `services/ontology-logic/src/ontology_logic/{__init__.py,api/server.py,api/deps.py,mcp/server.py,config.py}`
- Create: `services/ontology-logic/tests/test_health.py`
- Modify: 根 `package.json` scripts 加 `"dev:ontology-logic"`（可选）

**Interfaces:**
- Produces: FastAPI `/healthz`；MCP server 暴露 `ontology_ping` 工具（连通性验证用，Phase 2 后续任务替换为真工具）。

- [ ] Step 1: 骨架照 `services/datalink` 目录结构抄（pyproject 字段、src 布局、uv.lock 生成 `uv lock`）
- [ ] Step 2: `/healthz` 返回 `{status:"ok", service:"ontology-logic"}`；MCP server 注册 `ontology_ping` echo 工具（照 datalink 的 mcp/server.py 模式）
- [ ] Step 3: `uv run pytest` 全绿 + `uv run uvicorn ontology_logic.api.server:app --port 8901` 手工 healthz 验证
- [ ] Step 4: Commit `phase2: ontology-logic service skeleton (fastapi + mcp)`

---

### Task 2: 沙箱移植（元枢 function_runtime → 包内 core/）

**Files:**
- Create: `services/ontology-logic/src/ontology_logic/core/sandbox.py`（自元枢 `function_runtime/sandbox.py` 移植：去 SQLAlchemy/去 app.* import、保留白名单/校验/execute）
- Create: `services/ontology-logic/src/ontology_logic/core/executor.py`（函数注册+执行：call_function 注入、循环调用检测、深度/超时）
- Test: `services/ontology-logic/tests/test_sandbox.py`

**Interfaces:**
- Produces: `Sandbox().execute(code, func_name, namespace, timeout)` 语义与元枢逐字一致（白名单/禁 `_`/settrace 超时）；`FunctionRegistry.register(meta)`/`execute(callable_name, params)`。
- 回调适配：namespace 注入的 `query_objects/call_complex_sql/traverse` 改为 **httpx 回调 apps/api**（`ONTOLOGY_API_BASE_URL` + `ONTOLOGY_SERVICE_TOKEN` env；5s 超时/不重试/失败转 RuntimeError——D5）。

- [ ] Step 1: 从元枢源文件移植（逐行复制后修 import；两文件的依赖面：json/re/datetime/math/decimal/collections/typing/functools/itertools/copy/dataclasses + types.py 的 FunctionMeta/ExecContext/ExecResult + models.py 的超时常量）
- [ ] Step 2: 移植测试（元枢无沙箱单测则自写 6 条：白名单拒绝/禁下划线/settrace 超时/回调 5s 超时转 RuntimeError/回调成功/循环调用检测）
- [ ] Step 3: `uv run pytest` 全绿
- [ ] Step 4: Commit `phase2: sandbox ported (callbacks via apps/api REST, D5 contract)`

---

### Task 3: 统计内核 + RCA 函数注册

**Files:**
- Create: `services/ontology-logic/src/ontology_logic/functions/spc_kernel.py`（元枢 spc_kernel.py 的 COMMON+三函数体原样）
- Create: `services/ontology-logic/src/ontology_logic/functions/registry_seed.py`（三函数 FunctionMeta 注册：input_schema 从 workbench ont_functions.input_schema_json 读或静态内置）
- Modify: `services/ontology-logic/src/ontology_logic/core/executor.py`（registry 注入三函数；namespace 注入 query_objects/call_complex_sql/traverse 回调）

**Interfaces:**
- Produces: MCP 工具 `ontology_run_logic`（body `{logic_name, params}`）——`spc_detect/rca_rank/rca_evidence` 三函数可经 MCP 真实执行。

- [ ] Step 1: 函数体原样搬移（spc_kernel 的 BODY_DETECT/BODY_RANK/BODY_EVIDENCE 字符串 + COMMON）
- [ ] Step 2: registry 注册三函数（meta：name/callable_name/params 从元枢 grounding 的 input_schema 静态内置）
- [ ] Step 3: pytest 端到端（沙箱内跑三函数，query_objects 用进程内 fixture 而非 HTTP——单测层用 fake 回调；HTTP 集成在 Task 4）
- [ ] Step 4: Commit `phase2: spc kernel + rca functions registered`

---

### Task 4: MCP 工具接线 + 手工冒烟

**Files:**
- Modify: `services/ontology-logic/src/ontology_logic/mcp/server.py`（`ontology_ping` 旁注册真工具 `ontology_run_logic`/`ontology_query`）

- [ ] Step 1: `ontology_run_logic`：MCP 调用 → executor.execute(logic_name, params) → 返回 JSON 结果（错误转 isError content）
- [ ] Step 2: 手工冒烟：起服务 + apps/api（data_sources/ont_* 已在 workbench）→ MCP 客户端调 `ontology_run_logic(spc_detect)` → 断言返回 anchor JSON 且数字与元枢基线一致（UCL=4.8405、异常 243）
- [ ] Step 3: Commit `phase2: MCP tools wired to sandbox executor`

---

### Task 5: slice 验收 — DataFoundry 工作台端到端

- [ ] apps/api 的 MCP middleware（config_resources kind=mcp-server）注册 ontology-logic server（Phase 1 遗留：策略工具面挂载）
- [ ] DataFoundry 工作台对话发起 RCA → agent 调 MCP 工具 → 结论卡 JSON 与元枢基线一致
- [ ] 全部提交推送；汇报 Phase 2 完成 + Phase 3（SemanticProvider 挂载/设计器 UI/晋升流）启动

## 风险

| 风险 | 缓解 |
|---|---|
| 沙箱移植 import 面失控（app.* 依赖深） | 只搬 sandbox/executor 两文件的函数级依赖；types/models 内联进 core |
| 回调环 5s 超时不够（复杂 SQL） | apps/api /ontology/sql 走 node:sqlite 直查（快）；实测超时再调 D5 常量 |
| MCP python sdk 版本与 datalink 不一致 | 直接抄 datalink 的 pyproject 依赖版本 |
