# Phase 1 Task 6 报告 — traverse（关系 BFS + JOIN 编译）

## 状态

完成。全部测试通过：**69/69**（schema 3 + dsl 17 + inline-params 10 + query 5 + **traverse 11** + ontology-sql 11 + golden 12；基线 58 + 新增 11）。其中 traverse 11 条 = 内存 fixture 9 条（brief 指定 4 条 + 扩展 5 条）+ 真实 spc_mvp.db golden 复现 2 条（`describe.skipIf` 守卫）。spc_mvp.db 只读使用，文件未改动。

## Commit

- `ee55f99` — `phase1: traverse BFS + JOIN compilation + golden parity`（未 push）

## 产物

- 新增 `packages/ontology/src/traverse.ts`：
  - `RelationEdge = { fromEntityId, toEntityId, sourceField, targetField }`（由调用方从 ont_relations 查询传入，保持包与 DB schema 解耦；Task 7 迁移后即可接真实关系）。
  - `traverse(conn, bindings, relations, fromEntity, fromFilters, toEntity, limit=200): { columns, rows, rowCount }`，行为契约逐条落实：
    1. **同实体短路**：from===to 直接复用 `objectQuery`（objectQuery 等价行，目标列=起点列）；
    2. **双向邻接表**：每条边两个方向入队（反向字段对调）；source/target 字段为空的边跳过（与元枢 Python 参考一致）；
    3. **BFS 最短路径**：入队即标记 seen（首达即最短），hops 随队携带（回溯即路径），命中 toEntity 即止；
    4. **JOIN 编译**：别名 `a0..aN`，`JOIN <源> a{i+1} ON a{i}."leftCol" = a{i+1}."rightCol"`；hop 字段经**各自实体 fieldMap** 翻译物理列，未映射抛 `关系字段 x/y 未映射到物理列，无法遍历`；绑定带 `sourceSql` 时与 objectQuery 同语义（括号子查询）；
    5. **SELECT DISTINCT** + 目标 fieldMap 全列投影（`aN."col" AS "attr"`）；
    6. **WHERE**：复用 Task 2 `buildWhere(srcBinding.fieldMap, fromFilters)`，产物加 `a0.` 前缀（`"col" op ?` → `a0."col" op ?`；`1 = 0`/`1 = 1` 恒等片段不加前缀），`?` 占位与参数数组顺序保持（位置绑定）；
    7. **ORDER BY**：目标实体 `idColumn` 非空时 `ORDER BY aN."idColumn"`（与 golden `ORDER BY t.id` 及 objectQuery 排序语义对齐；已实测 SQLite 允许 DISTINCT + 别名列上的限定名排序）；
    8. **LIMIT 钳制**：`max(1, min(truncate(limit), MAX_ROWS=200))`，非有限数回退 200（MAX_ROWS 复用 query.js 导出常量）；
    9. **无路径**：抛 `对象 ${fromEntity} 到 ${toEntity} 之间没有登记字段映射的关系路径`（含两个实体名）；
    10. **返回**：按目标实体 fieldMap 列序的 `rows: unknown[][]`（`r[c] ?? null`，与 objectQuery 同法还原数组形态）。
- 修改 `packages/ontology/src/index.ts`：追加 `export * from "./traverse.js"`。
- 新增测试 `packages/ontology/src/traverse.test.ts`（11 条，见下）。

## 测试清单（traverse 11 条）

brief 指定 4 条（原文保留，fixture 逐字复刻）：

1. `joins via relation and dedupes (DISTINCT)` — CH_B 过滤 → EVT-001/EVT-003，rowCount 2；
2. `applies source filters via DSL` — `in` DSL → EVT-002；
3. `throws on no relation path` — RcaDaily → `/关系路径|关系/`；
4. `same entity returns objectQuery-equivalent rows` — rowCount 1。

扩展 5 条（内存 fixture 追加 dim_chamber/dim_tool 三实体，短路径可观测设计）：

5. `traverses a registered relation in reverse` — 反向边（ToolEvent→AnomWafer），字段对调后 JOIN 正确；
6. `compiles a 2-hop JOIN chain` — AnomWafer→Chamber→Tool 两跳 `a0→a1→a2` + 起点过滤 + NULL 物理值照常投影；
7. `picks BFS shortest path when 1-hop and 2-hop routes both exist` — 直连边**登记在最末**仍取 1 跳（两路结果可区分：直连命中 T-DIRECT 行、2 跳命中 PVD01 行）；
8. `throws when a relation field is not mapped to a physical column` — Chamber fieldMap 缺 eqp_id → `/未映射到物理列/`；
9. `clamps limit` — limit=1 → 1 行；limit=0 → 钳升为 1（LIMIT 1 可观测）。

