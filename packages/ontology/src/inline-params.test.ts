import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { inlineParams } from "./inline-params.js";

describe("inlineParams", () => {
  it("inlines named params as literals", () => {
    expect(inlineParams("SELECT * FROM t WHERE a = :p0 AND b = :p1", { p0: "x", p1: 5 }))
      .toBe("SELECT * FROM t WHERE a = 'x' AND b = 5");
  });
  it("escapes single quotes — DROP does not execute", () => {
    const sql = inlineParams("SELECT * FROM t WHERE a = :p0", { p0: "x'; DROP TABLE t;--" });
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE t(a TEXT)");
    db.exec("INSERT INTO t VALUES ('safe')");
    const rows = db.prepare(sql).all();
    expect(rows.length).toBe(0);           // 按字面量匹配，无表被删
    expect((db.prepare("SELECT count(*) AS c FROM sqlite_master WHERE type='table'").get() as {c:number}).c).toBe(1);
  });
  it("rejects keys outside ^p\\d+(_\\d+)?$ contract", () => {
    expect(() => inlineParams("SELECT 1", { evil: 1 })).toThrow(/参数键名不合法/);
    expect(() => inlineParams("SELECT :x0", { "x0": 1 })).toThrow(/参数键名不合法/);
  });
  it("accepts p<N>_<M> sub-params", () => {
    expect(inlineParams("SELECT :p0_0, :p0_1", { p0_0: "a", p0_1: "b" })).toBe("SELECT 'a', 'b'");
  });
  it("no cascade: value containing :p1 does not re-expand", () => {
    const sql = inlineParams("SELECT * FROM t WHERE a = :p0", { p0: ":p1' OR '1'='1", p1: "zzz" });
    expect(sql).toBe("SELECT * FROM t WHERE a = ':p1'' OR ''1''=''1'");
  });
  it("no $-pattern interpretation in replacement", () => {
    const sql = inlineParams("SELECT * FROM t WHERE a = :p0", { p0: "$& $' $`" });
    expect(sql).toBe("SELECT * FROM t WHERE a = '$& $'' $`'");
  });
  it("adjacent params both replaced", () => {
    expect(inlineParams("SELECT :p0:p1", { p0: 1, p1: 2 })).toBe("SELECT 12");
  });
  it("null and boolean literals", () => {
    expect(inlineParams("SELECT :p0, :p1", { p0: null, p1: true })).toBe("SELECT NULL, 1");
  });
  it("NaN and Infinity fall into string escaping", () => {
    expect(inlineParams("SELECT :p0", { p0: NaN })).toBe("SELECT 'NaN'");
  });
  it("p1 vs p10 boundary does not cross-match", () => {
    const sql = inlineParams("SELECT :p1, :p10", { p1: "one", p10: "ten" });
    expect(sql).toBe("SELECT 'one', 'ten'");
  });
});
