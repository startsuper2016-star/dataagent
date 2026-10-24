# Phase 1 Task 8 报告 — acceptance：迁移后端到端 golden 复跑（20/20 + traverse 2）

## 状态

完成。`packages/ontology/src/acceptance.test.ts` 全部通过：**22/22**（golden 20/20 + traverse 2 条），ontology 包全量 **91/91**（schema 3 + dsl 17 + inline-params 10 + query 5 + golden 12 + traverse-golden 2 + traverse 9 + acceptance 22 + dsl/rewrite 若干，合计 8 文件 91 测）。`workbench.sqlite` 与 `spc_mvp.db` 全程只读（readOnly 连接，测试前后 mtime/size 未变）。

## Commit

- `6541c34` — `phase1: acceptance — workbench 真实绑定 × golden 端到端复跑 (20/20 + traverse 2)`（已 push 至 main）

## 验收契约逐条闭环

1. **绑定从 workbench 真实解析**：`ont_entities` 读 name→id（14 个 semi-mfg-base 对象），按实体名以 Task 4 `resolveBinding(entity_id=元枢原 id)` 解析；beforeAll 断言 `ont_bindings status='approved'` 恰为 14、全部绑定 datasource 指向 SPC_MVP_SQLITE，任一不满足即显式失败。
2. **数据连接来自 data_sources**：`SELECT config_json FROM data_sources WHERE name='SPC_MVP_SQLITE'` → `path` 打开 spc_mvp.db（readOnly）。SPC 路径不做硬编码默认（它本身就是被验收的迁移产物）；env `ONTOLOGY_ACCEPTANCE_SPC` 仅作本机逃生口。
3. **golden 20/20**：
   - cases 0-11（eq_chamber…total_count_matches_pages）：真实绑定的 `objectQuery(conn, binding, filters, limit, offset)`，用例表述沿用 Task 4（idColumn="id" 排序等价、eq_chamber 241 行按 200/页翻页拼接、total_count 以 page1+page2 之和断言 243），行值按列名对齐后与 expectedRows 深比较。
   - cases 12-19（agg_baseline_moments…order_asc_limit）：`executeOntologySql(conn, realBindings, <对象名SQL>, params)`，对象名 SQL 沿用 Task 5 的 reverse-mapping 装置（真实绑定的 table→实体名 反查改写、长名优先；`?`→`:pN`）；SQL 输出列来自 SQL 别名本身，按位深比较。
   - traverse 两用例：Task 6 `traverse(conn, realBindings, realRelations, "AnomWafer", filters, "ToolEvent", 200)`，关系从 `ont_relations` 读出（`source_field/target_field` 完整的关系恰好只有 `anom_wafer_chamber_events`：AnomWafer.chamber_id→ToolEvent.chamber_id），UUID→实体名换 key 后传入；行集按列名对齐 golden 列投影（5 列/2 列）切片比较。
4. **路径守卫**：`ONTOLOGY_ACCEPTANCE_WORKBENCH` / `ONTOLOGY_ACCEPTANCE_SPC` 环境变量覆盖 + `describe.skipIf`；workbench 文件缺失 → 22 例整体 skip（已实测 skip 路径干净）；**workbench 存在但 SPC 行/库文件不可用 → 专用用例显式失败**（迁移数据问题不静默跳过）。`.env`/密钥：不涉及，未入库。

## 关键发现与处理（重要，均为测试装置适配，非迁移数据错误）

1. **`field_mappings_json` 是元枢原样数组形态，不是 Task 4 fixture 的 Record**。迁移契约（Task 7）为"原样拷贝"元枢 `object_bindings.field_mappings`：`[{attribute_id, source_column, transform}]`。Task 4 `resolveBinding` 内部 `JSON.parse(...) as Record<string,string>` 只是类型断言——对真实迁移行返回的是**数组**（`Object.keys` 得到下标），其 fieldMap 不能被 objectQuery/traverse 直接消费。本验收的装置适配：以 `ont_attributes`（id→name）还原属性名构造 `属性名→物理列` fieldMap，并**对全部 14 绑定共 97 条映射逐条断言 `属性名 == source_column` 同名不变量**——该不变量同时是下面列名对齐的前提，违反即迁移回归、响亮失败。
2. **列对齐方式（契约要求如实记录）**：选用**按列名对齐**——objectQuery/traverse 按契约返回 fieldMap 全列（键序=元枢映射序，与 golden expectedColumns 顺序不同且为超集），比较时对每条 golden 期望列在返回列中 `indexOf` 取值、重排为 golden 列序后 `toEqual`；不依赖列位置。备选方案（用 `ont_attributes.sort` 重排 fieldMap）不可行：迁移将 sort 一律写 0（`migrate-yuanshu.ts` 第 271 行硬编码），无列序信息。
3. **executeOntologySql 8 例不涉及列对齐**：输出列名来自 golden SQL 自身别名，fieldMap 不参与该通道（仅消费 `binding.table`）。
4. traverse 传入**全部**真实关系（15 条中字段完整的才可走，traverse 对 `source_field/target_field` 为空的边自动跳过）——同时验证了 BFS 对真实关系表的过滤行为。

## 验证矩阵

| 项 | 结果 |
|---|---|
| acceptance 单文件 | 22/22 通过 |
| ontology 包全量（无回归） | 91/91 通过 |
| skipIf 路径（env 指向不存在 workbench） | 22 skipped，干净跳过 |
| workbench/spc 文件只读纪律 | mtime/size 前后一致 |
| acceptance.test.ts 独立 tsc（strict 全开） | 本文件 0 错误（bindings.ts/ontology-sql.ts 存在与本任务无关的既有 strict 噪音，见疑虑 3） |
| 仓库级 `tsc -b tsconfig.build.json` | 不受影响（ontology 包不在 build graph，与既有各任务一致） |

## 疑虑 / 遗留（建议后续任务处理，本任务仅允许提交 acceptance.test.ts）

1. **`resolveBinding` 对迁移数据形态不适配**：其 `fieldMap` 直通 `JSON.parse`，对元枢原样数组返回的是数组而非 `Record<属性名,列>`。任何上层直接拿 Task 4 `resolveBinding` 的 fieldMap 喂 objectQuery/traverse 都会得到坏 SQL。建议 Task 9+ 把"ont_attributes 还原 + 同名不变量断言"下沉进 `bindings.ts`（或服务层组装 Binding 的位置），验收文件中已留下完整注释指路。
2. **`ont_attributes.sort` 迁移时写死 0**：列序语义缺失。若后续有"按模型声明列序返回"的需求，需在迁移侧补真实 sort 值。
3. ontology 包从未纳入 build graph，`bindings.ts`（exactOptionalPropertyTypes 下 `sourceSql: undefined` 赋值）与 `ontology-sql.ts`（stmt.columns() 重载）存在既有 strict 噪音，独立 tsc 可复现；不影响运行时，留待包级 typecheck 任务统一清理。
