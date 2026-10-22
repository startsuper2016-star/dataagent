import { DatabaseSync } from "node:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it, beforeAll } from "vitest";
import { ensureOntologyTables } from "./schema.js";
import { traverse, type RelationEdge } from "./traverse.js";
import type { Binding } from "./bindings.js";

let db: DatabaseSync;
const B: Record<string, Binding> = {
  AnomWafer: { datasourceId: "spc", table: "v_anom_wafer", idColumn: "wafer_id",
    fieldMap: { wafer_id: "wafer_id", chamber_id: "chamber_id" }, status: "approved" },
  ToolEvent: { datasourceId: "spc", table: "dim_tool_event", idColumn: "id",
    fieldMap: { id: "id", chamber_id: "chamber_id", event_type: "event_type" }, status: "approved" },
};
const REL: RelationEdge[] = [
  { fromEntityId: "AnomWafer", toEntityId: "ToolEvent", sourceField: "chamber_id", targetField: "chamber_id" },
];

// 多跳/反向扩展 fixture：Wafer → Chamber → Tool（三实体两跳）与反向边（ToolEvent → AnomWafer）
const B_EXT: Record<string, Binding> = {
  ...B,
  Chamber: { datasourceId: "spc", table: "dim_chamber", idColumn: "chamber_id",
    fieldMap: { chamber_id: "chamber_id", eqp_id: "eqp_id", chamber_name: "chamber_name" }, status: "approved" },
  Tool: { datasourceId: "spc", table: "dim_tool", idColumn: "eqp_id",
    fieldMap: { eqp_id: "eqp_id", tool_name: "tool_name", chamber_id: "chamber_id" }, status: "approved" },
};
const REL_2HOP: RelationEdge[] = [
  ...REL,
  { fromEntityId: "AnomWafer", toEntityId: "Chamber", sourceField: "chamber_id", targetField: "chamber_id" },
  { fromEntityId: "Chamber", toEntityId: "Tool", sourceField: "eqp_id", targetField: "eqp_id" },
];
// 追加直连边（登记顺序在两跳边之后，验证 BFS 仍取最短路径）
const REL_ALL: RelationEdge[] = [
  ...REL_2HOP,
  { fromEntityId: "AnomWafer", toEntityId: "Tool", sourceField: "chamber_id", targetField: "chamber_id" },
];

beforeAll(() => {
  db = new DatabaseSync(":memory:");
  ensureOntologyTables(db);
  db.exec(`CREATE TABLE v_anom_wafer (wafer_id TEXT, chamber_id TEXT)`);
  db.exec(`CREATE TABLE dim_tool_event (id TEXT, chamber_id TEXT, event_type TEXT)`);
  db.prepare("INSERT INTO v_anom_wafer VALUES ('W1','PVD01_CH_B')").run();
  db.prepare("INSERT INTO v_anom_wafer VALUES ('W2','PVD01_CH_A')").run();
  db.prepare("INSERT INTO dim_tool_event VALUES ('EVT-001','PVD01_CH_B','靶材更换')").run();
  db.prepare("INSERT INTO dim_tool_event VALUES ('EVT-002','PVD01_CH_A','预防性维护')").run();
  db.prepare("INSERT INTO dim_tool_event VALUES ('EVT-003','PVD01_CH_B','预防性维护')").run();
  // 多跳扩展表
  db.exec(`CREATE TABLE dim_chamber (chamber_id TEXT, eqp_id TEXT, chamber_name TEXT)`);
  db.exec(`CREATE TABLE dim_tool (eqp_id TEXT, tool_name TEXT, chamber_id TEXT)`);
  db.prepare("INSERT INTO dim_chamber VALUES ('PVD01_CH_A','PVD01','Chamber A')").run();
  db.prepare("INSERT INTO dim_chamber VALUES ('PVD01_CH_B','PVD01','Chamber B')").run();
  db.prepare("INSERT INTO dim_tool VALUES ('PVD01','Sputter-01',NULL)").run();
  // 直连边专用行：chamber_id 命中 CH_B，而 2 跳路径（eqp）只会命中 PVD01——两条路结果可区分
  db.prepare("INSERT INTO dim_tool VALUES ('T-DIRECT','DirectTool','PVD01_CH_B')").run();
});

