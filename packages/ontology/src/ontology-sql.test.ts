import { DatabaseSync } from "node:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { executeOntologySql, rewriteObjectNames } from "./ontology-sql.js";
import type { Binding } from "./bindings.js";

// golden cases 13-20（agg_baseline_moments…order_asc_limit，slice(12) 的后 8 个）。
// brief 写 slice(13)（"cases 14-20"）为 off-by-one：golden.json 第 13 位是
// agg_baseline_moments（count/sum 基线聚合，WaferFact 场景）；plan 文档 Task 5 的
// 用例区间即 "agg_baseline_moments…order_asc_limit"、commit 口径 "golden 20/20"，
// 漏掉它 golden 将永远 19/20，故按 slice(12) 覆盖剩余全部 8 例。
const GOLDEN = JSON.parse(readFileSync(new URL("../test/golden/golden.json", import.meta.url), "utf-8")) as {
  cases: { name: string; sql: string; params: unknown[]; expectedColumns: string[]; expectedRows: unknown[][] }[];
};
const SPC_DB = "C:/Users/shuan/Downloads/ontology-master (3)/ontology-master/local-data/spc_mvp/spc_mvp.db";
const HAS_DB = existsSync(SPC_DB);

function colMapFor(table: string): Record<string, string> {
  // 每个物理视图的属性序列=全部列同名（与 Task 6 迁移的 field_mappings 同构）
  const probe = new DatabaseSync(SPC_DB);
  const cols = probe.prepare(`SELECT * FROM ${table} LIMIT 0`).columns().map(c => c.name).filter(c => c !== "id");
  probe.close();
  return Object.fromEntries(cols.map(c => [c, c]));
}

describe("rewriteObjectNames", () => {
  it("rewrites with unicode-safe boundaries", () => {
    const { sql, referenced } = rewriteObjectNames(
      "SELECT * FROM AnomWafer a JOIN 中文对象 c ON a.wafer_id = c.wafer_id",
      { AnomWafer: "v_anom_wafer", 中文对象: "t_cn" });
    expect(sql).toContain("v_anom_wafer");
    expect(sql).toContain("t_cn");
    expect(referenced).toEqual(["AnomWafer", "中文对象"]);
  });
  it("long-name-first: p1 does not clobber p10-style names", () => {
    const { sql } = rewriteObjectNames("SELECT * FROM AnomWaferX JOIN AnomWafer", { AnomWafer: "t1", AnomWaferX: "t2" });
    expect(sql).toContain("t2");
    expect(sql).toContain("t1");
    expect(sql).not.toContain("AnomWaferX");
  });
});

describe.skipIf(!HAS_DB)("executeOntologySql — golden cases 13-20", () => {
  // 连接与绑定都必须懒建（beforeAll）：describe 工厂在收集期无条件执行，
  // DB 不在的机器（CI）上急建会直接 ERR_SQLITE_ERROR 而非走 skipIf 跳过
  let conn: DatabaseSync;
  let BINDINGS: Record<string, Binding>;

  beforeAll(() => {
    conn = new DatabaseSync(SPC_DB);
    // 对象名→物理表（与 Task 6 迁移后的 ont_bindings 同构；物理列=属性名同名）
    BINDINGS = Object.fromEntries(
      ([
        ["WaferFact", "v_wafer_agg"], ["ToolEvent", "dim_tool_event"],
        ["RcaChamberComp", "v_chamber_comp"], ["RcaFdcGroup", "v_fdc_group"],
        ["RcaFdcCorr", "v_fdc_corr"], ["AnomLot", "v_anom_lot"],
        ["AnomWafer", "v_anom_wafer"], ["RcaDaily", "v_day_flag"],
      ] as [string, string][]).map(([entity, table]) => [entity, {
        datasourceId: "spc", table, idColumn: "id", status: "approved",
        fieldMap: colMapFor(table),
      }]),
    );
  });

  it("rejects sql with no ontology reference", () => {
    expect(() => executeOntologySql(conn, BINDINGS, "SELECT * FROM sqlite_master")).toThrow(/白名单/);
  });

  for (const g of GOLDEN.cases.slice(12)) {
    it(g.name, () => {
      // golden SQL 以物理表名 + 位置 ? 占位书写（Python 参考实现直查视图）；
      // 本测试以对象名 + :pN 命名占位书写同语义 SQL——反向映射（物理表名→对象名，
      // 长名优先）与 ?→:p0.. （inlineParams 为 named-form；node:sqlite 对未绑定 ? 不报错
      // 而是按 NULL 比较静默返回空集）均为测试装置，不进入被测实现。
      const reverse: Record<string, string> = {};
      for (const [entity, b] of Object.entries(BINDINGS)) reverse[b.table] = entity;
      let objSql = g.sql;
      for (const [table, entity] of Object.entries(reverse).sort((a, b) => b[0].length - a[0].length)) {
        objSql = objSql.replace(new RegExp(`(?<![\\p{L}\\p{N}_.])${table}(?![\\p{L}\\p{N}_])`, "gu"), entity);
      }
      let pi = 0;
      objSql = objSql.replace(/\?/g, () => `:p${pi++}`);
      const r = executeOntologySql(conn, BINDINGS, objSql, Object.fromEntries(g.params.map((p, i) => [`p${i}`, p])));
      expect(r.columns).toEqual(g.expectedColumns);
      expect(r.rows).toEqual(g.expectedRows);
    });
  }
});
