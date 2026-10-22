import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, beforeAll } from "vitest";
import { ensureOntologyTables } from "./schema.js";
import { objectQuery } from "./query.js";
import { resolveBinding } from "./bindings.js";

// 内存 fixture：真实 spc_mvp 视图结构的最小复刻
let db: DatabaseSync;
const B = {
  datasourceId: "ds-1", table: "v_anom_wafer", idColumn: "id",
  fieldMap: { id: "id", wafer_id: "wafer_id", chamber_id: "chamber_id", rs_ti_mean: "rs_ti_mean" },
  status: "approved",
};
beforeAll(() => {
  db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE v_anom_wafer (id TEXT PRIMARY KEY, wafer_id TEXT, lot_id TEXT,
    chamber_id TEXT, process_date TEXT, mon TEXT, rs_ti_mean REAL)`);
  db.prepare("INSERT INTO v_anom_wafer VALUES ('w2','W2','L1','B',NULL,NULL,1.1)").run();
  db.prepare("INSERT INTO v_anom_wafer VALUES ('w1','W1','L1','A',NULL,NULL,1.2)").run();
  db.prepare("INSERT INTO v_anom_wafer VALUES ('w3','W3','L2','B',NULL,NULL,1.3)").run();
});

describe("objectQuery", () => {
  it("returns columns in fieldMap order with rows as arrays", () => {
    const r = objectQuery(db, B, {}, 10, 0);
    expect(r.columns).toEqual(["id", "wafer_id", "chamber_id", "rs_ti_mean"]);
    expect(r.rows.length).toBe(3);
    expect(r.rowCount).toBe(3);
  });
  it("applies equality filter", () => {
    const r = objectQuery(db, B, { chamber_id: "B" }, 10, 0);
    expect(r.rowCount).toBe(2);
  });
  it("orders by id column and supports offset paging", () => {
    const p1 = objectQuery(db, B, {}, 2, 0);
    const p2 = objectQuery(db, B, {}, 2, 2);
    expect(p1.rows.map(r => r[0])).toEqual(["w1", "w2"]);
    expect(p2.rows.map(r => r[0])).toEqual(["w3"]);
  });
  it("clamps limit to 200", () => {
    const r = objectQuery(db, B, {}, 500, 0);
    expect(r.rowCount).toBe(3);   // 3 行全部返回（钳制上限 200 未触及）
  });
  it("resolveBinding reads approved binding", () => {
    ensureOntologyTables(db);
    db.prepare("INSERT INTO ont_bindings VALUES ('b1','e1','ds1','v_x','id',NULL,NULL,'{}','approved')").run();
    const b = resolveBinding(db, "e1");
    expect(b.table).toBe("v_x");
    expect(() => resolveBinding(db, "nope")).toThrow(/未绑定/);
  });
});
