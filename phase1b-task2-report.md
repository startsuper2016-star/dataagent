# Phase 1-B Task 2 报告 — bindings.ts fieldMap 规范化下沉

**Commit**: `7ba61fa` `phase1b: normalize binding fieldMap (array format from migration)`（已 push origin main）

## 做了什么

### 1. `packages/ontology/src/bindings.ts`（源码下沉，T8 升级事项落地）

- **新增 `normalizeFieldMap(raw: unknown, attributes?: AttributeRef[]): Record<string, string>`**（单独导出可测），统一两种 field_mappings_json 形态：
  - **Record 形态**（属性名→物理列，手工契约）：原样直通（同一引用，不复制）；
  - **数组形态**（元枢原样拷贝 `[{attribute_id, source_column, transform?}]`）：经 `attributes`（`[{id,name}]`）把 attribute_id 还原为属性名，**键序 = 元枢映射序**；
  - **数组形态 + attributes 缺省（undefined）→ 抛错**（"显式失败优于静默坏 SQL"，T8 验收结论）；
  - **attribute_id 在 attributes 中找不到 → 抛错**；
  - 空数组 → 空 Record（objectQuery 的既有空 fieldMap 守卫会在查询时响亮失败）；
  - 附带守卫：条目非对象 / 缺 `attribute_id|source_column` 字符串字段 / raw 既非对象也非数组，均抛带原文的明确错误；
  - `transform` 字段本层不消费（文档注释说明理由：列对齐验收已证属性名==物理列）。
- **`resolveBinding` 签名扩展**：`resolveBinding(db, entityId, attributes?: AttributeRef[])`。
  - 调用方显式传 `attributes` 时**原样透传**给 normalizeFieldMap；
  - 不传时默认来源是本库 `SELECT id, name FROM ont_attributes WHERE entity_id = ?`（db 句柄在手，调用方无需重复查）；
  - **实现细节（有意为之）**：默认查询仅在解析结果确为数组形态时才执行——Record 形态直通不依赖 ont_attributes 行存在性，避免对旧手工契约数据引入无谓查询/脆弱依赖（既有 `query.test.ts` 的 `'{}'` fixture 因此零改动通过）。
- 新增导出 `AttributeRef = { id: string; name: string }`；**既有 `Binding` 类型不变**。`index.ts` 的 `export * from "./bindings.js"` 自动带出，dist 构建产物已含新签名（`dist/bindings.d.ts` 验证）。

### 2. `packages/ontology/src/bindings.test.ts`（新建，10 用例）

验收清单 5 用例全齐：数组形态映射（含键序断言）/ Record 直通（`toBe` 同引用）/ 数组无 attrs 抛错 / 未知 attribute_id 抛错（错误信息含该 id）/ 空数组→空 Record。另加 5 个加固用例：非对象非数组抛错，以及 resolveBinding 集成四态（默认查 ont_attributes 还原、显式 attributes 透传、Record 直通不受 ont_attributes 缺行影响、数组形态但缺行时显式抛错）。

### 3. `packages/ontology/src/acceptance.test.ts`（删除装置内临时还原逻辑）

- **删除**：`YuanShuMapping` 类型、全局 `attrNameById` 还原 Map、beforeAll 内逐条 `attribute_id→属性名` 还原循环、**同名不变量断言**（`属性名 !== source_column` 即抛）——即 T8 报告"列对齐方式"/"fieldMap 规范化"节所述的全部装置内适配。
- **改用规范化后的 `resolveBinding(wb, id)` 直出**填 BIND；文件头注释同步改写（规范化已下沉源码、装置不再感知数组形态内部结构、回归由 golden 端到端深比较响亮暴露）。
- **保留**的迁移数据守卫（与还原逻辑无关）：approved===14、可解析实体===14、datasourceId===SPC_MVP_SQLITE、fieldMap 非空。

## 验证矩阵

| 验收项 | 结果 |
|---|---|
| ① 新增单测（bindings.test.ts） | **10/10 绿**（含要求的 5 用例） |
| ② acceptance（规范化 resolveBinding 直出 × 真实迁移数据） | **22/22 绿**（端到端 golden 深比较不变——本任务核心验收） |
| ③ 全量 `npx vitest run packages/ontology` | **101/101 绿**（91 基线 + 10 新增，无回归） |
| ④ `npm run build`（tsc -b，dist 接线） | 通过，`dist/bindings.d.ts` 含 `normalizeFieldMap`/`AttributeRef`/新 resolveBinding 签名 |
| ⑤ Commit + push | `7ba61fa` → origin main |
| 附加：skipIf 路径（env 指向不存在 workbench） | 22 skipped，干净跳过（CI 安全，与 T8 矩阵一致） |

## 关键决策记录

1. **ont_attributes 默认查询按实体 scope（`WHERE entity_id = ?`）**：动手前用只读脚本核验过真实 workbench——14 实体 97 条映射**全部**能在各自 entity 的 ont_attributes 行内解析、name 全等 source_column、无同名冲突，per-entity 查询与全局查询等价且更收敛（一个实体映射错挂到别实体时显式失败而非侥幸通过）。
2. **默认查询惰性化（仅数组形态触发）**：见上，保 Record 直通对 ont_attributes 存在性零依赖，既有 fixture 零改动。
3. **同名不变量（属性名==物理列）随还原逻辑一并删除、未搬进源码**：按任务书要求"删除装置内还原+同名不变量断言"。该不变量本是列名对齐的前提断言；删除后由 golden 端到端深比较兜底——若属性名≠物理列，objectQuery 投影别名改变，golden 的按列名对齐会立即找不到期望列而响亮失败，不会静默。
4. **normalizeFieldMap 对畸形输入全部显式抛错**而非容错跳过：与 T8"显式失败优于静默坏 SQL"口径一致。

## 疑虑 / 遗留

1. **同名不变量不再是前置守卫**：迁移数据若未来出现"属性名≠物理列"，失败点从 beforeAll 前移到 golden 用例本身（报错信息稍间接）。如需恢复前置守卫，可在迁移侧断言或后续在 normalizeFieldMap 加可选校验，本任务按任务书未做。
2. `resolveBinding` 仍只取 approved 绑定、`JSON.parse` 无 try/catch（畸形 JSON 直接抛 SyntaxError）——行为与 Task 4 一致，未在本任务范围。
3. T8 报告遗留的"`ont_attributes.sort` 迁移写死 0"仍在（列序语义缺失），与本任务无关，键序沿用元枢映射序。
