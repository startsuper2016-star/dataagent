import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { ensureOntologyTables } from "./schema.js";

const ONT_TABLES = ["ont_ontologies","ont_entities","ont_attributes","ont_relations",
  "ont_bindings","ont_functions","ont_rules","ont_actions","ont_action_runs","ont_skill_bindings","ont_versions","ont_version_entities"];

describe("ensureOntologyTables", () => {
  it("creates all ont_* tables", () => {
    const db = new DatabaseSync(":memory:");
    ensureOntologyTables(db);
    const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'ont_%'").all() as {name:string}[];
    expect(rows.map(r => r.name).sort()).toEqual([...ONT_TABLES].sort());
  });
  it("is idempotent", () => {
    const db = new DatabaseSync(":memory:");
    ensureOntologyTables(db);
    expect(() => ensureOntologyTables(db)).not.toThrow();
  });
  it("ont_bindings column set", () => {
    const db = new DatabaseSync(":memory:");
    ensureOntologyTables(db);
    const cols = db.prepare("PRAGMA table_info(ont_bindings)").all() as {name:string}[];
    expect(cols.map(c => c.name)).toEqual(["id","entity_id","datasource_id","table_name","id_column",
      "filter_expr","source_sql","field_mappings_json","status"]);
  });
});
