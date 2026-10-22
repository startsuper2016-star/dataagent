# Fusion Phase 1-B — API Routes + Service Auth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** 在 apps/api 暴露本体查询 REST 接口（query/sql/traverse），以 service-token 认证（裁决 D6），消费 `@datafoundry/ontology` 包，并把 T8 发现的 fieldMap 数组格式规范化下沉进源码。

**Architecture:** 无 Express——路由走 `config-api.ts` 的 `root ===` 分发（侦察 A2）；认证在 `resolveRequestAuth`（server.ts:1121）加 Bearer 分支映射 admin 身份（侦察 B5），CSRF 仅对 session 身份强制（侦察 B7）；`packages/ontology` 按 knowledge 先例补 dist 构建（侦察 C10）后被 apps/api 依赖；数据连接按 `data_sources.config_json.path` 打开 spc_mvp.db（侦察 D11）。

**Tech Stack:** TS5 / node:sqlite / node:http（上游形态）/ vitest + dist 级 smoke 脚本（侦察 E13）。

## Global Constraints

- `.env` 不入库；`ONTOLOGY_SERVICE_TOKEN` 为新 env（fork `.env` 与 `.env.example` 同步加示例行）。
- Bearer 身份**跳过 CSRF**（无 session 可校验）；token 比对用 `hashToken(token, sessionSecret)` 同款哈希，恒定时间比较。
- 本体路由必须经 service-token 或 session 认证之一，未认证 401。
- golden 20/20 与 acceptance 22/22 在改动后必须仍全绿（回归红线）。
- 单查询行上限 200（复用 `MAX_ROWS`）。

---

### Task 1: packages/ontology 补 dist 构建 + apps/api 依赖接线（侦察 C10/B9）

**Files:**
- Modify: `packages/ontology/package.json`（main→dist/index.js、加 types/build，仿 packages/knowledge/package.json:6-11）
- Modify: `tsconfig.build.json`（references 数组在 apps/api 之前插入 `{"path": "packages/ontology"}`）
- Modify: `apps/api/package.json`（dependencies 加 `"@datafoundry/ontology": "0.1.0"`）
- Modify: `packages/ontology/src/index.ts` 不变（tsc 产出 dist）

- [ ] Step 1: 改三个文件（照 packages/knowledge 的 main/types/build 字段抄写）
- [ ] Step 2: `npm install`（同步 lockfile）→ `npm run build` → 确认 `packages/ontology/dist/index.js` 产出且 `apps/api/dist` 正常
- [ ] Step 3: `npx vitest run packages/ontology` 仍 30/30（不影响 src 测试）
- [ ] Step 4: Commit `phase1b: ontology dist build + workspace wiring`

---

### Task 2: bindings.ts fieldMap 规范化下沉（T8 必须项）

**Files:**
- Modify: `packages/ontology/src/bindings.ts`（resolveBinding 内规范化）
- Test: `packages/ontology/src/bindings.test.ts`（新建）

**Interfaces:**
- Produces: `normalizeFieldMap(raw: unknown, attrs: {id,name}[]): Record<string,string>`——接受迁移数组形态 `[{attribute_id, source_column}]`（经 attrs 映射 attribute_id→name）或已是 Record 形态，统一输出 Record；`resolveBinding` 增加可选参数 `attributes?: {id,name}[]`（不传时对数组形态抛错并提示传入 attributes——**显式失败优于静默坏 SQL**，T8 验收装置的临时还原逻辑就此下沉）。

- [ ] Step 1: 写失败测试（数组形态经 attrs 映射 / Record 直通 / 数组无 attrs 抛错 / 未知 attribute_id 抛错）
- [ ] Step 2: 确认失败 → 实现 → 确认通过
- [ ] Step 3: 更新 `acceptance.test.ts` 改用新签名（删除装置内临时还原逻辑），91+新增 全绿
- [ ] Step 4: Commit `phase1b: normalize binding fieldMap (array format from migration)`

---

### Task 3: service-token 认证（裁决 D6）

**Files:**
- Modify: `apps/api/src/auth/service.ts`（新增 `authenticateServiceToken(token: string): AuthIdentity`；内部 `ensurePersonalWorkspace` 可达）
- Modify: `apps/api/src/server.ts:1121` `resolveRequestAuth`：请求头 `authorization: Bearer <t>` 时走新分支；`server.ts:277` CSRF 条件改为仅对 session 身份强制
- Modify: `.env.example`（加 `ONTOLOGY_SERVICE_TOKEN=` 注释行）
- Test: `apps/api/src/auth/service-token.test.ts`（纯函数级：token 哈希比对正确/错误/缺失）

**Interfaces:**
- Produces: Bearer `ONTOLOGY_SERVICE_TOKEN` → AuthIdentity（admin@fusion.local + personal workspace），供本体路由用 `context.userId` 定位 data_sources 行。

