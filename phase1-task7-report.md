# Phase 1 · Task 7 报告 — migrate-yuanshu.ts（ontology.db → workbench.sqlite ont_*）

状态：**完成** | commit：`3925c52`（已 push origin/main，ee55f99..3925c52） | 校验断言：**10/10 全过，exit 0**

## 交付物

| 文件 | 说明 |
|---|---|
| `scripts/migrate-yuanshu.ts` | 元枢权威库 → workbench ont_* 一次性迁移脚本（tsx 运行，复用 `packages/ontology` 的 `ensureOntologyTables` 建表） |

运行方式：
```
npx tsx scripts/migrate-yuanshu.ts --yuanshu <ontology.db 绝对路径> --workbench <workbench.sqlite 绝对路径>
```

## 硬性前置落实（单写者纪律）

- 脚本开头对 `127.0.0.1:8787` 做 TCP 探测（800ms 超时），监听中则打印 `[BLOCK]` + 停止命令（`netstat -ano | findstr :8787` → `taskkill //F //PID <pid>`）并 exit 1。
- **实测**：apps/api 在跑时（PID 12280）运行脚本 → 正确 `[BLOCK]` exit 1；`taskkill //F //PID 12280` 后重跑 → 正常迁移。web(3000) 未动。

## 侦查实录与规格适配（脚本头部注释已固化）

只读侦查（PRAGMA + SELECT）发现以下与本任务 brief 规格不符处，均已适配并在脚本注释中说明：

1. **workbench 侧数据源表实名是 `data_sources`（非 datasources）**。列结构：`id, user_id, name, type, config_json, credential_ref, description, status, last_test_at, revision, created_at, updated_at`（复合主键 user_id+id）。按实际结构插入（revision=1，created/updated=now，credential_ref/last_test_at=NULL）。
2. **"14 个 SPC 对象"的实际落点**：`ontology_id='cf68712c-…'` 下共 41 实体（17 个 tier-2 + 24 个 tier-3 MES 主数据；tier-2 中 M2mCorr/ScanRecord/WindowConfig 三者 status='active'）。**14 = tier=2 且 status='published'**——与 T3–T6 golden 用例的实体集合完全吻合（AnomWafer/AnomalyEvent/RcaAnomLot/RcaBaseline/RcaChamberComp/RcaChamberRate/RcaDaily/RcaFdcCorr/RcaFdcGroup/RcaWinStats/RootCauseCase/SpcCase/ToolEvent/WaferFact）。
3. **relations**：brief 点名 `anom_wafer_chamber_events`；落库取"两端均在 14 实体内"的全部关系（**15 条**，含点名关系；源 entity_relations 无 ontology_id 列，经实体限定归属）。断言 `relations>=1` 且点名关系必须存在（各 1 条）。
4. **functions 6 条** = `ontology_id=ONT AND entity_id IS NOT NULL`：spc_detect / rca_rank / rca_evidence / epdca_create_ticket / rca_writeback_conclusion / rca_traverse_probe。同本体另有 4 条（m2m_rank、fuse_conclusions、auto_scan、rca_writeback_case）entity_id 为 NULL、entity_ids='[]'（C 路批扫函数），不在 6 条之列。
5. **skills 无 entity_ids 列**——entity_ids 存于 `skill_versions.snapshot_json`（顶层键）。取 `current_version` 快照，选 entity_ids 全部落在 14 实体内的技能 → 恰 3 个：SPC异常根因分析(v4)/ePDCA异常开单(v4)/根因经验回写(v4)；订单查询与售后服务、dc SPC 判异分析 因指向其他本体实体被排除。
6. **entity_attributes 无 display_name 类列** → display_name 一律取 name（brief 的"若无则 name"分支）。
7. **object_bindings 自带 `id_column` 列**（brief 的"有则用之"分支），直接采用；`table_name` 取 `assets.locator` JSON 的 `$.table`（14 个 SPC_* asset 全部解析成功：v_wafer_agg、dim_tool_event、v_base_stats…）；`field_mappings`（attribute_id+source_column+transform 数组）原样存入 `field_mappings_json`；`filter_expr` 源值全 NULL（亦原样搬运）；`source_sql` 源表无此概念 → NULL；**status 强制 'approved'**（按 brief）。
8. **ontology_versions 无 config_snapshot_json 对应列** → 目标列置 NULL；`is_active/components_frozen` 等源列目标表没有，不搬运。
9. **ont_entities.config_json**：源 14 实体该列全非空（primary_key + backing_asset_ids），目标表有同名列，原样搬运（brief 未列出，属防御性保留，避免丢 primary_key 语义）。
10. **元枢库访问方式**：brief 写"只读 ATTACH"；node:sqlite 的 ATTACH 无法保证只读，改用**第二条 `DatabaseSync(yuanshu, {readOnly:true})` 只读连接**（意图等价且更严格）。
11. **ont_version_entities 180 行全量搬运**（8 个版本，WHERE version_id IN 该本体的全部版本行）：v1/v2 各 24 行、v3–v6 各 14 行、v7/v8 各 38 行；其中引用 tier-3 实体的行（版本快照历史）其 source_entity_id 不在迁移的 14 实体内——目标表无外键，且这是版本历史记录，按 brief 的"WHERE version_id IN"口径原样保留。

## 迁移结果（ ont_* 全表 INSERT OR REPLACE，保留元枢原 id）

