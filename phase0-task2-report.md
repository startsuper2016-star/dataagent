# Phase 0 — Task 2 Report: 环境引导与 DTC 案例跑通

**Date:** 2026-10-21
**Status: DONE**

**Commit:** `c546176` — `phase0: environment verified, DTC case pass`（由原提交 6387601 amend 而来，仅含 FUSION_BASE.md 追加行：`env: node v22.22.1, DTC case OK 2026-10-21`）

---

## 1. 最终验证结果（全部通过）

| 验收项 | 结果 |
|---|---|
| Web 登录页 :3000 | 200（`/` 307 → `/data-tasks`，`/login` 200） |
| API :8787 | `GET /healthz` → `{"success":true,"data":{"status":"ok"}}` |
| 管理员账号 | `admin@fusion.local`（注册→verify-email→login 全通过） |
| workbench.sqlite | 自动生成于 `apps/api/storage/metadata/workbench.sqlite`（见偏差说明 2） |
| 内置 DTC 数据源 | bootstrap 自动接入（builtin dtc-growth-demo），`test → connected (8ms)`，schema 5 表可读 |
| **DTC 分析 run** | **completed**（AG-UI 流末事件 `RUN_FINISHED`） |
| **trace 时间线** | `GET /api/v1/sessions/:threadId/trace-dag` → **35 nodes / 34 edges**，run-start 节点状态 completed，含 context/tool（inspect_schema、preview_table、skill、run_sql_readonly、task_write 等 18 次工具调用）全部节点 |
| **artifact 预览/导出** | 3 个 artifact（SQL 结果 CSV），`preview_available: true`（`preview_json` 内联行列数据）；`GET /api/v1/artifacts/:id/download` → **200，261 bytes 合法 CSV**，可导出 |

## 2. DTC run 详情

- **runId:** `phase0-dtc-run-1792593144410`；**threadId（session）:** `phase0-dtc-thread-1792593144410`
- **模型:** GLM-5.3-Flash @ `https://open.bigmodel.cn/api/coding/paas/v4`（模型档 server-default，由 .env LLM_* 引导创建）
- **状态:** completed；**耗时:** 694,870 ms ≈ **11 分 35 秒**（单次 SSE 流，含 18 次工具调用、5 轮 SQL/技能步骤、2 次 claim 提交被验证器拒绝后自动修正）
- **分析输入:** "分析最近一周（2026-06-24 至 2026-06-30）的 GMV、毛利率与退款率相对上一周的变化，给出简要增长复盘结论"
- **核验结论（与 SQL artifact 数值一致）:** GMV 4465→6511（+45.82%）；毛利率 57.07%→57.04%（-0.02pp）；退款率 0→10.72%（+10.72pp）；agent 自行完成口径确认、环比计算、复算校验、claim 六项核验通过
- **Artifacts（均可预览+导出）:**
  1. `4ffea536…` 周度指标对比表（preview 含两周全指标行）
  2. `1565c7da…` 环比变化表（gmv_wow_pct=45.82 等）
  3. `32acff84…` 退款明细下钻表
  - 列表端点：`GET /api/v1/artifacts?sessionId=<threadId>`（注意必须带 sessionId 参数，否则 400 ARTIFACT_LIST_SESSION_ID_REQUIRED）

## 3. 环境与配置

### .env（`C:/Users/shuan/Documents/GitHub/datafoundry/.env`，gitignored，未提交）

| Key | Value |
|---|---|
| METADATA_DB_PATH | storage/metadata/workbench.sqlite |
| SECRET_MASTER_KEY / AUTH_SESSION_SECRET | openssl rand -hex 32 生成 |
| LLM_PROVIDER / LLM_MODEL | openai-compatible / **GLM-5.3-Flash** |
| LLM_BASE_URL | https://open.bigmodel.cn/api/coding/paas/v4 |
| **LLM_API_KEY** | **`***MASKED***`**（来源：平台库 `ontology.db` 的 `system_config` 表 `ai.models`，由用户提供；元枢根 .env 该值为空；完整值仅存于 gitignored 的 `.env`） |
| AUTH_* | test 邮件投递 / open 注册模式（本地验证用） |

### 运行中的进程（保留给后续任务）

- **API**（tsx watch，:8787）：PID **12280**（`npm run dev -- --api` 启动）
- **Web**（next dev --turbopack，:3000）：PID **17096**（`npm run dev:web` 启动）
- 停止：`taskkill //F //PID 12280` / `taskkill //F //PID 17096`（或 `netstat -ano | findstr ":8787 :3000"` 查 PID）；整栈重启：repo 根 `npm run dev`

## 4. 过程记录（含排障）

1. 首次启动（LLM_API_KEY 空）：run 报 `CONFIG_RESOURCE_NOT_FOUND:model-profile:server-default` —— `isServerLlmEnvConfigured`（`apps/api/src/model-profile-connection-status.ts:62`）要求 KEY/URL/MODEL 三者非空，否则不建 server-default 模型档。
2. 占位 Key 对照测试：run 打通到真实 bigmodel 端点，返回上游"令牌已过期或验证不正确"——证明除凭证外全管线正常（当时即恢复空 Key）。
3. 用户提供真实 Key（平台库 system_config 表 `ai.models`）后写入 .env 并重启 API：server-default 档自动引导创建（revision 1），run 一次通过 completed。

## 5. 偏差说明

1. **workbench.sqlite 实际路径**为 `apps/api/storage/metadata/workbench.sqlite`：.env 相对路径以 API 进程 cwd（apps/api）解析，与上游 .env.example 行为一致，功能无影响；如需严格落在仓库根 `storage/`，改 .env 为绝对路径即可（会换新库，需重注册账号）。
2. **Web UI 未人工点击**：注册/登录/建 run 均经同一套 REST（`/api/v1/auth/*`、`POST /api/copilotkit`）驱动，与浏览器请求等价；`/login` 页可正常打开。驱动脚本：`C:\Users\shuan\AppData\Local\Temp\df-run-driver.mjs`。
3. `phase0-task1-report.md`（Task 1 遗留）与本报告均为 untracked，未纳入提交。
4. run 耗时 11.6 分钟偏长（GLM-5.3-Flash 多步协议 + 2 次 claim 重试），后续任务如需批量验证可关注。

## 6. 关键文件

- `.env`（含真实 Key，勿提交）、`FUSION_BASE.md`（+1 行，commit c546176）
- `apps/api/storage/metadata/workbench.sqlite`（元数据库）
- `storage/fixtures/dtc-growth-demo.sqlite`（DTC 案例源数据）
- 驱动脚本 `C:\Users\shuan\AppData\Local\Temp\df-run-driver.mjs`（登录→数据源检查→发起 run→校验 trace/artifact 一条龙）
- 修复记录（2026-10-21，评审 Important 项）：报告内 LLM_API_KEY 片段已脱敏为 ***MASKED***（来源说明保留，完整值仅存于 gitignored .env）；phase0-task1-report.md 与 phase0-task2-report.md 已加入 .git/info/exclude 本地忽略。
