# Phase 3 Task 4 报告 — 本体设计器 UI（实体/关系建模 CRUD，Phase 3 收官项）

- **状态**: 完成
- **Commit**: `8a7ed66` — `phase3: ontology designer UI — entity/relation modeling CRUD`（已 push origin main）
- **测试**: `npx vitest run src/routes/ontology.test.ts`（apps/api）→ **31 passed**（新增 6：实体创建/重名/非法名、属性同步 id 保持+引用删除守卫、draft 删除级联+版本守卫、设计器实体→绑定→审批→查询闭环、关系校验+集合 405）；`tsc --noEmit`（apps/api）零错误；apps/web typecheck 与 clean HEAD 逐位一致（46 个报错全部为 `data-tasks/__tests__` 既有，无 ontology 相关）

## 1. 背景与范围判定

Phase 3 范围（phase2-task5 报告）= SemanticProvider 挂载 / **设计器 UI** / 晋升流。前三个提交（`3382df0`/`61b9361`/`275b6c4`）覆盖了挂载、晋升流与参数绑定加固，"设计器 UI"是唯一没有落地的范围项。

摸底结论：治理写面已有绑定编辑（PUT /bindings）、审批门、版本发布、DataLink 晋升，但**实体与关系的建模 CRUD 完全缺失**——实体只能来自迁移脚本或 promote，`requireBindingId` 的 404 文案甚至写着"先在本体建模侧创建"，而建模侧并不存在。故本任务范围定为：本体建模侧（实体 + 属性 + 关系）的 API 与 UI。

## 2. API（apps/api/src/routes/ontology.ts）

| 端点 | 语义 |
| --- | --- |
| `POST /entities` | 建 draft 实体（tier=2）+ 属性（sort=入参序）；重名 409；实体名/属性名过 `isSafeIdentifier` 白名单 |
| `PUT /entities/:name` | 编辑 nameCn/description + **属性按名同步**；实体名不可改（400） |
| `DELETE /entities/:name` | 仅 draft 且未被版本登记（`ont_version_entities`）可删；draft 绑定与两端关系级联删；非 draft 409 |
| `POST /relations` | 建关系边：两端实体存在（400）、cardinality 枚举 1:1/1:N/N:1/N:N、source/target_field 白名单、(from,to,name) 去重 409 |
| `DELETE /relations/:id` | 未知 id 404 |
| `GET /context`（改动） | relations 增加 `id` 字段（设计器删除按钮需要；加法改动，MCP 侧消费不受影响） |

三个安全设计点（对应既有攻击面）：

1. **实体名白名单**：`rewriteObjectNames` 把实体名**未转义内插**进正则（`(?<![\p{L}\p{N}_.])${name}...`），属性名/关系字段以双引号拼进 SQL——名字里的正则元字符或引号会在运行期炸正则或逃逸引号。创建/编辑门口统一 `isSafeIdentifier`（字母/数字/下划线/中文）拒绝。
2. **属性同步保 id**：绑定映射（`field_mappings_json` 数组形态）按 `attribute_id` 引用属性。PUT 按 name 对齐——已有属性保 id 只更新 display/type/required/sort，绑定不断链；删除被引用属性返回 400（引用检测同时覆盖数组形态按 id 与 **Record 形态按属性名** 两种历史数据，如 seed 的 `bind-tool`）。改名语义=删+增，会被同一守卫拦下。
3. **删除保守**：仅 draft 实体可删，且被任何版本登记过即 409（版本快照是 JSON 拷贝不受影响，但登记行会悬空）。

**闭环补洞**：设计器新建的实体没有绑定行，而 `PUT /bindings/:entity` 原本 `requireBindingId` 直接 404——建模→绑定→审批→发布的流程断在第二步。现改为：绑定行缺失时自动创建（datasource 解析 `SPC_MVP_SQLITE`，与 promote 同口径），表/列校验前置不变；`requireBindingId` 保留给 approve 门（无绑定审批仍 404）。

