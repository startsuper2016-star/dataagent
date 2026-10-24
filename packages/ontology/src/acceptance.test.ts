import { DatabaseSync } from "node:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveBinding } from "./bindings.js";
import type { Binding } from "./bindings.js";
import type { Filters } from "./dsl.js";
import { executeOntologySql } from "./ontology-sql.js";
import { objectQuery } from "./query.js";
import { traverse } from "./traverse.js";
import type { RelationEdge } from "./traverse.js";

/**
 * Phase 1 Task 8 — 迁移后端到端 golden 复跑（slice 验收）。
 *
 * 与既有 golden 测试（query/ontology-sql/traverse.test.ts 用硬编码 fixture 绑定）的关键差异：
 * 本验收的全部绑定、数据源路径、关系均来自 **真实迁移数据**（workbench.sqlite）：
 *   ① ont_entities 读 name→id，按实体名以 Task 4 resolveBinding(entity_id=元枢原 id) 解析绑定；
 *   ② data_sources 的 SPC_MVP_SQLITE 行 config_json.path 打开 spc_mvp.db 作为数据连接；
 *   ③ ont_relations 读真实关系（本库 source_field/target_field 完整的即 anom_wafer_chamber_events：
 *      AnomWafer.chamber_id → ToolEvent.chamber_id），UUID→实体名换 key 后传 traverse。
 *
 * 列对齐方式（如实记录）：objectQuery/traverse 按契约投影 fieldMap 全列（键序=元枢映射序），
 * golden expectedColumns 是其子集且顺序可能不同 —— 本验收**按列名对齐**：对每条 golden 期望列
 * 在返回列中 indexOf 取值、重排为 golden 列序后再与 expectedRows 深比较，不依赖列位置。
 *
 * fieldMap 规范化（phase1b Task 2 已下沉源码）：迁移契约是 field_mappings_json **原样拷贝**元枢
 * object_bindings（数组形态 [{attribute_id, source_column, transform}]），与手工契约的 Record 形态
 * 不同；resolveBinding 内部经 ont_attributes（WHERE entity_id）把 attribute_id 还原为属性名并统一
 * 输出 Record<属性名, 物理列>。本验收因此**直出** resolveBinding 结果，不再装置内还原
 * （T8 期间的临时还原+同名不变量断言已删除）——规范化若有回归，golden 端到端深比较会响亮失败。
 */

const GOLDEN = JSON.parse(readFileSync(new URL("../test/golden/golden.json", import.meta.url), "utf-8")) as {
  cases: { name: string; sql: string; params: unknown[]; expectedColumns: string[]; expectedRows: unknown[][] }[];
};

// 路径：默认写死绝对路径，可环境变量覆盖（spc 路径正常来源是 data_sources 行，env 仅作本机逃生口）
const WORKBENCH = process.env.ONTOLOGY_ACCEPTANCE_WORKBENCH
  ?? "C:/Users/shuan/Documents/GitHub/datafoundry/apps/api/storage/metadata/workbench.sqlite";
const HAS_WORKBENCH = existsSync(WORKBENCH);

// 模块加载期只读探针：解析 SPC 路径（供 skipIf 守卫）；workbench 在而前置不满足时记为
// probeError，下方专用用例显式失败 —— 迁移数据问题不得因 skipIf 静默跳过。
let spcPathFromDs: string | undefined;
let probeError: string | undefined;
if (HAS_WORKBENCH) {
  try {
    const probe = new DatabaseSync(WORKBENCH, { readOnly: true });
    try {
      const row = probe
        .prepare("SELECT config_json FROM data_sources WHERE name = 'SPC_MVP_SQLITE'")
        .get() as { config_json: string } | undefined;
      const path = row ? (JSON.parse(row.config_json) as { path?: unknown }).path : undefined;
      if (typeof path !== "string" || path.length === 0) {
        probeError = "data_sources.SPC_MVP_SQLITE 的 config_json.path 缺失或非字符串（迁移数据问题）";
      } else {
        spcPathFromDs = path;
        if (!existsSync(path)) probeError = `data_sources.SPC_MVP_SQLITE 指向的库不存在: ${path}（迁移数据问题）`;
      }
    } finally {
      probe.close();
    }
  } catch (err) {
    probeError = `workbench.sqlite 打开/解析失败: ${String(err)}`;
  }
}
const SPC_PATH = process.env.ONTOLOGY_ACCEPTANCE_SPC ?? spcPathFromDs;
const READY = HAS_WORKBENCH && SPC_PATH !== undefined && existsSync(SPC_PATH);

