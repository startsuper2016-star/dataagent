import { DatabaseSync } from "node:sqlite";
import { beforeAll, describe, expect, it } from "vitest";
import { ensureOntologyTables } from "./schema.js";
import { normalizeFieldMap, resolveBinding } from "./bindings.js";

const ATTRS = [
  { id: "a1", name: "wafer_id" },
  { id: "a2", name: "chamber_id" },
];

describe("normalizeFieldMap", () => {
  it("数组形态（元枢原样）经 attributes 还原为 属性名→物理列，键序=映射序", () => {
    const raw = [
      { attribute_id: "a1", source_column: "wafer_id" },
      { attribute_id: "a2", source_column: "chamber_id", transform: null },
    ];
    const fm = normalizeFieldMap(raw, ATTRS);
    expect(fm).toEqual({ wafer_id: "wafer_id", chamber_id: "chamber_id" });
    expect(Object.keys(fm)).toEqual(["wafer_id", "chamber_id"]);
  });
  it("Record 形态（属性名→物理列）原样直通（同一引用，无需 attributes）", () => {
    const raw = { wafer_id: "wafer_id", chamber_id: "chamber_id" };
    expect(normalizeFieldMap(raw)).toBe(raw);
    expect(normalizeFieldMap(raw, ATTRS)).toBe(raw);
  });
  it("数组形态无 attributes → 抛错（显式失败优于静默坏 SQL）", () => {
    const raw = [{ attribute_id: "a1", source_column: "wafer_id" }];
    expect(() => normalizeFieldMap(raw)).toThrow(/attributes/);
  });
  it("未知 attribute_id → 抛错（映射数据不完整）", () => {
    const raw = [{ attribute_id: "ghost", source_column: "x" }];
    expect(() => normalizeFieldMap(raw, ATTRS)).toThrow(/ghost/);
  });
  it("空数组 → 空 Record", () => {
    expect(normalizeFieldMap([], ATTRS)).toEqual({});
  });
  it("既非对象也非数组 → 抛错", () => {
    expect(() => normalizeFieldMap("wafer_id=wafer_id")).toThrow(/规范化/);
    expect(() => normalizeFieldMap(null)).toThrow(/规范化/);
  });
});

describe("resolveBinding（attributes 默认来源 = ont_attributes）", () => {
  let db: DatabaseSync;
  beforeAll(() => {
    db = new DatabaseSync(":memory:");
    ensureOntologyTables(db);
    db.prepare("INSERT INTO ont_ontologies (id, name) VALUES ('o1','ont')").run();
    db.prepare("INSERT INTO ont_entities (id, ontology_id, name) VALUES ('e1','o1','AnomWafer'), ('e2','o1','Record'), ('e3','o1','Broken')").run();
    db.prepare("INSERT INTO ont_attributes (id, entity_id, name) VALUES ('a1','e1','wafer_id'), ('a2','e1','chamber_id')").run();
    db.prepare("INSERT INTO ont_bindings VALUES ('b1','e1','ds1','v_anom_wafer','id',NULL,NULL,?,'approved')").run(
      JSON.stringify([{ attribute_id: "a1", source_column: "wafer_id" }, { attribute_id: "a2", source_column: "chamber_id" }]),
    );
    db.prepare("INSERT INTO ont_bindings VALUES ('b2','e2','ds1','v_x','id',NULL,NULL,'{\"id\":\"id\"}','approved')").run();
    db.prepare("INSERT INTO ont_bindings VALUES ('b3','e3','ds1','v_y','id',NULL,NULL,?,'approved')").run(
      JSON.stringify([{ attribute_id: "a1", source_column: "wafer_id" }]),
    );
  });
  it("数组形态默认查 ont_attributes（WHERE entity_id）还原，调用方无需传 attributes", () => {
    const b = resolveBinding(db, "e1");
    expect(b.fieldMap).toEqual({ wafer_id: "wafer_id", chamber_id: "chamber_id" });
    expect(b.table).toBe("v_anom_wafer");
    expect(b.status).toBe("approved");
  });
  it("显式 attributes 透传给 normalizeFieldMap", () => {
    const b = resolveBinding(db, "e1", [{ id: "a1", name: "wafer_id" }, { id: "a2", name: "chamber_id" }]);
    expect(b.fieldMap).toEqual({ wafer_id: "wafer_id", chamber_id: "chamber_id" });
  });
  it("Record 形态直通，不受 ont_attributes 行缺失影响", () => {
    const b = resolveBinding(db, "e2");   // e2 无 ont_attributes 行
    expect(b.fieldMap).toEqual({ id: "id" });
  });
  it("数组形态但 ont_attributes 缺该实体行 → 抛错（数据不完整显式失败）", () => {
    expect(() => resolveBinding(db, "e3")).toThrow(/a1/);
  });
});
