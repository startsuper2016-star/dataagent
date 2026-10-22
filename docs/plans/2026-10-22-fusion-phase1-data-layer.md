# Fusion Phase 1 — Data Layer (packages/ontology) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 DataFoundry fork 内新建 `packages/ontology` TS 包：ont_* 表结构（注入 MetadataStore 句柄）、元枢 ontology.db 迁移脚本、filter DSL/对象查询/对象名 SQL/关系遍历的 TS 实现——全部通过 20 条 golden 断言。

**Architecture:** 本 slice 是 Phase 1 的数据层（不含 API 路由与 UI）。查询执行走 node:sqlite 直连 spc_mvp.db 的绑定数据源（Phase 1 全部数据源=本地 SQLite，裁决 D2/D6 的 SQLite-only 口径）；`apps/api` 路由与治理 UI 是后续 slice。本体表通过 `MetadataStore`（packages/metadata）注入的 `DatabaseSync` 句柄建表（裁决 D4：不改其迁移链）。

**Tech Stack:** TypeScript 5 / Node 22 内置 `node:sqlite`（DatabaseSync）/ vitest 3（根工作区自动收编 `packages/*/src/*.test.ts`）。

## Global Constraints

- Golden 断言是最高契约：`packages/ontology/test/golden/golden.json`（20 用例/682 行）来自 Python 参考实现，TS 输出必须与 `expectedColumns`/`expectedRows` 深比较一致；**回归不过不合入**。
- 沙箱外沿用元枢查询语义：filter DSL 12 操作符（eq/neq/gt/gte/lt/lte/like/not_like/in/not_in/is_null/not_null）、空 in→`1 = 0`/空 not_in→`1 = 1`、LIKE 大小写不敏感（regex IGNORECASE）、比较类型不兼容即抛错、null 除 is_null/not_null 外一律 false。
- 对象名重写正则必须用 Unicode 属性类：`(?<![\p{L}\p{N}_.])<Name>(?![\p{L}\p{N}_])`（JS `\w` 不含中文——评审 P1-4 实锤）。
- 参数内联必须采用 spike 附录 C 的**单遍替换版** + `^p\d+$` 键名断言（Task 6 评审定案，naive 版有级联与 `$` 模式双缺陷）。
- 单查询行上限常量 `MAX_ROWS = 200`（golden 口径）；元数据写入单进程（migration 脚本运行时不得有 apps/api 写入）。
- 迁移保留元枢原 id（实体/属性/关系/函数 id 原样），便于校验与断链排查。
- 本 slice **不做**：fernet 凭据重加密工具（mysql 连接以 `status=disabled` 占位迁移）、API 路由、治理 UI——分别属后续 slice。

---

### Task 1: packages/ontology 脚手架 + ont_* 表结构

**Files:**
- Create: `packages/ontology/package.json`
- Create: `packages/ontology/tsconfig.json`
- Create: `packages/ontology/src/index.ts`
- Create: `packages/ontology/src/schema.ts`
- Test: `packages/ontology/src/schema.test.ts`

**Interfaces:**
- Produces: `ensureOntologyTables(db: DatabaseSync): void`（幂等，CREATE TABLE IF NOT EXISTS × 9）；`export * from "./index"` 后续任务从此包导入。

- [ ] **Step 1: 建包骨架**

`packages/ontology/package.json`：
```json
{
  "name": "@datafoundry/ontology",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "scripts": { "test": "vitest run" }
}
```
`packages/ontology/tsconfig.json`：
```json
{ "extends": "../../tsconfig.base.json", "include": ["src/**/*.ts", "test/**/*.ts"] }
```
（若根 tsconfig.base.json 不存在，改为独立最小 tsconfig：`{"compilerOptions":{"target":"ES2022","module":"ESNext","moduleResolution":"bundler","strict":true,"skipLibCheck":true},"include":["src/**/*.ts"]}`）
并在根 `package.json` 的 `workspaces` 确认 `packages/*` 已覆盖（已覆盖，无需改）。

- [ ] **Step 2: 写失败测试**

`packages/ontology/src/schema.test.ts`：
```typescript
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { ensureOntologyTables } from "./schema.js";

const ONT_TABLES = ["ont_ontologies","ont_entities","ont_attributes","ont_relations",
  "ont_bindings","ont_functions","ont_skill_bindings","ont_versions","ont_version_entities"];

describe("ensureOntologyTables", () => {
  it("creates all ont_* tables", () => {
    const db = new DatabaseSync(":memory:");
    ensureOntologyTables(db);
    const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'ont_%'").all() as {name:string}[];
    expect(rows.map(r => r.name).sort()).toEqual([...ONT_TABLES].sort());
  });
  it("is idempotent", () => {
    const db = new DatabaseSync(":memory:");
    ensureOntologyTables(db);
    expect(() => ensureOntologyTables(db)).not.toThrow();
  });
  it("has FKEYs to entities and preserves column set of ont_bindings", () => {
    const db = new DatabaseSync(":memory:");
    ensureOntologyTables(db);
    const cols = db.prepare("PRAGMA table_info(ont_bindings)").all() as {name:string}[];
    expect(cols.map(c => c.name)).toEqual(["id","entity_id","datasource_id","table_name","id_column",
      "filter_expr","source_sql","field_mappings_json","status"]);
  });
});
```