if (HAS_WORKBENCH && !READY) {
  it("验收前置解析失败（迁移数据问题，显式失败而非静默跳过）", () => {
    throw new Error(probeError ?? "SPC 数据源不可用");
  });
}

// 元枢 field_mappings 的数组形态已由 bindings.ts 的 normalizeFieldMap 规范化，本文件不再感知其内部结构。

/**
 * 列名对齐：把 resultColumns/resultRows（fieldMap 全列，元枢序）重排为 wanted（golden 列序）。
 * wanted 必须是 resultColumns 子集，缺失即抛错（映射不全的迁移回归要响亮暴露）。
 */
function projectByColumns(resultColumns: string[], rows: unknown[][], wanted: string[]): unknown[][] {
  const idx = wanted.map(w => {
    const i = resultColumns.indexOf(w);
    if (i < 0) throw new Error(`返回列 ${resultColumns.join(",")} 中找不到期望列 ${w}`);
    return i;
  });
  return rows.map(row => idx.map(i => row[i] ?? null));
}

describe.skipIf(!READY)("acceptance — workbench 真实绑定 × golden 复跑（20/20 + traverse 2）", () => {
  let wb: DatabaseSync;
  let spc: DatabaseSync;
  let dsId = "";
  // 实体名 → 规范化绑定（fieldMap 已还原为 属性名→物理列，键序=元枢映射序）
  const BIND: Record<string, Binding> = {};
  // ont_relations 中字段完整的真实关系（UUID→实体名换 key；本库即 anom_wafer_chamber_events）
  let REL: RelationEdge[] = [];
  // 取绑定（beforeAll 保证 14 实体全部解析；缺失即迁移数据问题，显式失败）
  const mustBind = (entity: string): Binding => {
    const b = BIND[entity];
    if (!b) throw new Error(`实体 ${entity} 未从 workbench 解析出绑定（迁移数据问题）`);
    return b;
  };

  beforeAll(() => {
    wb = new DatabaseSync(WORKBENCH, { readOnly: true });
    spc = new DatabaseSync(SPC_PATH!, { readOnly: true });

    // ---- ② 数据连接：data_sources.SPC_MVP_SQLITE（契约 2 的闭环）----
    const ds = wb
      .prepare("SELECT id, config_json FROM data_sources WHERE name = 'SPC_MVP_SQLITE'")
      .get() as { id: string; config_json: string } | undefined;
    if (!ds) throw new Error("data_sources 缺 SPC_MVP_SQLITE 行（迁移数据问题）");
    dsId = ds.id;
    const dsPath = process.env.ONTOLOGY_ACCEPTANCE_SPC
      ?? (JSON.parse(ds.config_json) as { path?: unknown }).path;
    if (typeof dsPath !== "string" || !existsSync(dsPath)) {
      throw new Error(`SPC_MVP_SQLITE 路径不可用: ${String(dsPath)}`);
    }
    if (dsPath !== SPC_PATH) throw new Error("data_sources 路径与 skipIf 探针不一致");

    // ---- ① 绑定解析：ont_entities name→id → resolveBinding（契约 1 的闭环）----
    // 迁移断言口径（P3 起改为完整性自洽 + 迁移底线，不再硬编码恰数：
    // Phase 2 T4 补 WindowConfig 已使 14→15，硬编码恰数在合法增绑定时误报）：
    // - approved 绑定数 ≥ 14（迁移底线）；
    // - approved 绑定数 == 有 approved 绑定的实体数（无重复绑定，自洽）。
    const approved = (wb.prepare("SELECT COUNT(*) AS n FROM ont_bindings WHERE status = 'approved'").get() as { n: number }).n;
    if (approved < 14) throw new Error(`ont_bindings approved 低于迁移底线 14，实际 ${approved}（迁移数据问题）`);

    const bound = wb.prepare(
      "SELECT e.name AS name, e.id AS id FROM ont_entities e JOIN ont_bindings b ON b.entity_id = e.id "
      + "WHERE b.status = 'approved' ORDER BY e.name",
    ).all() as Array<{ name: string; id: string }>;
    if (bound.length !== approved) {
      throw new Error(`approved 绑定 ${approved} 与可解析绑定实体 ${bound.length} 不一致（重复绑定，迁移数据问题）`);
    }

    for (const { name, id } of bound) {
      // 直出规范化绑定：resolveBinding 内部经 ont_attributes（WHERE entity_id）还原属性名，
      // 数组形态而映射数据不完整时显式抛错（normalizeFieldMap 的守卫）。
      const rb = resolveBinding(wb, id);
      if (rb.datasourceId !== dsId) throw new Error(`${name} 绑定的数据源 ${rb.datasourceId} 不是 SPC_MVP_SQLITE`);
      if (Object.keys(rb.fieldMap).length === 0) throw new Error(`${name} 绑定没有可查询的已映射属性（迁移数据问题）`);
      BIND[name] = rb;
    }

    // ---- ③ 真实关系：ont_relations（source_field/target_field 完整才可走，与 traverse 契约一致）----
    REL = (wb.prepare(
      "SELECT e1.name AS from_name, e2.name AS to_name, r.source_field AS source_field, r.target_field AS target_field "
      + "FROM ont_relations r JOIN ont_entities e1 ON e1.id = r.from_entity_id JOIN ont_entities e2 ON e2.id = r.to_entity_id "
      + "WHERE r.source_field IS NOT NULL AND r.target_field IS NOT NULL",
    ).all() as Array<{ from_name: string; to_name: string; source_field: string; target_field: string }>)
      .map(r => ({ fromEntityId: r.from_name, toEntityId: r.to_name, sourceField: r.source_field, targetField: r.target_field }));
    if (!REL.some(r => r.fromEntityId === "AnomWafer" && r.toEntityId === "ToolEvent")) {
      throw new Error("ont_relations 缺 AnomWafer→ToolEvent 的可走关系 anom_wafer_chamber_events（迁移数据问题）");
    }
  });

  afterAll(() => {
    spc?.close();
    wb?.close();
  });

  // ================= cases 0-11（eq_chamber…total_count_matches_pages）→ objectQuery =================
  // 用例表述沿用 golden.test.ts：idColumn 统一 "id"（四个视图的第一列 id 即语义键别名），
  // objectQuery 固定 ORDER BY id 与 golden 语义列排序等价；eq_chamber 241 行按 200/页翻页拼接。
  type ObjCase = { entity: string; filters: Filters; pages: [number, number][] };
  const OBJ_CASES: Record<string, ObjCase> = {
    eq_chamber:        { entity: "AnomWafer",      filters: { chamber_id: "PVD01_CH_B" }, pages: [[200, 0], [200, 200]] },
    gte_date:          { entity: "RcaDaily",       filters: { stat_date: { gte: "2026-09-21" } }, pages: [[200, 0]] },
    lte_date:          { entity: "RcaDaily",       filters: { stat_date: { lte: "2026-09-30" } }, pages: [[200, 0]] },
    neq_chamber:       { entity: "RcaChamberRate", filters: { chamber_id: { neq: "PVD01_CH_B" } }, pages: [[200, 0]] },
    in_chambers:       { entity: "RcaChamberRate", filters: { chamber_id: { in: ["PVD01_CH_A", "PVD01_CH_B"] } }, pages: [[200, 0]] },
    not_in_chambers:   { entity: "RcaChamberRate", filters: { chamber_id: { not_in: ["PVD01_CH_B"] } }, pages: [[200, 0]] },
    // golden 在未投影列上表达空集 IN；objectQuery 只投影已映射属性，改在属性 id 上表达同一 1 = 0 语义
    in_empty_is_false: { entity: "RcaChamberRate", filters: { id: { in: [] } }, pages: [[200, 0]] },
    like_lot_prefix:   { entity: "RcaAnomLot",     filters: { lot_id: { like: "L26-10%" } }, pages: [[200, 0]] },
    like_underscore:   { entity: "RcaDaily",       filters: { stat_date: { like: "2026-09-__" } }, pages: [[200, 0]] },
    page1:             { entity: "AnomWafer",      filters: {}, pages: [[200, 0]] },
    page2:             { entity: "AnomWafer",      filters: {}, pages: [[200, 200]] },
  };

  for (const g of GOLDEN.cases.slice(0, 11)) {
    const c = OBJ_CASES[g.name];
    if (!c) throw new Error(`golden 用例 ${g.name} 缺 objectQuery 表述`);
    it(g.name, () => {
      const first = objectQuery(spc, mustBind(c.entity), c.filters, c.pages[0]![0], c.pages[0]![1]);
      const rows = c.pages.slice(1).flatMap(([limit, offset]) => objectQuery(spc, mustBind(c.entity), c.filters, limit, offset).rows);
      // 列名对齐：真实绑定的 objectQuery 返回 fieldMap 全列（元枢序），按 golden 列名重排后深比较
      expect(projectByColumns(first.columns, [...first.rows, ...rows], g.expectedColumns)).toEqual(g.expectedRows);
    });
  }

  // golden SQL: SELECT count(*) AS c FROM v_anom_wafer → 243 = page1(200) + page2(43)
  it("total_count_matches_pages", () => {
    const g = GOLDEN.cases.find(x => x.name === "total_count_matches_pages");
    const p1 = objectQuery(spc, mustBind("AnomWafer"), {}, 200, 0);
    const p2 = objectQuery(spc, mustBind("AnomWafer"), {}, 200, 200);
    expect(p1.rowCount).toBe(200);
    expect(p2.rowCount).toBe(43);
    expect(p1.rowCount + p2.rowCount).toBe(g?.expectedRows[0]?.[0]);
  });

  // ============ cases 12-19（agg_baseline_moments…order_asc_limit）→ executeOntologySql ============
  // SQL 构造沿用 ontology-sql.test.ts 的 reverse-mapping 装置：golden 以物理表名书写，此处以
  // **真实绑定**的 table→实体名 反查改写（长名优先），? → :pN 命名占位 —— 装置不进入被测实现。
  // 输出列来自 SQL 本身（别名即 golden expectedColumns），按位置深比较，不涉及列名对齐。
  // （反查表在 beforeAll 填充 BIND 之后构建，测试体经闭包读取。）
  const REVERSE: Record<string, string> = {};
  beforeAll(() => {
    for (const [entity, b] of Object.entries(BIND)) REVERSE[b.table] = entity;
  });

  for (const g of GOLDEN.cases.slice(12)) {
    it(g.name, () => {
      let objSql = g.sql;
      for (const [table, entity] of Object.entries(REVERSE).sort((a, b) => b[0].length - a[0].length)) {
        objSql = objSql.replace(new RegExp(`(?<![\\p{L}\\p{N}_.])${table}(?![\\p{L}\\p{N}_])`, "gu"), entity);
      }
      let pi = 0;
      objSql = objSql.replace(/\?/g, () => `:p${pi++}`);
      const r = executeOntologySql(spc, BIND, objSql, Object.fromEntries(g.params.map((p, i) => [`p${i}`, p])));
      expect(r.columns).toEqual(g.expectedColumns);
      expect(r.rows).toEqual(g.expectedRows);
    });
  }

  // ================= traverse 两用例 → Task 6 traverse + ont_relations 真实关系 =================
  // traverse 按契约投影目标实体 fieldMap 全列（ToolEvent 7 列，元枢序），golden 是列投影
  // （5 列 / 2 列）—— 按列名对齐切片比较（ToolEvent 各行 id 唯一，DISTINCT 列集扩大不增行）。
  it("traverse_anom_to_events (traverse + ont_relations 真实关系)", () => {
    const g = GOLDEN.cases.find(c => c.name === "traverse_anom_to_events");
    const r = traverse(spc, BIND, REL, "AnomWafer", {}, "ToolEvent", 200);
    expect(projectByColumns(r.columns, r.rows, g?.expectedColumns ?? [])).toEqual(g?.expectedRows);
  });

  it("traverse_with_source_filter (traverse + ont_relations 真实关系)", () => {
    const g = GOLDEN.cases.find(c => c.name === "traverse_with_source_filter");
    const r = traverse(spc, BIND, REL, "AnomWafer", { chamber_id: "PVD01_CH_A" }, "ToolEvent", 200);
    expect(projectByColumns(r.columns, r.rows, g?.expectedColumns ?? [])).toEqual(g?.expectedRows);
  });
});
