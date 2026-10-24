# Phase 1 Task 5 报告 — executeOntologySql（对象名重写 + 白名单 + 内联）+ golden 收尾

## 状态

完成。全部测试通过：**58/58**（schema 3 + dsl 17 + inline-params 10 + query 5 + ontology-sql 11 + golden 12），仓库级 `tsc -b tsconfig.build.json` 通过。spc_mvp.db 只读使用，文件未改动。**golden 20/20 全部覆盖**（Task 4 的 cases 1-12 + 本任务的 cases 13-20）。

## Commit

- `2905249` — `phase1: executeOntologySql (unicode rewrite, whitelist, inline) + golden complete`（未 push）

## 产物

- 新增 `packages/ontology/src/ontology-sql.ts`：
  - `rewriteObjectNames(sql, nameToTable)`：Unicode 属性类边界正则 `(?<![\p{L}\p{N}_.])<Name>(?![\p{L}\p{N}_])`（`gu`），长名优先（按名字长度降序逐个替换），返回重写后 SQL + 实际引用的对象名列表。
  - `executeOntologySql(conn, bindings, sql, params?)`：实体名→物理表重写 → `referenced.length === 0` 抛 `SQL 未引用任何本体对象（白名单拒绝执行）` → `inlineParams` 命名参数内联 → prepare 执行，返回 `{ columns, rows, rowCount }`（数组形态）。
- 修改 `packages/ontology/src/index.ts`：追加 `export * from "./ontology-sql.js"`。
- 新增测试 `packages/ontology/src/ontology-sql.test.ts`（11 条：rewriteObjectNames 2 + 白名单拒绝 1 + golden 8）。

## Golden 通过数（对 brief 的显式勘误：slice(13) → slice(12)）

命名区间 **agg_baseline_moments 至 order_asc_limit：8/8 通过**，golden 收口 **20/20**。

brief 称"golden cases 14-20 即 `cases.slice(13)` 的后 7 个"且首名列为 `agg_baseline_moments`——三者互相矛盾：golden.json 第 13 位（index 12）就是 `agg_baseline_moments`（count/sum 基线聚合，`v_wafer_agg` + 1 参数），`slice(13)` 会漏掉它，golden 永远停在 19/20，与 plan 文档 Task 5 的用例区间（"golden cases `agg_baseline_moments`…`order_asc_limit`"）和 commit 口径（"golden 20/20"）直接冲突。故按 plan 文档取 `slice(12)` 覆盖剩余全部 8 例（13-20：agg_baseline_moments / agg_chamber_comp / agg_fdc_group / agg_fdc_corr / traverse_anom_to_events / traverse_with_source_filter / combo_range_and_eq / order_asc_limit），与 Task 4 报告"golden 第 13-16 位 agg_*、17-20 位 traverse/combo/order 后续任务"的划分一致。白名单拒绝断言用 `/白名单/`（plan 文档要求 `/白名单|whitelist/i`）。

## 实测发现的实现级问题（3 处，均已修正并注释固化）

1. **node:sqlite 行形态是对象不是数组**：`StatementSync.all()` 默认返回 `Record<string, unknown>`（同名列折叠），plan 代码 `(stmt.all() as unknown[][]).map(r => [...r])` 会直接抛 TypeError（对象不可迭代）。已改为按 `stmt.columns()` 列序还原数组：`rows = raw.map(r => columns.map(c => r[c]))`，保证 `columns`/`rows` 位置对齐契约。实测：Node v22.22.1。
2. **未绑定 `?` 静默出错不抛异常**：golden SQL 用位置 `?`（Python 参考实现直查视图），而 inlineParams 只认 named-form `:pN`；node:sqlite 对未绑定 `?` **不报错**，按 NULL 比较静默返回空集（实测确认）。若 fixture 不转换，traverse_with_source_filter / agg_baseline_moments / combo_range_and_eq 会得到 0 行的"绿 路"假象都做不到——直接行数不符。测试装置按出现顺序 `?` → `:p0..:pN`，与 `g.params` 顺序一一对应。
3. **golden.json 路径**：brief 模板写 `./golden/golden.json`（`src/golden/` 不存在），实际在 `packages/ontology/test/golden/golden.json`，按既有 golden.test.ts 改为 `../test/golden/golden.json`。

其余按 brief 执行：bindings 只保留实体名映射（brief 自标的笔误行已删，与 plan 文档实现一致）；补了 plan 代码片段缺失的 `import type { DatabaseSync }`。

## 测试装置说明（如实记录）

- BINDINGS 为 8 个实体（WaferFact/ToolEvent/RcaChamberComp/RcaFdcGroup/RcaFdcCorr/AnomLot/AnomWafer/RcaDaily）→ 8 个物理视图，`fieldMap` 由 `colMapFor` 运行时探针生成（全部列同名恒等映射，剔除 `id`），与 Task 6 迁移后的 ont_bindings 形态同构。
- golden SQL 的"反向映射"（物理表名→对象名，长名优先）与 `?`→`:pN` 均为**测试装置**，被测实现只消费对象名 SQL。
- `v_wafer_agg` 物理视图无 `id` 列（实查），`Binding.idColumn: "id"` 仅作 fixture 占位——executeOntologySql 不消费 idColumn，无影响。
- 测试沿用 golden.test.ts 惯例：`describe.skipIf(!HAS_DB)` 守卫 + conn/BINDINGS 置于 describe 体（避免无 DB 机器上模块加载即崩）。

## 疑虑 / 遗留

- **同名列折叠**：node:sqlite 对象形态下 `SELECT a.id, t.id` 这类同名列结果会折叠成单键。golden 13-20 无此形态，但 executeOntologySql 的 `{columns, rows}` 数组契约对"重名结果列"表达不了——对象名 SQL 的作者应显式 AS 别名。建议在 Skill 运行时文档中注明。
- **正则注入面**：`rewriteObjectNames` 把实体名/表名直接嵌入正则源；当前 8 个绑定名（英文+下划线、中文）均无元字符，但未来绑定名若含 `(` `*` 等会崩。属 Task 6/迁移侧约束，建议在绑定校验（ont_bindings 迁移）时限制名字符集。
- **替换范围**：对象名替换是全文本无差别（含字符串字面量内的出现也会被替换）；白名单是"名字引用"级而非"表位置"级。当前语义可接受（对象名是保留字性质），记录备查。
- brief 期望"ontology-sql 10 条、总 45"为旧账（Task 4 后基线已是 47）；实际 ontology-sql 11 条、总数 58，已按实际汇报。