- [ ] **Step 3: 运行确认失败**

Run: `npx vitest run packages/ontology`
Expected: FAIL（Cannot find module ./schema.js）

- [ ] **Step 4: 实现 schema.ts**

`packages/ontology/src/schema.ts`：
```typescript
import type { DatabaseSync } from "node:sqlite";

const DDL = [
  `CREATE TABLE IF NOT EXISTS ont_ontologies (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, code TEXT, description TEXT)`,
  `CREATE TABLE IF NOT EXISTS ont_entities (
    id TEXT PRIMARY KEY, ontology_id TEXT NOT NULL REFERENCES ont_ontologies(id),
    name TEXT NOT NULL, name_cn TEXT, tier INTEGER DEFAULT 2, status TEXT DEFAULT 'draft',
    description TEXT, config_json TEXT)`,
  `CREATE TABLE IF NOT EXISTS ont_attributes (
    id TEXT PRIMARY KEY, entity_id TEXT NOT NULL REFERENCES ont_entities(id),
    name TEXT NOT NULL, display_name TEXT, type TEXT DEFAULT 'string',
    required INTEGER DEFAULT 0, description TEXT, sort INTEGER DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS ont_relations (
    id TEXT PRIMARY KEY, from_entity_id TEXT NOT NULL, to_entity_id TEXT NOT NULL,
    name TEXT NOT NULL, rel_type TEXT DEFAULT 'has_many', cardinality TEXT DEFAULT '1:N',
    source_field TEXT, target_field TEXT, description TEXT)`,
  `CREATE TABLE IF NOT EXISTS ont_bindings (
    id TEXT PRIMARY KEY, entity_id TEXT NOT NULL, datasource_id TEXT NOT NULL,
    table_name TEXT, id_column TEXT, filter_expr TEXT, source_sql TEXT,
    field_mappings_json TEXT, status TEXT DEFAULT 'draft')`,
  `CREATE TABLE IF NOT EXISTS ont_functions (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, callable_name TEXT NOT NULL,
    description TEXT, input_schema_json TEXT, entity_id TEXT, entity_ids_json TEXT,
    runtime TEXT DEFAULT 'ontology-logic', status TEXT DEFAULT 'active', tags_json TEXT)`,
  `CREATE TABLE IF NOT EXISTS ont_skill_bindings (
    id TEXT PRIMARY KEY, skill_id TEXT NOT NULL, version INTEGER NOT NULL,
    skill_name TEXT, entity_ids_json TEXT)`,
  `CREATE TABLE IF NOT EXISTS ont_versions (
    id TEXT PRIMARY KEY, ontology_id TEXT NOT NULL, version_number INTEGER NOT NULL,
    status TEXT DEFAULT 'draft', name TEXT, description TEXT,
    config_snapshot_json TEXT, created_at TEXT, submitted_at TEXT, published_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS ont_version_entities (
    version_id TEXT NOT NULL, version_entity_id TEXT PRIMARY KEY,
    source_entity_id TEXT NOT NULL)`,
];

export function ensureOntologyTables(db: DatabaseSync): void {
  for (const ddl of DDL) db.exec(ddl);
}
```

`packages/ontology/src/index.ts`：
```typescript
export { ensureOntologyTables } from "./schema.js";
```

- [ ] **Step 5: 运行确认通过**

Run: `npx vitest run packages/ontology`
Expected: PASS (3 tests)

- [ ] **Step 6: Commit**

```bash
git add packages/ontology && git commit -m "phase1: ontology package scaffold with ont_* schema"
```

---

### Task 2: filter DSL 移植（12 操作符 + Python 语义对齐）

**Files:**
- Create: `packages/ontology/src/dsl.ts`
- Test: `packages/ontology/src/dsl.test.ts`

**Interfaces:**
- Produces:
  - `iterFilterConditions(filters: Filters): [string, Op, Value][]`
  - `buildWhere(fieldMap: Record<string,string>, filters: Filters): { where: string[]; params: SQLOutParam[] }`（fieldMap=属性名→物理列；SQLOutParam 为 string|number|boolean|null）
  - `matchFilterValue(value: unknown, condition: unknown): boolean`（enrichment/内存匹配，Python 对齐）
  - `likeToRegex(pattern: string): RegExp`
- 消费方：Task 4 `objectQuery`、Task 6 `traverse`。

- [ ] **Step 1: 写失败测试**（覆盖 Python 对齐 7 陷阱）

`packages/ontology/src/dsl.test.ts`（完整文件，断言直译元枢 `entity_data_service.py` 语义）：
```typescript
import { describe, expect, it } from "vitest";
import { buildWhere, iterFilterConditions, likeToRegex, matchFilterValue } from "./dsl.js";

const FM = { chamber_id: "chamber_id", stat_date: "stat_date", day_mean: "day_mean" };

describe("iterFilterConditions", () => {
  it("plain value becomes eq", () => {
    expect([...iterFilterConditions({ a: 1 })]).toEqual([["a", "eq", 1]]);
  });
  it("dict expands to ops, unknown op throws", () => {
    expect([...iterFilterConditions({ a: { gte: 1, lt: 5 } })]).toEqual([["a","gte",1],["a","lt",5]]);
    expect(() => [...iterFilterConditions({ a: { foo: 1 } })]).toThrow(/不支持的过滤操作符/);
  });
});

describe("buildWhere", () => {
  it("translates all 12 ops with bound params", () => {
    const { where, params } = buildWhere(FM, {
      chamber_id: { eq: "A" }, stat_date: { gte: "2026-09-21" },
      day_mean: { neq: null as unknown as number },
    });
    expect(where[0]).toBe('"chamber_id" = :p0');
    expect(where[1]).toBe('"stat_date" >= :p1');
  });
  it("empty in is 1=0, empty not_in is 1=1", () => {
    expect(buildWhere(FM, { chamber_id: { in: [] } }).where[0]).toBe("1 = 0");
    expect(buildWhere(FM, { chamber_id: { not_in: [] } }).where[0]).toBe("1 = 1");
  });
  it("expanding in with multiple params", () => {
    const { where, params } = buildWhere(FM, { chamber_id: { in: ["A", "B"] } });
    expect(where[0]).toBe('"chamber_id" IN (:p0_0, :p0_1)');
    expect(params).toEqual(["A", "B"]);
  });
  it("is_null / not_null need no param", () => {
    expect(buildWhere(FM, { day_mean: { is_null: true } }).where[0]).toBe('"day_mean" IS NULL');
  });
  it("throws on unknown attribute", () => {
    expect(() => buildWhere(FM, { nope: 1 })).toThrow();
  });
});

describe("matchFilterValue (python parity)", () => {
  it("null is false for everything except is_null/not_null", () => {
    expect(matchFilterValue(null, { gte: 1 })).toBe(false);
    expect(matchFilterValue(null, { is_null: true })).toBe(true);
    expect(matchFilterValue(null, "x")).toBe(false);
  });
  it("strict type mismatch throws like python TypeError", () => {
    expect(() => matchFilterValue("10", { gt: 9 })).toThrow();
  });
  it("empty arrays for in / not_in", () => {
    expect(matchFilterValue("x", { in: [] })).toBe(false);
    expect(matchFilterValue("x", { not_in: [] })).toBe(true);
  });
  it("like is case-insensitive with % and _ wildcards", () => {
    expect(matchFilterValue("L26-100", { like: "l26-1%" })).toBe(true);
    expect(matchFilterValue("L26-100", { like: "l26-1_" })).toBe(true);
    expect(matchFilterValue("L26-100", { not_like: "zz%" })).toBe(true);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run packages/ontology`
Expected: FAIL（./dsl.js 不存在）

- [ ] **Step 3: 实现 dsl.ts**

`packages/ontology/src/dsl.ts`：
```typescript
export type Filters = Record<string, unknown>;
export const FILTER_OPS = ["eq","neq","gt","gte","lt","lte","like","not_like","in","not_in","is_null","not_null"] as const;
export type Op = (typeof FILTER_OPS)[number];
const OP_SQL: Record<string, string> = { eq: "=", neq: "<>", gt: ">", gte: ">=", lt: "<", lte: "<=", like: "LIKE", not_like: "NOT LIKE" };

export function* iterFilterConditions(filters: Filters): Generator<[string, Op, unknown]> {
  for (const [name, value] of Object.entries(filters ?? {})) {
    if (value !== null && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length > 0) {
      const unknown = Object.keys(value).filter(k => !FILTER_OPS.includes(k as Op));
      if (unknown.length) throw new Error(`不支持的过滤操作符: ${unknown.join(", ")}`);
      for (const [op, v] of Object.entries(value)) yield [name, op as Op, v];
    } else {
      yield [name, "eq", value];
    }
  }
}

export function likeToRegex(pattern: string): RegExp {
  const body = [...pattern].map(ch => ch === "%" ? ".*" : ch === "_" ? "." : ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("");
  return new RegExp(`^${body}$`, "i");   // SQLite LIKE 默认 ASCII 不敏感
}

function isComparable(a: unknown, b: unknown): boolean {
  return (typeof a === "number" && typeof b === "number") || (typeof a === "string" && typeof b === "string");
}

export function matchSingle(value: unknown, op: Op, cond: unknown): boolean {
  if (op === "is_null") return value === null || value === undefined;
  if (op === "not_null") return !(value === null || value === undefined);
  if (value === null || value === undefined) return false;
  switch (op) {
    case "eq": return value === cond;
    case "neq": return value !== cond;
    case "gt": case "gte": case "lt": case "lte": {
      if (!isComparable(value, cond)) throw new Error(`'<' not supported between instances of '${typeof value}' and '${typeof cond}'`);
      const v = value as string | number, c = cond as string | number;
      return op === "gt" ? v > c : op === "gte" ? v >= c : op === "lt" ? v < c : v <= c;
    }
    case "in": return (Array.isArray(cond) ? cond : [cond]).includes(value as never);
    case "not_in": return !(Array.isArray(cond) ? cond : [cond]).includes(value as never);
    case "like": return likeToRegex(String(cond)).test(String(value));
    case "not_like": return !likeToRegex(String(cond)).test(String(value));
    default: throw new Error(`不支持的过滤操作符: ${op}`);
  }
}

export function matchFilterValue(value: unknown, condition: unknown): boolean {
  if (condition !== null && typeof condition === "object" && !Array.isArray(condition) && Object.keys(condition).length > 0) {
    const unknown = Object.keys(condition).filter(k => !FILTER_OPS.includes(k as Op));
    if (unknown.length) throw new Error(`不支持的过滤操作符: ${unknown.join(", ")}`);
    return Object.entries(condition).every(([op, v]) => matchSingle(value, op as Op, v));
  }
  return matchSingle(value, "eq", condition);
}

export function buildWhere(fieldMap: Record<string, string>, filters: Filters): { where: string[]; params: Record<string, unknown> } {
  const where: string[] = [];
  const params: Record<string, unknown> = {};
  for (const [attr, op, value] of iterFilterConditions(filters)) {
    const col = fieldMap[attr];
    if (!col) throw new Error(`属性未定义或未绑定: ${attr}`);
    const quoted = `"${col}"`;
    if (op === "is_null") { where.push(`${quoted} IS NULL`); continue; }
    if (op === "not_null") { where.push(`${quoted} IS NOT NULL`); continue; }
    if (op === "in" || op === "not_in") {
      const values = Array.isArray(value) ? value : [value];
      if (values.length === 0) { where.push(op === "in" ? "1 = 0" : "1 = 1"); continue; }
      const keys = values.map((v, j) => { const key = `p${i}_${j}`; params[key] = v; return `:${key}`; });
      where.push(`${quoted} ${op === "in" ? "IN" : "NOT IN"} (${keys.join(", ")})`);
      continue;
    }
    const key = `p${i}`;
    params[key] = value;
    where.push(`${quoted} ${OP_SQL[op]} :${key}`);
  }
  return { where, params };
}
let i = 0; // 与上面循环配合：把声明提升到函数内——实现时将 let i = 0 放在 for 之前
```
（实现注意：`let i = 0` 必须在 for 循环之前声明；上面的注释只是提醒，不要把声明放文件尾。）

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run packages/ontology`
Expected: 全部 PASS

- [ ] **Step 5: Commit**

```bash
git add packages/ontology/src/dsl.ts packages/ontology/src/dsl.test.ts packages/ontology/src/index.ts
git commit -m "phase1: filter DSL port (12 ops, python-parity semantics)"
```
（`index.ts` 追加 `export * from "./dsl.js";`）

---

### Task 3: 参数内联（spike 附录 C 单遍替换版 + 键名断言）

**Files:**
- Create: `packages/ontology/src/inline-params.ts`
- Test: `packages/ontology/src/inline-params.test.ts`

**Interfaces:**
- Produces: `inlineParams(sql: string, params: Record<string, unknown>): string`（Task 5 `executeOntologySql` 消费）。
- 安全契约：单遍替换（replace 回调，产物不重扫）；键名必须匹配 `^p\d+(_\d+)?$`，否则抛错；SQLite-only 转义（`''` 翻倍）；数值走 `Number.isFinite` 门卫。

- [ ] **Step 1: 写失败测试**（从 `%TEMP%/spike-params/matrix.mjs` 移植核心 12 用例 + 级联/$模式两组缺陷回归）

`packages/ontology/src/inline-params.test.ts`：
```typescript
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { inlineParams } from "./inline-params.js";

describe("inlineParams", () => {
  it("inlines named params as literals", () => {
    expect(inlineParams("SELECT * FROM t WHERE a = :p0 AND b = :p1", { p0: "x", p1: 5 }))
      .toBe("SELECT * FROM t WHERE a = 'x' AND b = 5");
  });
  it("escapes single quotes", () => {
    const sql = inlineParams("SELECT * FROM t WHERE a = :p0", { p0: "x'; DROP TABLE t;--" });
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE t(a TEXT)");
    const rows = db.prepare(sql).all();
    expect(rows.length).toBe(0);           // 按字面量匹配，无表被删
    expect(db.prepare("SELECT count(*) AS c FROM sqlite_master WHERE type='table'").get()).toEqual({ c: 1 });
  });
  it("rejects keys outside ^p\\d+(_\\d+)?$ contract", () => {
    expect(() => inlineParams("SELECT 1", { evil: 1 })).toThrow(/参数键名/);
  });
  it("no cascade: value containing :p1 does not re-expand", () => {
    const sql = inlineParams("SELECT * FROM t WHERE a = :p0", { p0: ":p1' OR '1'='1", p1: "zzz" });
    expect(sql).toBe("SELECT * FROM t WHERE a = ':p1'' OR ''1''=''1'");
  });
  it("no $-pattern interpretation in replacement", () => {
    const sql = inlineParams("SELECT * FROM t WHERE a = :p0", { p0: "$& $' $`" });
    expect(sql).toBe("SELECT * FROM t WHERE a = '$& $' $`'");
  });
  it("adjacent params both replaced", () => {
    expect(inlineParams("SELECT :p0:p1", { p0: 1, p1: 2 })).toBe("SELECT 12");
  });
  it("null and boolean literals", () => {
    expect(inlineParams("SELECT :p0, :p1", { p0: null, p1: true })).toBe("SELECT NULL, 1");
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run packages/ontology`
Expected: FAIL（./inline-params.js 不存在）

- [ ] **Step 3: 实现 inline-params.ts**（照抄 spike 附录 C 单遍版 + 键名断言）

```typescript
export function inlineParams(sql: string, params: Record<string, unknown>): string {
  for (const key of Object.keys(params)) {
    if (!/^p\d+(_\d+)?$/.test(key)) throw new Error(`参数键名不合法: ${key}（必须为 p<N>[_<M>]）`);
  }
  const entries = Object.entries(params);
  if (entries.length === 0) return sql;
  const re = new RegExp(`:(?:${entries.map(([k]) => k).join("|")})\\b`, "g");
  return sql.replace(re, (token) => {
    const key = token.slice(1);
    if (!(key in params)) return token;
    const v = params[key];
    if (v === null || v === undefined) return "NULL";
    if (typeof v === "number") { if (!Number.isFinite(v)) return `'${String(v)}'`; return String(v); }
    if (typeof v === "boolean") return v ? "1" : "0";
    return `'${String(v).replace(/'/g, "''")}'`;
  });
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run packages/ontology`
Expected: 全部 PASS

- [ ] **Step 5: Commit**

```bash
git add packages/ontology/src/inline-params.ts packages/ontology/src/inline-params.test.ts
git commit -m "phase1: inline params (single-pass, key contract, spike appendix C)"
```

---

### Task 4: 对象查询 objectQuery + golden 断言（cases 1-13）

**Files:**
- Create: `packages/ontology/src/bindings.ts`（绑定解析：实体→{datasource, table, idColumn, fieldMap}）
- Create: `packages/ontology/src/query.ts`
- Test: `packages/ontology/src/query.test.ts`
- Test: `packages/ontology/src/golden.test.ts`

**Interfaces:**
- Consumes: Task 1 `ensureOntologyTables`、Task 2 `buildWhere`、Task 3 `inlineParams`；绑定数据来自迁移后的 ont_bindings/ont_entities（Task 6 迁移脚本填充，本任务用内存 fixture 测试）。
- Produces:
  - `type Binding = { datasourceId: string; table: string; idColumn: string; fieldMap: Record<string,string>; sourceSql?: string; status: string }`
  - `resolveBinding(db: DatabaseSync, entityId: string): Binding`
  - `objectQuery(db: DatabaseSync, bindings: Record<string, Binding>, entityId: string, filters: Filters, limit?: number, offset?: number): { columns: string[]; rows: unknown[][]; rowCount: number }`
  - `executeOntologySql(db, bindings, sql, params?): { columns, rows, rowCount }`（对象名重写 + 白名单 + inlineParams）

- [ ] **Step 1: 写失败测试（内存绑定 fixture + golden 断言）**

`packages/ontology/src/query.test.ts`（绑定 fixture 直指 spc_mvp.db 副本；golden 从 `test/golden/golden.json` 读取 cases 1-13 —— 即 `eq_chamber` 至 `total_count_matches_pages`，逐条执行 `buildWhere + 组装 SELECT` 并与 `expectedColumns/expectedRows` 深比较）：
```typescript
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { describe, expect, it, beforeAll } from "vitest";
import { objectQuery } from "./query.js";

const GOLDEN = JSON.parse(readFileSync(new URL("./golden/golden.json", import.meta.url), "utf-8"));
const SPC_DB = process.env.SPC_DB_PATH ?? "C:/Users/shuan/Downloads/ontology-master (3)/ontology-master/local-data/spc_mvp/spc_mvp.db";
```
（spc_mvp.db 绝对路径以环境变量注入；CI 无此文件时 `describe.skipIf(!existsSync(SPC_DB))`。）
fixture 绑定：`AnomWafer→v_anom_wafer`、`RcaDaily→v_day_flag`、`RcaChamberRate→v_chamber_rate`、`AnomLot→v_anom_lot`（fieldMap 列=属性名，id 列=id）。
断言样例：
```typescript
it("golden eq_chamber", () => {
  const g = GOLDEN.cases.find(c => c.name === "eq_chamber")!;
  const r = objectQuery(db, B, "AnomWafer", { chamber_id: "PVD01_CH_B" }, 200, 0);
  expect(r.columns).toEqual(g.expectedColumns);
  expect(r.rows).toEqual(g.expectedRows);
});
```
（13 条逐一展开，翻页两条用 `LIMIT 200 OFFSET 0/200` 参数化。）

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run packages/ontology`
Expected: FAIL（./query.js 不存在）

- [ ] **Step 3: 实现 bindings.ts + query.ts**

`packages/ontology/src/bindings.ts`：
```typescript
import type { DatabaseSync } from "node:sqlite";
export type Binding = { datasourceId: string; table: string; idColumn: string;
  fieldMap: Record<string, string>; sourceSql?: string; status: string };

export function resolveBinding(db: DatabaseSync, entityId: string): Binding {
  const row = db.prepare(
    "SELECT datasource_id, table_name, id_column, source_sql, field_mappings_json, status FROM ont_bindings WHERE entity_id = ? AND status = 'approved'").get(entityId) as Record<string, unknown> | undefined;
  if (!row) throw new Error(`实体 ${entityId} 未绑定活动数据源`);
  const fieldMap: Record<string, string> = JSON.parse(String(row.field_mappings_json ?? "{}"));
  return { datasourceId: String(row.datasource_id), table: String(row.table_name),
    idColumn: String(row.id_column ?? "id"), fieldMap,
    sourceSql: row.source_sql ? String(row.source_sql) : undefined, status: String(row.status) };
}
```
（数据文件路径解析：`datasources` 表按 datasource_id 查 `config_json.path`——由调用方把 `Record<datasourceId, DatabaseSync>` 传入，包不做连接管理。）

`packages/ontology/src/query.ts`：
```typescript
import { buildWhere } from "./dsl.js";
import type { Filters } from "./dsl.js";
import { inlineParams } from "./inline-params.js";
import type { Binding } from "./bindings.js";

export const MAX_ROWS = 200;

export function objectQuery(
  conn: DatabaseSync, binding: Binding, filters: Filters, limit = 20, offset = 0,
): { columns: string[]; rows: unknown[][]; rowCount: number } {
  const cols = Object.keys(binding.fieldMap);
  if (cols.length === 0) throw new Error("对象没有可查询的已映射属性");
  const select = cols.map(c => `"${binding.fieldMap[c]}" AS "${c}"`).join(", ");
  const source = binding.sourceSql ? `(${binding.sourceSql})` : `"${binding.table}"`;
  const { where, params } = buildWhere(binding.fieldMap, filters);
  let sql = `SELECT ${select} FROM ${source}`;
  if (where.length) sql += " WHERE " + where.join(" AND ");
  if (binding.idColumn) sql += ` ORDER BY "${binding.idColumn}"`;
  const lim = Math.max(1, Math.min(Math.trunc(Number(limit)) || 20, MAX_ROWS));
  const off = Math.max(0, Math.trunc(Number(offset)) || 0);
  sql += ` LIMIT ${lim} OFFSET ${off}`;
  const named = inlineParams(sql, params);
  const stmt = conn.prepare(named);
  const columns = stmt.columns().map(c => c.name);
  const rows = (stmt.all() as Record<string, unknown>[]).map(r => cols.map(c => r[c] ?? null));
  return { columns: cols, rows, rowCount: rows.length };
}
```
（golden 断言的列序=fieldMap 定义序，与迁移脚本写入的 field_mappings_json 顺序一致即可对上。）

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run packages/ontology`
Expected: golden 1-13 全 PASS

- [ ] **Step 5: Commit**

```bash
git add packages/ontology && git commit -m "phase1: objectQuery with bindings + golden cases 1-13"
```

---

### Task 5: executeOntologySql（对象名重写 + 白名单 + 内联）+ golden cases 14-20

**Files:**
- Create: `packages/ontology/src/ontology-sql.ts`
- Test: `packages/ontology/src/ontology-sql.test.ts`（golden cases `agg_baseline_moments`…`order_asc_limit`）

**Interfaces:**
- Consumes: Task 3 `inlineParams`；绑定 fixture 同 Task 4。
- Produces: `executeOntologySql(conn, bindings, sql, params?)`——对象名重写用 Unicode 属性类正则；引用资产白名单自收集；重写后 `inlineParams` 内联（裁决 D2）。

- [ ] **Step 1: 写失败测试**（含中文对象名边界回归 + golden 聚合/遍历用例）

用例必须包含：
```typescript
it("rewrites object names with unicode-safe boundaries", () => {
  // 中文名实体（如 中文对象）与英文列相邻时不误替换
  const sql = executeOntologySqlForTest(
    { AnomWafer: "v_anom_wafer", 中文对象: "t_cn" },
    "SELECT * FROM AnomWafer a JOIN 中文对象 c ON a.wafer_id = c.wafer_id");
  expect(sql).toContain("v_anom_wafer");
  expect(sql).toContain("t_cn");
});
it("collects whitelist and rejects unknown tables", () => {
  expect(() => executeOntologySqlForTest({ WaferFact: "v_wafer_agg" }, "SELECT * FROM sqlite_master")).toThrow(/白名单|whitelist/i);
});
```
golden：`agg_baseline_moments`（WaferFact + 参数 :ws）、`agg_fdc_group`、`agg_fdc_corr`、`traverse_anom_to_events`（JOIN）、`traverse_with_source_filter`、`combo_range_and_eq`、`order_asc_limit`——通过 `executeOntologySql` 以**对象名书写的 SQL**执行并与 golden 深比较。

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run packages/ontology`
Expected: FAIL（./ontology-sql.js 不存在）

- [ ] **Step 3: 实现 ontology-sql.ts**

```typescript
import { inlineParams } from "./inline-params.js";
import type { Binding } from "./bindings.js";

export function rewriteObjectNames(
  sql: string, nameToTable: Record<string, string>,
): { sql: string; referenced: string[] } {
  let out = sql;
  const referenced: string[] = [];
  for (const name of Object.keys(nameToTable).sort((a, b) => b.length - a.length)) {
    const re = new RegExp(`(?<![\\p{L}\\p{N}_.])${name}(?![\\p{L}\\p{N}_])`, "gu");
    if (re.test(out)) { referenced.push(name); out = out.replace(re, nameToTable[name]); }
  }
  return { sql: out, referenced };
}

export function executeOntologySql(
  conn: DatabaseSync, bindings: Record<string, Binding>,
  sql: string, params: Record<string, unknown> = {},
): { columns: string[]; rows: unknown[][]; rowCount: number } {
  const nameToTable: Record<string, string> = {};
  for (const [entity, b] of Object.entries(bindings)) nameToTable[entity] = b.table;
  const { sql: rewritten, referenced } = rewriteObjectNames(sql, nameToTable);
  if (referenced.length === 0) throw new Error("SQL 未引用任何本体对象（白名单拒绝执行）");
  const inlined = inlineParams(rewritten, params);
  const stmt = conn.prepare(inlined);
  const columns = stmt.columns().map(c => c.name);
  const rows = (stmt.all() as unknown[][]).map(r => [...r]);
  return { columns, rows, rowCount: rows.length };
}
```
（`rewriteObjectNames` 单独导出供测试；测试辅助 `executeOntologySqlForTest` 用 `{实体名: 物理表}` 简化构造。golden 的 JOIN SQL 以对象名书写，例如：
`SELECT DISTINCT ToolEvent.id, ToolEvent.event_type FROM AnomWafer a JOIN ToolEvent ON AnomWafer.chamber_id = ToolEvent.chamber_id WHERE AnomWafer.chamber_id = :p0 ORDER BY ToolEvent.id`
——对象名出现即被重写，别名不受影响。）

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run packages/ontology`
Expected: golden 14-20 全 PASS；20/20 全绿

- [ ] **Step 5: Commit**

```bash
git add packages/ontology && git commit -m "phase1: executeOntologySql (unicode rewrite, whitelist, inline) + golden 20/20"
```

---

### Task 6: traverse（关系 BFS + JOIN 编译）

**Files:**
- Create: `packages/ontology/src/traverse.ts`
- Test: `packages/ontology/src/traverse.test.ts`

**Interfaces:**
- Consumes: Task 5 执行通道；关系图来自 `ont_relations`（迁移后含 anom_wafer_chamber_events）。
- Produces: `traverse(conn, bindings, fromEntity, fromFilters, toEntity, limit?): {columns, rows}`（BFS 最短路径、双向、SELECT DISTINCT、路径无关系时报错）。

- [ ] **Step 1: 写失败测试**：golden `traverse_anom_to_events`（3 行：EVT-001/EVT-002/EVT-005 按 id 排序——注意与 Task 7 Python 版 2 行的差异：Python 版按 CH_B 过滤，golden 无过滤=3 行）与 `traverse_with_source_filter`（1 行）经 traverse API 复现；外加"无关系路径→抛错"用例。
- [ ] **Step 2: 运行确认失败**
- [ ] **Step 3: 实现**（BFS deque 双向邻接表；hop 字段=relation.source_field/target_field 经 fieldMap 翻译物理列；编译 `SELECT DISTINCT t.* 列 FROM From a0 JOIN Next a1 ON ... [WHERE a0.<col> op :pN] LIMIT n`；WHERE 生成复用 Task 2 `buildWhere` 加 `a0.` 前缀逻辑——实现方式：为起点构造 `{"a0." + col: ...}` 不现实，直接复用 buildWhere 后对列名做前缀包装或单独生成）
- [ ] **Step 4: 运行确认通过**（golden 两用例数字与 Python 侧一致：全量 3 行、CH_B 过滤 2 行 EVT-001/EVT-003）
- [ ] **Step 5: Commit** `phase1: traverse BFS + JOIN compilation + golden`

---

### Task 7: migrate-yuanshu.ts（ontology.db → workbench.sqlite ont_*）

**Files:**
- Create: `scripts/migrate-yuanshu.ts`（fork 仓库根 scripts/）

**Interfaces:**
- Consumes: 元枢 `ontology.db`（只读 ATTACH）；workbench.sqlite（`apps/api/storage/metadata/workbench.sqlite`，运行迁移时 apps/api 必须停止）。
- Produces: `ont_*` 全表填充（保留原 id）+ datasources 表新增 `SPC_MVP_SQLITE` 行（type=sqlite，config_json.path=spc_mvp.db 绝对路径，status=ready，user_id=workbench 内管理员）+ 迁移校验输出。

- [ ] **Step 1: 实现迁移**（单文件脚本，`npx tsx scripts/migrate-yuanshu.ts --yuanshu <path> --workbench <path> --user <adminUserId>`）：
  - 附库 `ATTACH DATABASE` 源库只读；
  - `ensureOntologyTables(workbench)`；
  - INSERT OR REPLACE：ont_ontologies←scenario/ontology 根行（1 行，id=元枢 ontology_id）→ ont_entities（WHERE ontology_id）→ ont_attributes（WHERE entity_id IN）→ ont_relations（同）→ ont_functions（6 条，runtime='ontology-logic'）→ ont_bindings（14 条：datasource_id=新 SPC_MVP_SQLITE id，table_name=原 asset locator.table，field_mappings_json 原样拷贝）→ ont_versions/ont_version_entities（全部发布版本）→ ont_skill_bindings（3 技能）；
  - datasources 行：若 name=`SPC_MVP_SQLITE` 已存在则复用 id；
  - **校验断言**：每表行数 vs 源（entities 14/attributes 按 24 对象属性数/functions 6/skill_bindings 3）；抽样 5 行字段级比对；不一致 `process.exit(1)`。
- [ ] **Step 2: 停 apps/api → 执行迁移 → 校验通过 → 重启**
- [ ] **Step 3: 抽样核对**（golden 20 用例经 objectQuery/executeOntologySql 重跑仍全绿——数据换了存储位置但语义不变）
- [ ] **Step 4: Commit** `phase1: yuanshu migration script + verified data in workbench.sqlite`

---

### Task 8: Slice 验收 — 端到端 golden 复跑

- [ ] 在**迁移后**的 workbench.sqlite 上重跑全部 golden（绑定解析走 ont_bindings，datasource 指向 workbench 内的 SPC_MVP_SQLITE 行）
- [ ] `npx vitest run packages/ontology` 全绿（含 golden 20/20）
- [ ] `git push origin main`
- [ ] 汇报：Phase 1 数据层完成；API 路由与治理 UI 属后续 slice（P1-B/P1-C），另行展开任务级计划
