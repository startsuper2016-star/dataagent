import { DatabaseSync } from "node:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { objectQuery } from "./query.js";
import type { Binding } from "./bindings.js";
import type { Filters } from "./dsl.js";

const GOLDEN = JSON.parse(readFileSync(new URL("../test/golden/golden.json", import.meta.url), "utf-8")) as {
  cases: { name: string; sql: string; params: unknown[]; expectedColumns: string[]; expectedRows: unknown[][] }[];
};
const SPC_DB = "C:/Users/shuan/Downloads/ontology-master (3)/ontology-master/local-data/spc_mvp/spc_mvp.db";
const HAS_DB = existsSync(SPC_DB);

// cases 1-12（eq_chamber .. total_count_matches_pages）的对象查询表述。
// 实体绑定 = Task 6 迁移后的形态：各视图第一列 id 即语义键的别名
// （v_anom_wafer.id=wafer_id、v_day_flag.id=stat_date、
//   v_chamber_rate.id=chamber_id、v_anom_lot.id=lot_id），
// 因此 binding.idColumn 统一为 "id"，objectQuery 固定 ORDER BY "id"
// 与 golden 各用例的 ORDER BY 语义列完全等价（值相同、同为 TEXT 排序）。
// pages: objectQuery 单页上限 MAX_ROWS=200；golden 前段用例为无 LIMIT 捕获，
// 行数超过 200 的（eq_chamber=241）按 200/页翻页拼接还原，行序不受影响。
type ObjCase = { table: string; filters: Filters; pages: [limit: number, offset: number][] };
const CASES: Record<string, ObjCase> = {
  eq_chamber:              { table: "v_anom_wafer",   filters: { chamber_id: "PVD01_CH_B" }, pages: [[200, 0], [200, 200]] },
  gte_date:                { table: "v_day_flag",     filters: { stat_date: { gte: "2026-09-21" } }, pages: [[200, 0]] },
  lte_date:                { table: "v_day_flag",     filters: { stat_date: { lte: "2026-09-30" } }, pages: [[200, 0]] },
  neq_chamber:             { table: "v_chamber_rate", filters: { chamber_id: { neq: "PVD01_CH_B" } }, pages: [[200, 0]] },
  in_chambers:             { table: "v_chamber_rate", filters: { chamber_id: { in: ["PVD01_CH_A", "PVD01_CH_B"] } }, pages: [[200, 0]] },
  not_in_chambers:         { table: "v_chamber_rate", filters: { chamber_id: { not_in: ["PVD01_CH_B"] } }, pages: [[200, 0]] },
  // golden SQL 为 SELECT id ... WHERE 1 = 0（chamber_id 空集 IN）；
  // objectQuery 只投影已映射属性，故在投影属性 id 上表达同一空集 IN 语义（buildWhere 同一 1 = 0 分支）
  in_empty_is_false:       { table: "v_chamber_rate", filters: { id: { in: [] } }, pages: [[200, 0]] },
  like_lot_prefix:         { table: "v_anom_lot",     filters: { lot_id: { like: "L26-10%" } }, pages: [[200, 0]] },
  like_underscore:         { table: "v_day_flag",     filters: { stat_date: { like: "2026-09-__" } }, pages: [[200, 0]] },
  page1:                   { table: "v_anom_wafer",   filters: {}, pages: [[200, 0]] },
  page2:                   { table: "v_anom_wafer",   filters: {}, pages: [[200, 200]] },
};

function bindingFor(table: string, columns: string[]): Binding {
  // golden 的 expectedColumns 就是属性序列，物理列同名——fieldMap 为恒等映射
  return { datasourceId: "spc", table, idColumn: "id",
    fieldMap: Object.fromEntries(columns.map(c => [c, c])), status: "approved" };
}

describe.skipIf(!HAS_DB)("golden cases 1-12 (objectQuery: eq_chamber..total_count_matches_pages)", () => {
  // 连接必须懒建（beforeAll）：describe 工厂在收集期无条件执行，
  // DB 不在的机器（CI）上急建会直接 ERR_SQLITE_ERROR 而非走 skipIf 跳过
  let conn: DatabaseSync;
  beforeAll(() => { conn = new DatabaseSync(SPC_DB); });

  for (const g of GOLDEN.cases.slice(0, 11)) {
    const c = CASES[g.name];
    if (!c) throw new Error(`golden case 未找到: ${g.name}`);
    it(g.name, () => {
      const b = bindingFor(c.table, g.expectedColumns);
      const rows = c.pages.flatMap(([limit, offset]) => objectQuery(conn, b, c.filters, limit, offset).rows);
      expect(rows).toEqual(g.expectedRows);
    });
  }

  // golden SQL: SELECT count(*) AS c FROM v_anom_wafer → 243 = page1(200) + page2(43)
  it("total_count_matches_pages", () => {
    const g = GOLDEN.cases.find(x => x.name === "total_count_matches_pages");
    const b = bindingFor("v_anom_wafer", ["id", "wafer_id", "chamber_id", "rs_ti_mean"]);
    const p1 = objectQuery(conn, b, {}, 200, 0);
    const p2 = objectQuery(conn, b, {}, 200, 200);
    expect(p1.rowCount).toBe(200);
    expect(p2.rowCount).toBe(43);
    expect(p1.rowCount + p2.rowCount).toBe(g?.expectedRows[0]?.[0]);
  });
});