describe("traverse", () => {
  it("joins via relation and dedupes (DISTINCT)", () => {
    const r = traverse(db, B, REL, "AnomWafer", { chamber_id: "PVD01_CH_B" }, "ToolEvent", 200);
    expect(r.rows.map(r => r[0])).toEqual(["EVT-001", "EVT-003"]);
    expect(r.rowCount).toBe(2);
  });
  it("applies source filters via DSL", () => {
    const r = traverse(db, B, REL, "AnomWafer", { chamber_id: { in: ["PVD01_CH_A"] } }, "ToolEvent", 200);
    expect(r.rows.map(r => r[0])).toEqual(["EVT-002"]);
  });
  it("throws on no relation path", () => {
    expect(() => traverse(db, B, REL, "AnomWafer", {}, "RcaDaily", 200)).toThrow(/关系路径|关系/);
  });
  it("same entity returns objectQuery-equivalent rows", () => {
    const r = traverse(db, B, REL, "AnomWafer", { chamber_id: "PVD01_CH_B" }, "AnomWafer", 200);
    expect(r.rowCount).toBe(1);
  });

  it("traverses a registered relation in reverse (undirected, fields swapped)", () => {
    // 反向：ToolEvent(靶材更换=CH_B) → AnomWafer；边方向与登记相反，字段对调后 JOIN
    const r = traverse(db, B_EXT, REL_ALL, "ToolEvent", { event_type: "靶材更换" }, "AnomWafer", 200);
    expect(r.columns).toEqual(["wafer_id", "chamber_id"]);
    expect(r.rows).toEqual([["W1", "PVD01_CH_B"]]);
    expect(r.rowCount).toBe(1);
  });
  it("compiles a 2-hop JOIN chain with aliases a0→a1→a2", () => {
    // AnomWafer → Chamber → Tool：两跳 JOIN 链 + 起点过滤；CH_B → PVD01 → Sputter-01
    // （T-DIRECT 行 eqp 不匹配，不会进入 2 跳结果；chamber_id 为 NULL 物理值照常投影）
    const r = traverse(db, B_EXT, REL_2HOP, "AnomWafer", { chamber_id: "PVD01_CH_B" }, "Tool", 200);
    expect(r.columns).toEqual(["eqp_id", "tool_name", "chamber_id"]);
    expect(r.rows).toEqual([["PVD01", "Sputter-01", null]]);
    expect(r.rowCount).toBe(1);
  });
  it("picks BFS shortest path when 1-hop and 2-hop routes both exist", () => {
    // AnomWafer→Tool 同时存在直连边（chamber_id，登记在最末）与 2 跳路径（经 Chamber.eqp），
    // 两条路结果可区分：直连命中 T-DIRECT 行，2 跳命中 PVD01 行——BFS 必须取 1 跳。
    const r = traverse(db, B_EXT, REL_ALL, "AnomWafer", { chamber_id: "PVD01_CH_B" }, "Tool", 200);
    expect(r.rows).toEqual([["T-DIRECT", "DirectTool", "PVD01_CH_B"]]);
    expect(r.rowCount).toBe(1);
  });
  it("throws when a relation field is not mapped to a physical column", () => {
    const bad: Record<string, Binding> = {
      ...B_EXT,
      // eqp_id 未映射（显式字面量构造，避免 exactOptionalPropertyTypes 下可选属性展开失配）
      Chamber: { datasourceId: "spc", table: "dim_chamber", idColumn: "chamber_id",
        fieldMap: { chamber_id: "chamber_id" }, status: "approved" },
    };
    expect(() => traverse(db, bad, REL_2HOP, "AnomWafer", {}, "Tool", 200))
      .toThrow(/未映射到物理列/);
  });
  it("clamps limit: 1 row for limit=1, and limit=0 raises to 1", () => {
    const one = traverse(db, B, REL, "AnomWafer", { chamber_id: "PVD01_CH_B" }, "ToolEvent", 1);
    expect(one.rowCount).toBe(1);
    const zero = traverse(db, B, REL, "AnomWafer", { chamber_id: "PVD01_CH_B" }, "ToolEvent", 0);
    expect(zero.rowCount).toBe(1);
  });
});