| 目标表 | 行数 | 源口径 |
|---|---|---|
| ont_ontologies | 1 | id=cf68712c-e3fc-427d-ab80-8530261a6bc0, name/code=semi-mfg-base |
| ont_entities | 14 | ONT + tier=2 + published |
| ont_attributes | 97 | 上述 14 实体的全部属性（与源同口径计数一致） |
| ont_relations | 15 | 两端均在 14 实体内（含 anom_wafer_chamber_events） |
| ont_functions | 6 | ONT 且 entity_id 非空，runtime='ontology-logic' |
| ont_bindings | 14 | 14 实体 × SPC_* 资产 × role=primary × status=active，datasource_id→SPC_MVP_SQLITE，status='approved' |
| ont_skill_bindings | 3 | 快照 entity_ids ⊆ 14 实体的技能，id=skill_id，version=current_version |
| ont_versions | 8 | 该本体全部版本行（v1–v8，7 个 published + 1 个 pending_approval） |
| ont_version_entities | 180 | 上述版本的 version_entities 全量 |

## datasources 行处理结果

- 首跑：**新增** `data_sources` 行 `SPC_MVP_SQLITE`，id=`f45ef477-e85e-45db-bcf2-ec6ef38d7f15`，user_id=`6d7962f9-ea0e-4014-80e1-23ac703e16f3`（admin@fusion.local），type=sqlite，config_json=`{"path":"C:/Users/shuan/Downloads/ontology-master (3)/ontology-master/local-data/spc_mvp/spc_mvp.db"}`（路径已核实存在，21MB），status=ready，revision=1。
- 幂等复跑：**复用同一 id，不重复插入**；各表行数不变（INSERT OR REPLACE 语义）。已实测二次运行全断言通过。

## 校验断言（提交事务后读目标库，任一失败 exit 1）

```
PASS  ont_entities          = 14（期望 ==14）
PASS  ont_attributes        = 97（期望 ==97，与源同口径计数一致）
PASS  ont_relations         = 15（期望 >=1）
PASS  ont_functions         = 6（期望 ==6）
PASS  ont_bindings          = 14（期望 ==14）
PASS  ont_skill_bindings    = 3（期望 ==3）
PASS  ont_versions          = 8（期望 >=1）
PASS  ont_version_entities  = 180（期望 ==180，与源一致）
PASS  ont_relations 含 anom_wafer_chamber_events（1）
PASS  WaferFact 抽样：table(v_wafer_agg) id_column(wafer_id) field_mappings 9 项逐字段一致
```

抽样比对实现：源 `object_bindings.field_mappings`（经 `ontology_entities.name='WaferFact'` → asset 链路取出）与目标 `ont_bindings.field_mappings_json` 解析后 JSON 深比较，另核 `table_name`（locator $.table）与 `id_column`。

其余保障：所有写入在单事务内（BEGIN/COMMIT，异常 ROLLBACK exit 1）；动手前先 PRAGMA 自检两库表/列，缺列即报告并停（实测通过）。

## apps/api 重启确认

- 迁移完成后 `cd apps/api && npm run dev` 后台启动（tsx watch src/index.ts）。
- `GET http://127.0.0.1:8787/healthz` → **200** `{"success":true,"data":{"status":"ok"}}`（约 3s 就绪），监听 PID 44300。
- web(3000) 全程未动。

## Git

- commit `3925c52`（仅 `scripts/migrate-yuanshu.ts`，431 行；不含任何 .db/.sqlite 文件），已 push origin/main。

## 疑虑 / 遗留

1. **brief 计数与实库的三处偏差**（均已在"侦查实录"中适配）：14 实体的判据实为 tier=2+published；relations 落库 15 条（brief 只点名 1 条）；functions 的 6 条排除了同本体 4 条无实体锚定的 C 路函数。若后续任务期望不同的圈定口径（如纳入 m2m_rank 等无锚定函数），脚本内为单条 WHERE，改一行即可重跑（幂等）。
2. **ont_version_entities 的悬挂引用**：v1/v2/v7/v8 的部分行 source_entity_id 指向未迁移的 tier-3 实体（版本历史快照，目标表无外键）。如后续需要强一致，可加 `AND source_entity_id IN (14 实体)` 过滤（会破坏"全量 WHERE version_id IN"口径，未采用）。
3. **ont_skill_bindings.id=skill_id**（brief 指定）：主键与 skill_id 同值，天然防重复绑定；如未来一个技能需多版本绑定行，需换主键方案。
4. 迁移脚本是**一次性工具**，不进 build graph（仓库 tsconfig.build 未含 scripts/，与既有 smoke-*.mjs 同待遇）；重复运行安全（幂等），但不做增量/删陈旧行语义（ont_* 目前无其他写入方）。

## 汇报摘要（供 coordinator）

状态：完成 | commit：`3925c52`（已 push） | 迁移行数：ontologies 1 / entities 14 / attributes 97 / relations 15 / functions 6 / bindings 14 / skill_bindings 3 / versions 8 / version_entities 180 | datasources：新增 SPC_MVP_SQLITE（f45ef477-…，幂等复用） | 断言 10/10 过 + 幂等复跑过 | apps/api 重启 healthz 200（PID 44300） | 疑虑：14 实体判据=tier2+published（与 golden 集合吻合）；relations 迁 15 条（brief 点名 1 条为子集）；C 路 4 函数无实体锚定未迁；version_entities 含 tier-3 历史悬挂引用（无外键，按全量口径保留）。