## 3. UI（apps/web/src/app/ontology/designer/page.tsx，新增 523 行）

- **实体区**：全量清单（名称/中文名/实体状态/属性列表/绑定状态）；新建/编辑共用表单（编辑时 name 与描述锁定），属性行编辑器（name/显示名/type 下拉含存量类型回显/必填/移除，"+ 添加属性"）；删除仅 draft 行展示（confirm 后调 DELETE）。
- **关系区**：清单（含删除按钮）；新建表单（起点/终点下拉、名称、基数、源/目标字段，附"物理列名"提示文案）。
- 治理页头部新增"设计器"入口；设计器头部"返回治理"。
- 保存成功文案带下一步指引（新建实体 → "到绑定编辑器关联物理表"），与 promote 的 next hint 同风格。

## 4. 测试证据（31/31）

新增 6 用例（`P3-4 designer` 两个 describe）：

| 用例 | 断言要点 |
| --- | --- |
| 实体创建 | draft 状态、属性序/required 落库；重名 409 CONFLICT；`Bad(Name` 400；缺 name 400 |
| PUT 属性同步 | 存活属性 **id 不变**（对照同步前 id）；display/type/required/sort 更新；删被引用属性 400（文案含 `wafer_id`）；改名 400；未知实体 400；`attributes` 非数组 400 |
| draft 删除 | 版本登记中的 draft 409；干净 draft 200 且从清单消失、**关系级联**（删除后的 relation id 404）；published 409；未知 400 |
| 建模闭环 | 建实体→查询 404（无绑定）→绑定编辑器首次保存自动建行（draft）→审批过（覆盖率 1/1）→查询 200（w-001/w-002） |
| 关系校验 | 创建 200 + /context 可见；重复 409；终点不存在 400；`a b` 字段 400；基数越界 400；删除 200 后再删 404 |
| 方法守卫 | PATCH /entities 405（原"POST /entities 405"断言随新行为改写）；GET /relations 405 |

既有失败（与本任务无关，clean HEAD 复现确认）：apps/api `session-intent`/`session-branching-intent` 13 个；packages `session-output-ingest`/`session-output-service`/`knowledge-document-lifecycle`/`session-intent-repository` 17 个（stash 后 clean HEAD 同样 17 failed，`3382df0` 提交说明亦记录过前者）。

## 5. 疑虑 / 备注

1. **PUT 不支持清空 nameCn/description**：与既有 `stringValue` 语义一致（空串=不更新），MVP 接受。
2. **编辑表单锁定 description**（仅新建可填）： ont_entities.description 无独立更新通道，避免为低频字段扩语义；需要时放开是一行事。
3. **`entityDetailById` 为 O(全实体) 扫描**：POST/PUT 返回详情走 `listEntityDetails` 过滤。本体规模（几十实体）下无感，实体数上量后可换按 id 直查。
4. **设计器建实体不自动建绑定**：与 promote 的"晋升落 draft、人工审批"哲学一致，UI 文案显式引导到绑定编辑器。
5. **报告文件入库惯例漂移**：phase0-task1/2 报告已入库，其后 23 份报告均未跟踪。本报告沿用近期惯例保持未跟踪；是否批量补交属仓库卫生决策（本任务未动）。

## 6. 变更清单（本 commit）

| 文件 | 变更 |
| --- | --- |
| `apps/api/src/routes/ontology.ts` | 实体/关系 CRUD 端点组、属性同步与引用守卫、绑定缺失自动建行、/context relations 带 id、requireMethod 扩 DELETE |
| `apps/api/src/routes/ontology.test.ts` | +6 用例（P3-4 designer ×2 describe）、entities 405 断言改写、delJson/patchJson 辅助 |
| `apps/web/src/app/ontology/designer/page.tsx` | 新增：设计器页（实体表单/属性行编辑器/关系表单/删除流） |
| `apps/web/src/app/ontology/page.tsx` | 头部加"设计器"入口 |
