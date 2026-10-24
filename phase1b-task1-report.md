# Phase 1-B Task 1 报告：packages/ontology 补 dist 构建 + apps/api 依赖接线

**Commits**:
- `cf68139` — `phase1b: ontology dist build + workspace wiring`（计划内 3 文件 + 构建暴露的必要修复）
- `daaf822` — `phase1b: ontology golden/traverse tests lazy DB connect (CI skipIf-safe)`（CI 暴露的测试懒连接修复）

均已 push origin main。**日期**: 2026-10-22

## 计划内修改（3 文件）

1. **`packages/ontology/package.json`** — 照 `packages/knowledge/package.json` 蓝本改写：
   - `main`: `./src/index.ts` → `dist/index.js`
   - 新增 `types`: `dist/index.d.ts`
   - scripts 增加 `build: "tsc -p tsconfig.json"` 与 `typecheck`（保留原 `test: vitest run`）

2. **`tsconfig.build.json`** — references 数组中 `packages/agent-runtime` 之后、`apps/api` 之前插入 `{"path": "packages/ontology"}`。

3. **`apps/api/package.json`** — dependencies 按字母序插入 `"@datafoundry/ontology": "0.1.0"`（精确版本号风格，同其他 @datafoundry 依赖）。lockfile 由 `npm install` 同步（`package-lock.json` +1 行）。

## 计划外但必要的修复（构建/CI 接线暴露，均在 packages/ontology 范围内）

### A. `packages/ontology/tsconfig.json` — rootDir/outDir 需包内重声明（+4 行）

侦查结论"composite/rootDir:src/outDir:dist 已具备"不成立：`tsconfig.base.json` 里的相对路径 `rootDir: "src"` 按 **base 文件所在目录**（仓库根）解析，指向不存在的 `<root>/src`，首次构建报 10 个 TS6059（文件不在 rootDir 下）。`packages/knowledge/tsconfig.json` 蓝本的做法正是在自己的 compilerOptions 里重声明 `rootDir: "src"` / `outDir: "dist"`。照抄即可，无需 references（ontology 无跨包依赖）。

### B. src 内 7 个 tsc 严格模式类型错误（vitest 不做类型检查，此前从未暴露）

| 文件 | 错误 | 修法 |
|---|---|---|
| `src/bindings.ts` | TS2375 `exactOptionalPropertyTypes` 下给可选属性显式赋 `undefined` | `Binding.sourceSql?: string` → `?: string \| undefined` |
| `src/query.ts` | TS2345 `unknown[]` spread 进 `all(...SQLInputValue[])` | `import type { SQLInputValue } from "node:sqlite"`（环境模块隐式导出，可导入）+ 调用点断言 `params as SQLInputValue[]`（运行时行为不变，与既有输出侧 `as Record<string, unknown>[]` 断言风格一致） |
| `src/ontology-sql.ts` | TS2769 `nameToTable[name]` 在 `noUncheckedIndexedAccess` 下为 `string \| undefined` | 改为 `Object.entries(...)` 解构迭代（长名优先排序语义不变，免除断言） |
| `src/golden.test.ts` | TS18048 ×3 `CASES[g.name]` 可能为 undefined | 查找后加 `if (!c) throw new Error(...)` 守卫（const 收窄进闭包） |
| `src/ontology-sql.test.ts` | TS2345 解构 `string[]` 得 `string \| undefined` 传入 `colMapFor` | 数组字面量加 `as [string, string][]` 元组标注 |

均为类型层面修复，无运行时语义变化（测试结果不变可证）。

### C. 三个测试文件的 DB 急建连接（CI 首跑暴露，`daaf822`）

`golden.test.ts` / `ontology-sql.test.ts`（含 colMapFor 的 BINDINGS 构建）/ `traverse.test.ts` 在 `describe.skipIf(!HAS_DB)` 工厂内**急建** `new DatabaseSync(SPC_DB)`。vitest 的 describe 工厂在收集期无条件执行（skipIf 只标记内部用例跳过），DB 不在的机器（CI ubuntu）上直接 `ERR_SQLITE_ERROR` 收集崩溃——这正是**基线 commit（3fae006）CI "Run package unit tests" 一直红的根因**（golden + ontology-sql + traverse 三文件同报）。

修法：照同包 `acceptance.test.ts` 既有的懒建模式，改为 `let conn: DatabaseSync;` + `beforeAll(() => { conn = new DatabaseSync(SPC_DB); })`（ontology-sql 的 BINDINGS 构建一并移入 beforeAll）。有库机器行为完全不变（本机 91/91 复跑验证），无库机器干净走 skipIf。

## 验收结果

