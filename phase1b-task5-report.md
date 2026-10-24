# Phase 1-B Task 5 报告 — 本体 API smoke + slice 验收

**日期**: 2026-10-22
**Commit**: `b69f0a8` — `phase1b: ontology api smoke (bearer/csrf integration assertions) + enabled_only fix`（已 push origin main）
**状态**: ✅ 完成，exit 0

## 变更清单

| 文件 | 变更 |
| --- | --- |
| `scripts/smoke-ontology-api.mjs` | **新增**。本体 REST 面 smoke：临时 fixture workbench（createMetadataStore + ensureOntologyTables + SPC spc.db）→ `createServer({ metadataStore, taskStateRuntime })` 随机端口 → 8 组真实 HTTP 断言 |
| `scripts/migrate-yuanshu.ts` | **T4 评审 Low-2 修复**：data_sources 复用查找由裸 `WHERE name = ?` 改为 `WHERE name = ? AND status = 'ready'`（对齐 `DataSourceRepository.list({ enabled_only: true })` 口径） |
| `package.json` | scripts 增加 `"smoke:ontology-api": "node scripts/smoke-ontology-api.mjs"` |

## Smoke 脚本设计

环境构造照抄 `scripts/smoke-config-api.mjs` 先例（全文参照其 createServer 注入/client 用法/断言风格）：

- 临时目录 + `createMetadataStore`（临时 sqlite）+ `createTaskStateRuntime` + `createApiServer({ metadataStore, taskStateRuntime })`，`listen(0)` 随机端口——与常驻 8787（PID 44300）无冲突。
- **service token 传递**（侦查结论）：`apps/api/src/auth/config.ts` 的 `loadPasswordAuthConfig(env)` 在 `createServer` **调用时**读 `process.env`（非模块加载期），因此 smoke 在 `createApiServer(...)` 之前设置 `process.env.ONTOLOGY_SERVICE_TOKEN = randomBytes(24).toString("hex")` 即可，同 `AUTH_SESSION_SECRET`（≥32 字符）等既有 env 做法，无需 spawn 子进程。
- **服务身份对齐**：`AuthService.authenticateServiceToken` 硬编码 `users.findByEmail("admin@fusion.local")`（service.ts:17,324）——fixture 经 `createAuthenticatedTestClient.registerAndLogin({ email: "admin@fusion.local" })` 注册该邮箱账号，Bearer 身份的 `workspaceId/userId` 即该用户，`data_sources` 行归属一致。
- **fixture**（仿 `routes/ontology.test.ts` seedMetadata + `traverse.test.ts` 数据）：
  - 数据侧 `spc.db`：`v_anom_wafer` **3 行**（W-001/W-002 同 chamber CH1——traverse 去重由此可证；W-003 在 CH2），`dim_tool_event` 3 行。
  - 元数据侧：`ensureOntologyTables` + AnomWafer/ToolEvent 两实体 + approved 绑定（fieldMap 键序 = 期望列序）+ 1 条关系 + 1 个 draft 绑定（OrphanGhost，验证 bindings 只列 approved）+ `dataSources.create({ name: "SPC_MVP_SQLITE", config: { path } })`（status 默认 ready）。
  - Bearer 调用走 raw `fetch`（不经 test client——其 `authenticatedFetch` 对 unsafe 方法自动补 `x-csrf-token`，会破坏断言 c/d 的"无 CSRF 头"前提）；断言 d 用 `adminClient.cookies.headerValue()` 手工构造带 cookie 不带 CSRF 头的请求。

## 断言结果（8/8 ✅）

| # | 断言 | 结果 |
| --- | --- | --- |
| a | 无 Authorization 头 POST /api/v1/ontology/query → 401 UNAUTHORIZED | ✅ |
| b | Bearer 错值 → 401 UNAUTHORIZED | ✅ |
| c | **Bearer 对值 + unsafe POST 无 CSRF 头 → 200**（T3 评审要求的集成断言：service 身份无 session，天然免 CSRF） | ✅ |
| d | **session cookie + unsafe POST 无 x-csrf-token → 403 CSRF_INVALID**（CSRF 对 session 仍强制的集成断言） | ✅ |
| e | query 返回 fixture 3 行，列序 = fieldMap 键序（wafer_id, chamber_id, lot），按 idColumn 排序 | ✅ |
| f | sql 白名单拒绝：`SELECT * FROM sqlite_master` → 400，消息含"白名单"（"SQL 未引用任何本体对象（白名单拒绝执行）"） | ✅ |
| g | traverse 返回 DISTINCT 去重事件：W-001/W-002 同 chamber 均 JOIN 到 t1/t2，未去重会重复，实际恰 3 行 [CH1 alarm, CH1 pm, CH2 idle] | ✅ |
| h | bindings 返回 approved 清单（draft 的 OrphanGhost 不出现），entity/table/status 形状正确 | ✅ |

## 验证

```bash
npm run build && npm run smoke:ontology-api   # exit 0，8/8 断言过
```

### 全量回归

```bash
npx vitest run packages apps/api
# Test Files: 6 failed | 51 passed (57)
# Tests:      30 failed | 351 passed (381)
```

**失败定性（非回归）**：30 个失败全部为 `EBUSY: resource busy or locked, unlink %TEMP%\*-metadata.sqlite` 一类 Windows 临时文件锁环境噪音，集中于 6 个文件（session-intent-repository / session-intent / session-branching-intent / session-output-ingest / session-output-service / knowledge-document-lifecycle）——无一与本体相关。已做基线对照：临时移除本任务 3 个文件改动后重跑这 6 个文件，失败集合与数量**逐字相同**（6 files / 30 failed | 2 passed），证实与本次改动零关联。既有基线口径为"13 个 EBUSY 环境失败"，本机当日文件锁时序下同类失败波动至 30（同 class，跨次运行 28–30 波动）。本体相关测试（packages/ontology/*、apps/api/src/routes/ontology.test.ts）全绿。

### 既有 smoke 回归

```bash
npm run smoke:config-api   # exit 0，Config API smoke OK
```

## 适配记录与残余事项

1. **临时目录清理为 best-effort**：`task-state.sqlite`（Mastra LibSQLStore）在 createServer 全流程下句柄释放晚于隔离场景（隔离实验 ~100ms 即可删；全流程 4.5s 重试仍 EBUSY）。脚本带 10×500ms 退避重试，最终失败仅告警不致败（exit 仍 0）；其余临时文件均删除。上游先例 `smoke-config-api.mjs` 干脆不删临时目录，本脚本是加强而非倒退。
2. **Low-2 修复采用裸 SQL 口径**：`migrate-yuanshu.ts` 对 data_sources 的查找原为裸 SQL（不经 repository），故 `enabled_only: true` 落地为等价 `AND status = 'ready'`（`DataSourceRepository.list` 签名：`{ user_id; enabled_only? }`，enabled_only=true → `status = 'ready'`，默认 → `status <> 'deleted'`），并加注释说明对应关系。注意本体路由 `openSpcConnection`（routes/ontology.ts:176-178）目前用 `list({ user_id })` 默认口径（disabled/failed 行仍可见）——T4 评审 Low-2 范围仅限迁移脚本，路由侧如需同口径收紧属后续任务。
3. smoke 注册 admin 账号会触发 `/api/v1/auth/*` 的限流桶（register 5/h per IP）——单次运行 1 注册 1 登录，余量充足。
4. package.json 条目按任务规格不含 build 前缀（验证命令 `npm run build && npm run smoke:ontology-api` 已覆盖前置构建）。
