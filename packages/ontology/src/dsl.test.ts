import { describe, expect, it } from "vitest";
import { buildWhere, iterFilterConditions, likeToRegex, matchFilterValue } from "./dsl.js";

const FM = { chamber_id: "chamber_id", stat_date: "stat_date", day_mean: "day_mean" };

describe("iterFilterConditions", () => {
  it("plain value becomes eq", () => {
    expect([...iterFilterConditions({ a: 1 })]).toEqual([["a", "eq", 1]]);
  });
  it("dict expands to ops, unknown op throws", () => {
    expect([...iterFilterConditions({ a: { gte: 1, lt: 5 } })]).toEqual([["a","gte",1],["a","lt",5]]);
    expect(() => [...iterFilterConditions({ a: { foo: 1 } })]).toThrow(/不支持的过滤操作符/);
  });
});

describe("buildWhere", () => {
  it("translates ops with quoted columns and named params", () => {
    const { where, params } = buildWhere(FM, { chamber_id: { eq: "A" }, stat_date: { gte: "2026-09-21" } });
    expect(where[0]).toBe('"chamber_id" = :p0');
    expect(where[1]).toBe('"stat_date" >= :p1');
    expect(params).toEqual({ p0: "A", p1: "2026-09-21" });
  });
  it("empty in is 1=0, empty not_in is 1=1", () => {
    expect(buildWhere(FM, { chamber_id: { in: [] } }).where[0]).toBe("1 = 0");
    expect(buildWhere(FM, { chamber_id: { not_in: [] } }).where[0]).toBe("1 = 1");
  });
  it("expanding in with multiple params", () => {
    const { where, params } = buildWhere(FM, { chamber_id: { in: ["A", "B"] } });
    expect(where[0]).toBe('"chamber_id" IN (:p0_0, :p0_1)');
    expect(params).toEqual({ p0_0: "A", p0_1: "B" });
  });
  it("is_null / not_null need no param", () => {
    expect(buildWhere(FM, { day_mean: { is_null: true } }).where[0]).toBe('"day_mean" IS NULL');
    expect(buildWhere(FM, { day_mean: { not_null: true } }).where[0]).toBe('"day_mean" IS NOT NULL');
  });
  it("throws on unknown attribute", () => {
    expect(() => buildWhere(FM, { nope: 1 })).toThrow();
  });
  it("multi-op dict ANDs together", () => {
    const { where } = buildWhere(FM, { stat_date: { gte: "2026-09-21", lte: "2026-09-30" } });
    expect(where).toHaveLength(2);
    expect(where[0]).toBe('"stat_date" >= :p0');
    expect(where[1]).toBe('"stat_date" <= :p1');
  });
});

describe("matchFilterValue (python parity)", () => {
  it("null is false for everything except is_null/not_null", () => {
    expect(matchFilterValue(null, { gte: 1 })).toBe(false);
    expect(matchFilterValue(null, { is_null: true })).toBe(true);
    expect(matchFilterValue(null, { not_null: true })).toBe(false);
    expect(matchFilterValue(null, "x")).toBe(false);
  });
  it("strict type mismatch throws like python TypeError", () => {
    expect(() => matchFilterValue("10", { gt: 9 })).toThrow();
    expect(() => matchFilterValue(10, { lt: "9" })).toThrow();
  });
  it("numbers compare numerically", () => {
    expect(matchFilterValue(10, { gt: 9 })).toBe(true);
    expect(matchFilterValue(5, { gte: 5 })).toBe(true);
  });
  it("empty arrays for in / not_in", () => {
    expect(matchFilterValue("x", { in: [] })).toBe(false);
    expect(matchFilterValue("x", { not_in: [] })).toBe(true);
  });
  it("like is case-insensitive with % and _ wildcards", () => {
    expect(matchFilterValue("L26-100", { like: "l26-1%" })).toBe(true);
    expect(matchFilterValue("L26-10", { like: "l26-1_" })).toBe(true);
    expect(matchFilterValue("L26-100", { not_like: "zz%" })).toBe(true);
    expect(matchFilterValue("L26-100", { like: "zz%" })).toBe(false);
  });
  it("like regex metacharacters in pattern are literal", () => {
    expect(matchFilterValue("a.c", { like: "a.c" })).toBe(true);
    expect(matchFilterValue("abc", { like: "a.c" })).toBe(false);
  });
});