1. **`npm install` 同步 lockfile** — ✅ 通过（"added 1 package, changed 1 package"，无报错；postinstall 内的 `npm run build` 现在也成功，不再出现 build failed 提示）。
2. **`npm run build`** — ✅ 通过。`tsc -b tsconfig.build.json` 全仓零错误，产出 `packages/ontology/dist/index.js` 与 `dist/index.d.ts`（连同全部源/测试模块的 .js/.d.ts/.map，与 knowledge 包形态一致）。
3. **`npx vitest run packages/ontology`** — ✅ 通过。**8 个测试文件 91/91 全绿**（注：任务描述的"30/30"是早期里程碑口径 schema 3 + dsl 17 + inline 10；该包随后已加入 query 5、golden 12、acceptance 22、ontology-sql 8、traverse 等测试，现 src 共 91 个。改造前后对比：91 全绿 → 91 全绿，无回归）。
4. **apps/api 解析** — ✅ 通过。`apps/api` 目录下 `node -e "console.log(require.resolve('@datafoundry/ontology/package.json'))"` → `C:\Users\shuan\Documents\GitHub\datafoundry\packages\ontology\package.json`。
5. **CI（ci.yml 四 job）** — ⚠️ **3/4 绿**，见下节。

## CI 结论（关键）

**基线本就不是绿的**：本任务 push 之前的最近三次 push（3fae006 / 6541c34 / 3925c52）CI 与 Deploy Docs 均 failure。本任务两个 commit 后：

| job | 基线 3fae006 | cf68139 | daaf822（最终） |
|---|---|---|---|
| Core Smoke Tests | ✅ | ✅ | ✅ |
| Native Deploy Smoke | ✅ | ✅ | ✅ |
| Build and Web Tests | ❌ Run package unit tests（ontology 三文件 DB 急建） | ❌ 同左 | ✅（daaf822 修复后） |
| Docs | ❌ docs 词面 | ❌ docs 词面 | ❌ docs 词面 |

- **Build and Web Tests**：已在 `daaf822` 修复并转绿（该 job 的 "Build TypeScript workspaces" 步骤在 cf68139 就已绿，证明 dist 构建接线本身在 CI 上是通的）。
- **Docs job 仍红**：`scripts/smoke-doc-links.mjs` 报 `docs/plans/2026-10-22-fusion-phase1-data-layer.md` 两处问题（line 19 "public release placeholder wording"、line 460 "personal Unix path"）。该文件是 phase1b 计划文档（3fae006 引入），**与本任务代码无关**，且任务明确约束"不碰 docs 词面"，故未处理——需要由计划文档作者修词面后 Docs 才能转绿。

## 清理

首次错误构建（rootDir 解析到仓库根时 noEmitOnError 默认 false）在 `packages/ontology/src/` 旁边吐了一套 `.js/.d.ts/.map` 杂散产物，会被 vitest 重复拾取（曾致 16 文件 182 测试）。已删除全部杂散产物，src 只保留 `.ts` 源；`dist/` 在 `.gitignore`（`**/dist/`）内不会入库。

## 疑虑 / 备注

- **golden.test.ts / ontology-sql.test.ts / traverse.test.ts 中 SPC_DB 硬编码路径**指向 `C:/Users/shuan/Downloads/ontology-master (3)/ontology-master/local-data/spc_mvp/spc_mvp.db`（本机 Downloads 目录）。既有代码、非本任务范围；本机存在该库所以相关用例真实跑过且全绿。CI 上 `existsSync` 为 false，修复后走 `describe.skipIf` 干净跳过——lint 层面该路径或许更应由环境变量注入，留待后续任务。
- **dist 含测试产物**：`packages/ontology/dist/*.test.js` 会编译产出（vitest 默认 exclude `**/dist/**` 不会重复执行）。这与 knowledge 包现状完全一致（`knowledge/dist/knowledge-document-lifecycle.test.js` 同样存在），属仓库既有约定，未另行排除。
- **本地全量 `vitest run packages apps/api`** 在 Windows 本机有 6 个文件 30 用例报 `EBUSY: resource busy or locked, unlink`（apps/api session-branching 等，临时 sqlite 文件句柄未释放）——纯 Windows 文件锁环境问题，Linux CI 不复现，且与 ontology 无关（ontology 8 文件全绿）。
- 仓库根有多个前序 phase 的未跟踪报告文件（phase0-*/phase1-*-report.md、verify-like.mjs），非本任务产物，未动。

## CI 最终运行

- commit `cf68139`: run 39750905750（发现基线已红 + ontology 测试 DB 急建）
- commit `daaf822`: run 39752524165（最终结果见上表）
