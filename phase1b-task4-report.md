# Phase 1-B Task 4 Report: 本体路由（config-api 分发 + 数据连接打开）

## 状态

完成。Commit `43bdbf3` — `phase1b: ontology API routes (query/sql/traverse/bindings)`（未 push，待控制器统一推送）。

## 变更文件

| 文件 | 变更 |
| --- | --- |
| `apps/api/src/routes/ontology.ts` | 新建（约 330 行）：`handleOntologyRequest(request, method, subPath, context)` + 4 端点 + 数据连接缓存 + 错误映射 |
| `apps/api/src/routes/ontology.test.ts` | 新建，14 用例（见下） |
| `apps/api/src/config-api.ts` | 分发段新增 `if (root === "ontology") return handleOntologyRequest(request, request.method, segments.slice(1), context);`（置于 `capabilities` 之后）+ 对应 import |
| `apps/api/src/config.ts` | 删除 T3 遗留死字段 `service_token?: string`（评审 Low 项；contracts 侧中央登记保留未动） |

## 端点契约（全部已认证——config-api 分发链内，server.ts `resolveRequestAuth` 之后执行，Bearer/session 均可）

| 端点 | 请求体 | 返回 `data` |
| --- | --- | --- |
| `POST /api/v1/ontology/query` | `{entity, filters?, limit?, offset?}` | `objectQuery` 结果 `{columns, rows, rowCount}`（limit 默认 20 / offset 默认 0，包内钳制） |
| `POST /api/v1/ontology/sql` | `{sql, params?}` | `executeOntologySql` 结果 `{columns, rows, rowCount}`（params 默认 `{}`） |
| `POST /api/v1/ontology/traverse` | `{fromEntity, fromFilters?, toEntity, limit?}` | `traverse` 结果（limit 默认 200） |
| `GET /api/v1/ontology/bindings` | — | `{bindings: [{entity, table, status}]}`（approved 绑定，按实体名排序） |

路由保持薄：语义全部复用 `@datafoundry/ontology`（`objectQuery` / `executeOntologySql` / `traverse` / `resolveBinding`），路由只做参数解包 → 实体名→id（`ont_entities` 查询）→ 连接获取 → `createSuccessResult` 包装。handler 参数类型为 `OntologyRouteContext = Pick<ConfigApiContext, "metadataStore" | "userId">`（结构化子集，分发处传完整 context 兼容，测试免搭全套网关依赖）。

## 数据连接

- 按 `context.userId` 查 `metadataStore.dataSources.list({ user_id })` 中 `name === "SPC_MVP_SQLITE"` 的行（config-api.ts:656 同款 user 隔离先例）→ `JSON.parse(config_json).path` → `new DatabaseSync(path, { readOnly: true })`。
- **模块级缓存 `Map<path, DatabaseSync>`**：路径变更（数据源行改指新库）即自然重建连接，旧连接不主动关闭（MVP 取舍：进程生命周期内容忍悬挂句柄）。
- **readOnly 第二道防线**：数据连接以 `readOnly: true` 打开（实测 spc_mvp.db journal_mode=delete 下正常；实测生产库打开成功）。路由层本就不暴露写路径，两者叠加构成只读保证。
- 元数据（ont_*）经 `context.metadataStore.db` 裸句柄（config-api.ts:1600 同款先例）；ont_* 与 metadataStore 同库（本包 ensureOntologyTables 所建），实测确认。

## relations 读取（traverse）

`SELECT ... FROM ont_relations` 全表 → 只保留 **两端实体均在 approved 绑定集内** 的边 → 实体 id→名字经 `ont_entities` 反查，输出 `RelationEdge[]`（`fromEntityId`/`toEntityId` 为实体名，配合 bindings 的实体名键）。`source_field`/`target_field` 为 NULL 的边（迁移数据 15 条中 14 条如此）映射为空串——`traverse` 既有逻辑跳过无字段边，与 Python 参考一致。

## 错误映射（handler 内 try/catch → `createErrorResult`，capabilities.ts 模式）

| 情形 | 状态 | code |
| --- | --- | --- |
| 坏 JSON / 请求体非对象 / 缺 entity、sql、fromEntity/toEntity / 未知实体名 / SQL 未引用任何绑定对象（白名单拒绝） | 400 | `BAD_REQUEST` |
| 实体无 approved 绑定（resolveBinding）/ traverse 无关系路径 / 用户未配置 SPC_MVP_SQLITE / 未知子路径 | 404 | `RESOURCE_NOT_FOUND` |
| 已知路径方法不符 | 405 | `BAD_REQUEST` |
| 其余（数据侧打开失败、元数据损坏、非法绑定数据等） | 500 | `INTERNAL_ERROR` |

