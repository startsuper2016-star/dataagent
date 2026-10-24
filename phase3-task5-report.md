# Phase 3 Task 5 报告 — Slice 验收（端到端）+ 双轮 subagent 代码审核（Phase 3 收官）

- **状态**: 完成，Phase 3 验收通过
- **Commits**: `8a7ed66`（设计器）→ `4a37bd1`（Windows 测试修复）→ `851d9f9`（报告入库）→ `bc7a6df`（审核修复）→ `ff8ce6a`（二轮审核修复），均已 push origin main
- **测试**: packages + apps/api 全量 **421/421 全绿**（此前 30 个"既有失败"全部定位为 Windows 脚手架问题并修复）；apps/api 本体路由 **36/36**；inline-params **21/21**；agent-runtime semantic **24/24**
- **冒烟**: 设计器全链路 **23/23**（`scripts/smoke-ontology-designer.mjs`，新增）；本体 API **8/8**；RCA e2e 复跑通过（172.5s，数值与 phase2 基线逐值一致）
- **审核**: 两个 subagent 并行评审 phase3 全部 4 个功能提交 + 1 个 verify-pass 复审修复提交，3 个 P1 + 6 个 P2 全部修复，二轮复审 9 项核验通过

## 1. Slice 验收（Phase 3 = SemanticProvider 挂载 / 设计器 UI / 晋升流）

| 验收项 | 方式 | 结果 |
| --- | --- | --- |
| 设计器建模闭环 | 真实 HTTP（Bearer）：建实体→绑定自动建行→审批→属性同步/引用守卫→关系→traverse→版本发布→删除守卫 | `smoke-ontology-designer.mjs` **23/23** |
| 本体 API 回归 | Bearer/CSRF 集成 + query/sql/traverse/bindings | `smoke-ontology-api.mjs` **8/8** |
| 语义链 + MCP 链路 | live 8787 CopilotKit → MCP 中间件 → ontology-logic，RCA 三函数链 | **RCA e2e 通过**：mcp_mount=ontology-logic、run_logic×6、Top1=CH_B、confidence=0.875（tool-result 解包）、gate=auto_ticket，与 phase2 基线零漂移 |
| 全量回归 | vitest packages + apps/api | **421/421** |

RCA e2e 首跑 10 分钟客户端超时（DOMException TimeoutError）——与 phase2 报告记录的"GLM-5.3-Flash 编排方差、复跑偶发超时"同款；重试一次 172s 全绿，非挂载缺陷。

## 2. 顺带修复：30 个"既有失败"全部转绿

phase3 期间记录的既有失败（apps/api session-intent 13 + packages 17）经诊断**全部是 Windows 测试脚手架问题**，非逻辑缺陷：

- 5 个测试文件在 sqlite 句柄未关时 `rmSync` 临时目录 → Windows EBUSY（修复：afterEach 先 close；per-test 构造 store 的 harness 增加 close 追踪）
- `session-output-ingest` 期望值用 `join()` 而生产 `resolveSessionPath` 用 `resolve()` → Windows 下 `/tmp/session` 带上 `C:` 前缀（修复：期望值改 `resolve()` 镜像生产语义）

Linux CI 上这些用例本来是绿的；修复后 Windows 本地同样全绿。

## 3. 双轮 subagent 审核

**第一轮（两个 agent 并行，覆盖 phase3 四个功能提交）：**

- 审核一（designer + promote）：**3 个 P1** —— ① promote 完全绕过标识符白名单（实证：`订单(` 炸 rewriteObjectNames 正则致 /sql 全 500、`.*` 击穿白名单门放行任意 SQL）；② 路径段不做 URL 解码，中文实体名创建后无法编辑/删除；③ 新 UI 全部写操作缺 X-CSRF-Token，session 用户 403。另有 P2×4（draft 实体级联删 approved 绑定、版本登记死局、promote 属性不去重、datasourceId 不验存在）。
- 审核二（semantic + 参数绑定）：**可合入，P2×4** —— bindParams 不感知注释/双引号标识符（误拒合法 SQL，fail-closed 但晦涩）、未登记键报错时机与文档不符（prepare 不报错、bind/step 才报）、语义链 fallback 无日志且 cause 丢弃、API 启动不建 ont_* 表（未跑迁移的环境每个 run 静默降级）。

**修复（`bc7a6df` + `ff8ce6a`）**：3 P1 + 6 P2 全部落地；审核过程还带出两个真修复——审批覆盖率/一致性检查把 Record 形态映射按 0 计（合法历史绑定会卡死提交门，改为按键数计+按值做物理校验）、关系字段提示文案纠偏（是属性名经 fieldMap 翻译，不是物理列名）。

**第二轮（verify-pass，核验修复 commit）**：9 项核验 8 项通过，抓出 1 个 P1（versions 页相对导入少一级，TS2307）+ 2 个 P3（NOT_CONFIGURED 正常路径刷 warn、反引号标识符未按不透明 span），`ff8ce6a` 修复。终态：web typecheck 零 ontology 错误，三套件全绿。

**未采纳/记录在案**（审核建议但不动）：fallbackReason 单槽覆盖（有意设计，测试已断言）；functions 无 datasource 收敛（MVP 已知限制）；handlePromote `from` 无空判（可达性为空的防御）；rewriteObjectNames 引号感知（相邻面，列后续加固项）。

## 4. Phase 3 收官状态

| 范围项（phase2-task5 定义） | 状态 |
| --- | --- |
| SemanticProvider 挂载 | ✅ `3382df0` + fallback 日志/启动建表（`bc7a6df`） |
| 设计器 UI | ✅ `8a7ed66` + 审核修复（`bc7a6df`/`ff8ce6a`） |
| 晋升流 | ✅ `61b9361` + 白名单对齐设计器（`bc7a6df`） |
| 参数绑定加固（spike 列项） | ✅ `275b6c4` + 注释/引号感知（`bc7a6df`/`ff8ce6a`） |

**按设计仍延后**（非欠账）：gateway 扩 params——触发条件（接入远程/多方言数据源或合规要求）未出现；`inlineParams` 保留导出待触发。D4 决策（28 个 gateway 适配器不动、保持 upstream-rebase 安全）继续有效。

## 5. 变更清单

| Commit | 内容 |
| --- | --- |
| `4a37bd1` | Windows 测试脚手架修复（6 文件，30 失败→全绿） |
| `851d9f9` | 26 份任务报告入库（phase0-task1/2 的本地排除经脱敏核验后解除） |
| `bc7a6df` | 一轮审核修复（12 文件：promote 白名单/URL 解码/CSRF 封装/bindParams 三项/语义链日志/启动建表/删除守卫/版本删除/mappingCount） |
| `ff8ce6a` | 二轮审核修复（versions 导入层级/warn 降噪/反引号 span） |

新增可复跑资产：`scripts/smoke-ontology-designer.mjs`（23 断言组，任意环境可重放设计器闭环验收）。
