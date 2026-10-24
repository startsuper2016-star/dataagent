# Phase 1-B Task 3 Report: service-token 认证（裁决 D6）

## 状态

完成。Commit `deec177` — `phase1b: service-token auth branch (D6)`（未 push，待控制器统一推送）。

## 变更文件

| 文件 | 变更 |
| --- | --- |
| `apps/api/src/auth/service.ts` | 新增 `AuthService.authenticateServiceToken(token): AuthIdentity`（置于 `authenticateSession` 之后）；import 增加 `constantTimeEqual`；新增模块常量 `SERVICE_TOKEN_USER_EMAIL = "admin@fusion.local"` |
| `apps/api/src/auth/config.ts` | `PasswordAuthConfig` 增加 `serviceToken: string`；`loadPasswordAuthConfig` 读取 `env.ONTOLOGY_SERVICE_TOKEN ?? ""`（写法对齐相邻 `sessionSecret` 字段） |
| `apps/api/src/server.ts` | `resolveRequestAuth` 增加 Bearer 分支；CSRF 检查条件改为 `isUnsafeMethod(request.method) && authContext.identity.session` |
| `apps/api/src/config.ts` | `ApiConfig` 增加 `service_token?: string` |
| `packages/contracts/src/index.ts` | `EnvConfig.api` 增加 `service_token?: string`；`ENV_VARIABLE_SPECS` 增加 `ONTOLOGY_SERVICE_TOKEN` 条目；`createEnvConfig` 按可选模式填充（有值才带，样式对齐 `api_key`） |
| `.env.example` | AUTH 区块后新增 `# service-token for headless ontology/automation callers` + `ONTOLOGY_SERVICE_TOKEN=` |
| `apps/api/src/auth/service-token.test.ts` | 新建，4 个用例 |

## 安全语义（按裁决 D6）

- **恒定时间比较**：复用 `auth/crypto.ts` 已有的 `constantTimeEqual`（先比长度再 `timingSafeEqual`）；比较对象是两侧对 `sessionSecret` 的 HMAC-SHA256（`hashToken`），而非明文 token。
- **未配置即整体禁用**：`serviceToken` 为空串时任何 Bearer 头都返回 401（"Service token authentication is disabled."），`ONTOLOGY_SERVICE_TOKEN=`（空值）在 `.env.example` 中即对应此默认关闭状态。
- **失败 401 不重试语义**：所有失败路径抛 `AuthError(401)`；对 `/api/v1/auth/*` 之外的 API 路由，`resolveRequestAuth` 抛错进入既有 401 处理（`server.ts` 顶层 catch），无重试循环。
- **CSRF**：session 身份（`identity.session` 真值）逐字走原 `validateCsrf` 路径，行为不变；service-token 身份 `session` 为 `undefined`，自然跳过 CSRF（Bearer 头本身免 CSRF）。`authenticateSession` / `validateCsrf` 函数体零改动。

## AuthIdentity 类型

**无需扩展**。`AuthIdentity.session` 本就是可选字段（`session?: AuthSessionRecord`，auth/service.ts:31-35），service-token 身份直接省略 `session`，`changePassword`/`logout` 等既有代码对 `identity.session` 的可选判断已兼容。

## 实现偏差与理由（侦查事实为准）

1. **env 读取位置**：任务书建议把 `config.serviceToken` 接到 contracts `createEnvConfig` → `apps/api/src/config.ts`。实际 `AuthService` 消费的是 `PasswordAuthConfig`（`loadPasswordAuthConfig(process.env)`，server.ts:170/209），因此真正的读取点在 `apps/api/src/auth/config.ts`（任务书未列出该文件，但这是 `this.config.serviceToken` 能编译的唯一接线点）。contracts 的 `ENV_VARIABLE_SPECS`/`createEnvConfig`/`EnvConfig.api` 与 `apps/api/src/config.ts` 按任务书要求同步登记（`ENV_VARIABLE_SPECS` 只含名称与描述、无值，不会泄露 secret）。两处读取同一 env 与仓库现状一致（如 `METADATA_DB_PATH` 同时被 `process.env` 直读与 `envConfig.storage` 覆盖）。
2. **`AuthError` 签名**：任务书示例是 2 参 `(401, "msg")`，实际构造器是 3 参 `(status, code, message)`，按仓库惯例使用 `new AuthError(401, "UNAUTHORIZED", "...")`。
3. **users 方法名**：实际为 `metadataStore.users.findByEmail({ email })`（非 getByEmail/findByEmail 裸签名）。
4. **额外防护**：`authenticateServiceToken` 对 `user.disabled_at` 也抛 401，与 `authenticateSession` 的禁用用户语义对齐（新增方法内部，不影响既有行为）。
5. **非 Bearer 的 `authorization` 头**（如 `Basic ...`）：不含 `Bearer ` 前缀，原样落入 session cookie 路径，行为与改动前完全一致。
6. **测试清理**：Windows 下 sqlite 句柄未关闭时 `rmSync` 抛 EBUSY，测试 `afterEach` 先 `metadata.close()` 再删临时目录（同仓库 `MetadataStore.close()` 公开 API）。

## 测试结果

- 新增：`apps/api/src/auth/service-token.test.ts` — **4/4 通过**（正确 token → admin 身份 + personal workspace + 无 session；错 token 401；未配置 401 disabled；admin 不存在 401）。
- 回归 `npx vitest run apps/api`：**26/26 通过**（8 个文件）。
- 回归 `npx vitest run packages/ontology`：**101/101 通过**（9 个文件，满足 91+ 要求）。
- `npm run typecheck`（`tsc -b tsconfig.build.json`）：0 错误。

### 已知环境性失败（与本任务无关，改动前即存在）

完整 `npx vitest run apps/api` 中 `session-intent.test.ts`（11）与 `session-branching-intent.test.ts`（2）共 13 个用例在 **Windows 本机**因 `EBUSY: resource busy or locked, unlink %TEMP%\...\metadata.sqlite` 失败——`afterEach` 的 `rmSync` 在 node:sqlite 句柄未关闭时被 Windows 锁住。已用 `git stash` 在干净工作树上复现同样的 11/11 失败，确认非本任务引入（Linux/CI 上不受影响）。这两个测试文件未加 `metadata.close()`，如需修复属独立任务。

## 后续注意（不在本任务范围）

- `/api/v1/auth/*` 路由的 identity 解析（server.ts:266-271）仍仅走 session cookie——Bearer 身份不参与 auth 路由（如 `/auth/me`、`/auth/logout`），符合 D6"本体路由用 Bearer"的范围界定。
- 本体路由（query/sql/traverse，Task 1/2 产物）通过 `context.userId`（即 admin 用户 id）定位 data_sources，无需额外改动。
- `resolveRequestAuth` 中 Bearer 前缀匹配为大小写敏感的 `"Bearer "`（HTTP 规范上 scheme 不区分大小写，但按任务规格逐字实现；调用方按示例头发送即可）。
