# Phase 1 · Task 1 报告：packages/ontology 脚手架 + ont_* 表结构

- 状态：**DONE_WITH_CONCERNS**（功能全部完成；1 个超出任务文件清单的必要补充 + 2 个风格偏差记录）
- Commit：`3fd7ab8`（phase1: ontology package scaffold with ont_* schema，未推送，按指示留给控制器统一推送）
- 实际使用的 vitest 命令：`cd "C:/Users/shuan/Documents/GitHub/datafoundry" && npx vitest run packages/ontology`（路径过滤直接可用，无需 `--root .` 或指定测试文件）

## 产出文件（6 个）

| 文件 | 说明 |
| --- | --- |
| `packages/ontology/package.json` | 与任务规格逐字一致（name=@datafoundry/ontology, version=0.1.0, private, type=module, main=./src/index.ts, scripts.test=vitest run） |
| `packages/ontology/tsconfig.json` | `{"extends": "../../tsconfig.base.json", "include": ["src/**/*.ts"]}`——根目录确认存在 tsconfig.base.json，且与 packages/metadata/tsconfig.json 的 extends 写法一致 |
| `packages/ontology/src/index.ts` | re-export `ensureOntologyTables` |
| `packages/ontology/src/schema.ts` | 9 张 ont_* 表 DDL + `ensureOntologyTables(db: DatabaseSync): void`，DDL 与任务规格逐字一致 |
| `packages/ontology/src/schema.test.ts` | 3 个测试（建表齐全 / 幂等 / ont_bindings 列集），与任务规格逐字一致 |
| `package-lock.json` | **超出任务清单的补充**（见疑虑 1）：`npm install --package-lock-only` 增加新 workspace 条目，仅 8 行插入 |

## TDD 过程实测

1. 先写测试 → `npx vitest run packages/ontology`：FAIL，`Error: Cannot find module './schema.js'`（与预期完全一致）
2. 实现 schema.ts / index.ts → 同命令：**PASS，3 tests passed（3）**，1 个测试文件
3. 附带验证 `npm ci --dry-run`：lockfile 补齐前报 `Missing: @datafoundry/ontology@0.1.0 from lock file`，补齐后通过

## 环境核实（Before You Begin 清单）

- Node v22.22.1：`node:sqlite` 无需 flag 直接可用（仅有 ExperimentalWarning，与 metadata 包现有用法一致）
- 根 `tsconfig.base.json` 存在（module=NodeNext, strict, composite）→ 按指示走 extends 分支
- `packages/ontology/test/golden/golden.json` 已由前一任务（d89a0a4）提交，本任务未触碰；`git add packages/ontology` 只带入了 5 个新文件
- `tsconfig.build.json` 未引用 packages/ontology → `npm run build`/`tsc -b` 不受影响（该包按 source-main 方式先行，后续任务接线时再入 build graph）

## 疑虑

1. **package-lock.json 一并提交（超出任务文件清单，有意为之）**：新增 workspace 后 `npm ci` 会因 lockfile 缺条目而失败（已实测）。用 `npm install --package-lock-only` 修复，diff 仅 8 行（node_modules/@datafoundry/ontology link + packages/ontology 条目），无其他漂移。若控制器不希望本 commit 含 lockfile，可 `git show 3fd7ab8 -- package-lock.json` 单独摘除，但之后必须有人补跑 `npm install`，否则任何 `npm ci` 环境都会挂。
2. **package.json 风格与兄弟包不一致（按任务规格保留）**：metadata/knowledge 用 `main: dist/index.js` + types + build/typecheck 脚本；本包按任务规格用 `main: ./src/index.ts`。字段名（private/type/scripts）与兄弟包一致，仅 main 取值风格不同——这是 source-main 脚手架的暂态形态，后续接线任务应统一。
3. **ont_relations / ont_bindings / ont_versions 等表未加 FK 约束**：任务 DDL 中仅 ont_entities、ont_attributes 有 REFERENCES，ont_relations.from/to_entity_id、ont_bindings.entity_id/datasource_id、ont_version_entities.source_entity_id 均为裸列。与任务规格逐字一致故照抄，仅提示后续数据迁移/校验任务注意引用完整性靠应用层保证。