- [ ] Step 1: 写失败测试（hashToken 对 env token 的比对逻辑，注入 fake env）
- [ ] Step 2: 确认失败 → 实现：
```typescript
// auth/service.ts 内新增
authenticateServiceToken(token: string): AuthIdentity {
  if (!token) throw new AuthError(401, "missing service token");
  const expected = hashToken(config.serviceToken, config.sessionSecret);  // config.serviceToken = env ONTOLOGY_SERVICE_TOKEN
  if (!timingSafeEqual(Buffer.from(expected), Buffer.from(hashToken(token, config.sessionSecret))))
    throw new AuthError(401, "invalid service token");
  const user = this.users.getByEmail("admin@fusion.local");
  if (!user) throw new AuthError(401, "service user not provisioned");
  const workspace = this.ensurePersonalWorkspace(user);
  return { user, workspace, session: null };   // session=null → CSRF 分支自然跳过
}
```
（`timingSafeEqual` 长度不等会抛，先比长度；config 增 `serviceToken` 读取 env。）`resolveRequestAuth` 优先检查 Bearer 头，命中走新方法；server.ts:277 CSRF 改 `if (isUnsafeMethod(m) && authContext.identity.session)`。
- [ ] Step 3: 确认通过；**回归**：既有 session 认证路径测试不受影响（`npx vitest run apps/api`）
- [ ] Step 4: Commit `phase1b: service-token auth branch (D6)`

---

### Task 4: 本体路由（config-api 分发 + 数据连接打开）

**Files:**
- Create: `apps/api/src/routes/ontology.ts`
- Modify: `apps/api/src/config-api.ts`（root === "ontology" 分发，传入 metadataStore/userId）
- Modify: `apps/api/src/routes/types.ts`（如 ConfigApiContext 需扩展）
- Test: smoke 脚本在 Task 5 做端到端；本任务先做 handler 级单测（mock metadataStore）

**Interfaces:**
- Produces（均需认证）：
  - `POST /api/v1/ontology/query` body `{entity, filters, limit?, offset?}` → objectQuery
  - `POST /api/v1/ontology/sql` body `{sql, params?}` → executeOntologySql
  - `POST /api/v1/ontology/traverse` body `{fromEntity, fromFilters, toEntity, limit?}` → traverse（relations 从 ont_relations 读真实关系）
  - `GET /api/v1/ontology/bindings` → 14 实体绑定清单
- 数据连接：按 `userId` 查 `data_sources` name='SPC_MVP_SQLITE' → config_json.path → `new DatabaseSync(path)`（模块级缓存，路径变更时重建——Phase 1 路径静态，缓存安全）。
- fieldMap 规范化：`resolveBinding(wb, entityId, attributes)`（Task 2 产物）。

- [ ] Step 1: handler 单测（mock context：内存 metadataStore 建表+迁移样例行 + :memory: spc fixture；断言 query/sql/traverse 三端点返回结构与错误分支 401/400/404）
- [ ] Step 2: 确认失败 → 实现 routes/ontology.ts + config-api 挂载 → 确认通过
- [ ] Step 3: `npx vitest run apps/api packages/ontology` 全绿；`npm run build` 通过
- [ ] Step 4: Commit `phase1b: ontology API routes (query/sql/traverse/bindings)`

---

### Task 5: smoke 脚本 + slice 验收

**Files:**
- Create: `scripts/smoke-ontology-api.mjs`（仿 scripts/smoke-config-api.mjs：起真实 server（dist）+ Bearer token 头）
- Modify: root `package.json` 加 `"smoke:ontology-api": "node scripts/smoke-ontology-api.mjs"`

- [ ] Step 1: 脚本流程：构建 → 起服务（临时 workbench fixture：建表+迁移样例数据 14 绑定+datasources+users admin）→ 设 `ONTOLOGY_SERVICE_TOKEN` → Bearer 调 4 端点（含 401 无 token 反例、400 坏 body 反例）→ golden 抽样 3 条（eq_chamber/gte_date/agg_fdc_group）经 query 端点与 golden.json 比对 → traverse 1 条 → 全过 exit 0
- [ ] Step 2: `npm run build && npm run smoke:ontology-api` → 全过
- [ ] Step 3: 全量回归：`npx vitest run packages apps/api`（91+新增 全绿）+ `npm run smoke:config-api`（既有不回归）
- [ ] Step 4: Commit `phase1b: ontology api smoke + slice acceptance` → **P1-B slice 验收关闭**

---

## 验收标准（P1-B slice）

1. Bearer service-token 认证：无 token 401、错 token 401、对 token 全通；session 用户不受影响（回归绿）
2. 三端点对真实迁移数据（workbench ont_bindings + spc_mvp.db）返回 golden 一致结果（抽样 3 条深比较）
3. `resolveBinding` 数组格式规范化下沉源码，acceptance.test.ts 装置内临时逻辑删除
4. CI 绿（含新增 smoke 脚本通过）

## 风险与移交

| 风险 | 缓解 |
|---|---|
| config-api.ts 单文件巨大（4000+ 行） | 新 handler 独立文件 routes/ontology.ts，config-api 只加分发行 |
| CSRF 改动影响既有 session 安全 | 条件仅放宽"无 session 的 Bearer 身份"，session 路径逐字不动 + 回归 |
| dist 构建引入 ontology 后 build 顺序问题 | 仿 knowledge 已验证模式；build 失败即回退改用 src 直引（dev-only 过渡，报告记录） |