golden 复现 2 条（真实 spc_mvp.db，`skipIf(!HAS_DB)`，golden.json 为期望源）：

10. `traverse_anom_to_events` — 无过滤 → 3 行，columns+rows **深比较全等**；
11. `traverse_with_source_filter` — CH_A 过滤 → golden 行值切片对比（见下"Golden 口径说明"）。

## Golden 口径说明（traverse_with_source_filter 的投影差异）

golden 该例 SQL 为手写投影（仅 `t.id, t.event_type` 两列）；而 traverse 契约是**目标 fieldMap 全列投影**（契约⑦）且 **JOIN 字段必须在 fieldMap 中**（契约②，未映射即抛错）。因此该例无法用"仅两属性的 fieldMap"复现——join 字段 chamber_id 一旦不在映射里实现会正确抛错。处理：两条 golden 用例共用 ToolEvent 全量 fieldMap（id/eqp_id/chamber_id/event_type/event_start），case 12 全列深比较全等；case 13 以列子集切片对比行值（fieldMap 键序 id=0, event_type=3），排序同为 `ORDER BY t.id`。这与元枢 Python 侧行为一致（Python golden 亦为全属性映射 + 手写 SQL 投影）。

## 评审实锤点的落实（文档注释已固化在 traverse.ts 顶部）

- **白名单门实为"无引用拒绝"**：traverse 不经 executeOntologySql 通道，SQL 由本函数构造、列名全部来自受控 fieldMap（无 replace `$` 风险）；但 JSDoc 明确写明 executeOntologySql 的白名单只拒绝"零对象引用"的 SQL，混合引用（绑定对象+未绑定物理表）会执行，调用方不得依赖它做隔离。
- **同名列折叠限制**：目标 fieldMap 若把两属性映射到同一物理列，对象形态读行时后者覆盖前者（与 objectQuery 同一限制），已在 JSDoc 注明。

## 实测发现的实现级问题

1. **SQLite DISTINCT + 别名列排序**：`SELECT DISTINCT a1."id" AS "id" ... ORDER BY a1."id"` 合法（实测 node:sqlite），限定名排序不触发 "ORDER BY term does not match result set"，ORDER BY 方案无需别名回退。
2. **noUncheckedIndexedAccess 严格化**：仓库 tsconfig.base 声明 `noUncheckedIndexedAccess`/`exactOptionalPropertyTypes`。traverse.ts 按 dsl.ts 的运行时守卫风格收窄数组下标（守卫实际不可达，已注释说明）；`stmt.all(...params)` 以 `Parameters<typeof stmt.all>` 显式收窄。**traverse.ts / traverse.test.ts 单文件严格 tsc 0 错误**（预存文件 bindings.ts/query.ts 在同口径下有 2 处旧错误，见"疑虑"）。
3. **exactOptionalPropertyTypes 下可选属性展开失配**：测试里 `{ ...B_EXT.Chamber, fieldMap: ... }` 触发 TS2375（Binding 含 `sourceSql?`），改为显式字面量构造，测试无类型妥协。

## 疑虑 / 遗留

- **预存严格类型错误（非本任务引入）**：以 strict+noUncheckedIndexedAccess+exactOptionalPropertyTypes 单文件口径检查，`bindings.ts:18`（`sourceSql: string | undefined` 赋给 `sourceSql?`）与 `query.ts:26`（`all(...params)` 的 unknown 入参）各 1 处。Task 4/5 范围文件，未越界修改；仓库自带的 `-p packages/ontology/tsconfig.json` 因 base 的 `rootDir: "src"` 自 Task 1 起就报 TS6059（与本次改动无关，vitest 是事实上的门禁），建议后续任务统一处理。
- **同实体分支的 limit 边界**：from===to 复用 objectQuery，其钳制为 `falsy→20`（objectQuery 既有语义），与 JOIN 路径的 `max(1,...)` 在 limit=0 时结果不同（20 行 vs 1 行）。测试未覆盖该边角；如需统一可在后续任务给 objectQuery 加 clamp 常量函数。
- **多跳 + sourceSql 起点组合**未在 golden 中出现，实现按 objectQuery 语义支持（括号子查询），仅以实现审阅背书，无专项测试。

## 汇报摘要（供 coordinator）

状态：完成 | commit：`ee55f99`（未 push） | 测试：69/69 全绿（新增 traverse 11：内存 9 + 真实库 golden 2） | 多跳用例：2 跳 JOIN 链（AnomWafer→Chamber→Tool）通过，且"直连边登记在末位仍取 1 跳"的最短路径可观测用例通过 | 疑虑：golden traverse_with_source_filter 为手写投影仅 2 列，traverse 按契约全列投影后以列子集切片对比（与 Python 侧同构）；预存 strict 类型旧错 2 处（bindings.ts/query.ts，非本次引入）。