// ---- golden 对应（真实 spc_mvp.db，Phase 0 已验证的两条 traverse 用例）----
const GOLDEN = JSON.parse(readFileSync(new URL("../test/golden/golden.json", import.meta.url), "utf-8")) as {
  cases: { name: string; expectedColumns: string[]; expectedRows: unknown[][] }[];
};
const SPC_DB = "C:/Users/shuan/Downloads/ontology-master (3)/ontology-master/local-data/spc_mvp/spc_mvp.db";
const HAS_DB = existsSync(SPC_DB);
const GOLDEN_REL: RelationEdge[] = [
  { fromEntityId: "AnomWafer", toEntityId: "ToolEvent", sourceField: "chamber_id", targetField: "chamber_id" },
];
// ToolEvent 全量 fieldMap：JOIN 字段 chamber_id 必须在映射中（契约②），投影按 fieldMap 全列（契约⑦）。
// golden traverse_with_source_filter 的 SQL 为手写投影（仅 id/event_type 两列），
// 行值以列子集切片对比（fieldMap 键序 id=0, eqp_id=1, chamber_id=2, event_type=3, event_start=4）。
const GOLDEN_BINDINGS: Record<string, Binding> = {
  AnomWafer: { datasourceId: "spc", table: "v_anom_wafer", idColumn: "wafer_id",
    fieldMap: { wafer_id: "wafer_id", chamber_id: "chamber_id" }, status: "approved" },
  ToolEvent: { datasourceId: "spc", table: "dim_tool_event", idColumn: "id",
    fieldMap: { id: "id", eqp_id: "eqp_id", chamber_id: "chamber_id", event_type: "event_type", event_start: "event_start" },
    status: "approved" },
};

describe.skipIf(!HAS_DB)("traverse golden parity (cases 12-13)", () => {
  const conn = new DatabaseSync(SPC_DB);

  // golden SQL: SELECT DISTINCT t.id, t.eqp_id, t.chamber_id, t.event_type, t.event_start
  //             FROM v_anom_wafer a JOIN dim_tool_event t ON a.chamber_id = t.chamber_id ORDER BY t.id
  it("traverse_anom_to_events", () => {
    const g = GOLDEN.cases.find(c => c.name === "traverse_anom_to_events")!;
    const r = traverse(conn, GOLDEN_BINDINGS, GOLDEN_REL, "AnomWafer", {}, "ToolEvent", 200);
    expect(r.columns).toEqual(g.expectedColumns);
    expect(r.rows).toEqual(g.expectedRows);
  });

  // golden SQL: SELECT DISTINCT t.id, t.event_type FROM v_anom_wafer a
  //             JOIN dim_tool_event t ON a.chamber_id = t.chamber_id WHERE a.chamber_id = ? ORDER BY t.id
  it("traverse_with_source_filter", () => {
    const g = GOLDEN.cases.find(c => c.name === "traverse_with_source_filter")!;
    const r = traverse(conn, GOLDEN_BINDINGS, GOLDEN_REL, "AnomWafer", { chamber_id: "PVD01_CH_A" }, "ToolEvent", 200);
    expect(r.rows.map(row => [row[0], row[3]])).toEqual(g.expectedRows);
  });
});