坏 JSON 由路由自带 `readJsonBody`（镜像 config-api.ts 同名实现，1MB 上限）显式转 400，避免被 `SyntaxError`→400 的全局约定误伤服务端 JSON 解析失败（config_json 损坏走 500）。

## 测试（`routes/ontology.test.ts`，handler 级，TDD：先写测试确认失败再实现）

fixture：`createMetadataStore` 临时库 + `ensureOntologyTables` 手插 5 实体/4 属性/5 绑定（含 array 形态与 Record 形态 fieldMap、1 个 draft 绑定）/3 关系（1 条有效 + 2 条经未绑定实体的路径）+ 临时 spc.db（4 表/7 行）+ `data_sources` 行（`dataSources.create`，注意 user 行有外键约束需先建用户）。

14 用例：
- query：成功（filters+limit+offset，精确 columns/rows）、未知实体 400、仅 draft 绑定 404
- sql：实体名重写+inline params 成功、白名单拒绝 400
- traverse：真实关系边遍历成功（fromFilters 生效）、关系路径全在绑定集外 404
- bindings：清单（4 条 approved，draft 排除）、POST 405
- 路由/传输：未知子路径 404、坏 JSON 400、query GET 405
- 数据连接：**path 变更后重建连接**（改指新库后查询读出新库数据）、**无 SPC 数据源用户 404**（同库第二用户，验证 user 隔离）
- 清理钩子：`closeCachedOntologyConnections()` 导出用于测试隔离（Windows 下打开中的 sqlite 文件会令 `rmSync` 失败）与将来运维停机复用

## 测试与回归结果

- 新增：`npx vitest run apps/api/src/routes/ontology.test.ts` → **14/14 通过**
- 回归：`npx vitest run apps/api packages/ontology` → 154 用例中 **141 通过，13 失败——全部为 `session-intent.test.ts`/`session-branching-intent.test.ts` 的既有失败**（已 `git stash` 后在干净 HEAD 复跑确认同样 13 个失败，与本任务无关，疑为环境相关）
- `npm run build` → 通过（tsc -b 全仓零错误）

## 真实数据冒烟（编译产物 apps/api/dist/routes/ontology.js + 真实 workbench.sqlite + admin@fusion.local 名下 SPC_MVP_SQLITE 行）

- `GET bindings` → 200，14 条 approved（AnomWafer/v_anom_wafer、ToolEvent/dim_tool_event、…）
- `POST query {entity:"AnomWafer", limit:3}` → 200，7 列（array 形态 fieldMap 经 resolveBinding 正确还原属性名）× 3 行真实晶圆数据
- `POST sql {sql:"SELECT COUNT(*) AS n FROM AnomWafer"}` → 200，n=243
- `POST traverse {fromEntity:"AnomWafer", toEntity:"ToolEvent"}` → 200，经 chamber_id 关系查出真实 ToolEvent 行（含中文 event_desc）
- `POST query {entity:"Nope"}` → 400 `未知实体: Nope`

## 实现偏差与理由

1. **绑定端点响应字段**：任务书要求"实体名+表+状态"，实现严格返回 `{entity, table, status}` 三字段（未夹带 entityId 等额外字段，保持 REST 面薄；Phase 2 MCP 消费方若需 id 可经实体名反查）。
2. **未知实体 → 400 而非 404**：按任务书错误规则"未知实体/坏 JSON → 400；未找到 → 404"分组理解——未知实体名属客户端入参错误（400），"未找到"（无绑定/无路径/无数据源/未知端点）归 404。
3. **`traverse` 的 fromFilters 读取点**：请求字段是 `fromFilters`（非 query 端点的 `filters`），实现时第一版误用 `filtersOf(body)` 导致过滤不生效，测试（rowCount 3≠2）当场拦截后改为 `recordValue(body.fromFilters) ?? {}`——TDD 流程的直接收益。
4. **TDD 期间发现的真 bug**：初版 `ok()` helper 写成 `{ body: ..., status }`（漏 `: 200`），成功路径全部 500（`status is not defined`），由"成功用例全红/错误用例全绿"的不对称当场暴露。
5. **`ApiConfig` 删 `service_token` 的编译影响**：零——`createEnvConfig(process.env).api`（宽类型）赋给窄类型 `ApiConfig` 合法，apps/api 内无任何 `service_token` 消费点（grep 实证）。

## 疑虑

- 回归中 13 个 session-intent 既有失败需要其他任务（或控制器）裁决归属，非本任务引入。
- 数据连接缓存对"数据源被删除/禁用"不敏感（仅按 path 查找缓存）；MVP 可接受，后续如需即时失效可在 dataSources 变更处调 `closeCachedOntologyConnections()`。
