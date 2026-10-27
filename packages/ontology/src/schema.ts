import type { DatabaseSync } from "node:sqlite";

const DDL = [
  `CREATE TABLE IF NOT EXISTS ont_ontologies (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, code TEXT, description TEXT)`,
  `CREATE TABLE IF NOT EXISTS ont_entities (
    id TEXT PRIMARY KEY, ontology_id TEXT NOT NULL REFERENCES ont_ontologies(id),
    name TEXT NOT NULL, name_cn TEXT, tier INTEGER DEFAULT 2, status TEXT DEFAULT 'draft',
    description TEXT, config_json TEXT)`,
  `CREATE TABLE IF NOT EXISTS ont_attributes (
    id TEXT PRIMARY KEY, entity_id TEXT NOT NULL REFERENCES ont_entities(id),
    name TEXT NOT NULL, display_name TEXT, type TEXT DEFAULT 'string',
    required INTEGER DEFAULT 0, description TEXT, sort INTEGER DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS ont_relations (
    id TEXT PRIMARY KEY, from_entity_id TEXT NOT NULL, to_entity_id TEXT NOT NULL,
    name TEXT NOT NULL, rel_type TEXT DEFAULT 'has_many', cardinality TEXT DEFAULT '1:N',
    source_field TEXT, target_field TEXT, description TEXT)`,
  `CREATE TABLE IF NOT EXISTS ont_bindings (
    id TEXT PRIMARY KEY, entity_id TEXT NOT NULL, datasource_id TEXT NOT NULL,
    table_name TEXT, id_column TEXT, filter_expr TEXT, source_sql TEXT,
    field_mappings_json TEXT, status TEXT DEFAULT 'draft')`,
  `CREATE TABLE IF NOT EXISTS ont_functions (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, callable_name TEXT NOT NULL,
    description TEXT, input_schema_json TEXT, entity_id TEXT, entity_ids_json TEXT,
    runtime TEXT DEFAULT 'ontology-logic', status TEXT DEFAULT 'active', tags_json TEXT)`,
  `CREATE TABLE IF NOT EXISTS ont_skill_bindings (
    id TEXT PRIMARY KEY, skill_id TEXT NOT NULL, version INTEGER NOT NULL,
    skill_name TEXT, entity_ids_json TEXT)`,
  `CREATE TABLE IF NOT EXISTS ont_rules (
    id TEXT PRIMARY KEY, entity_id TEXT NOT NULL REFERENCES ont_entities(id),
    name TEXT NOT NULL, rule_type TEXT DEFAULT 'inference', carrier TEXT,
    conditions_json TEXT, conclusion TEXT, enabled INTEGER DEFAULT 1,
    description TEXT, created_at TEXT, updated_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS ont_actions (
    id TEXT PRIMARY KEY, entity_id TEXT NOT NULL REFERENCES ont_entities(id),
    code TEXT NOT NULL, name TEXT NOT NULL, executor TEXT DEFAULT 'sql',
    config_json TEXT, risk TEXT DEFAULT 'LOW', discovery TEXT DEFAULT 'confirm',
    intent TEXT, params_json TEXT, enabled INTEGER DEFAULT 1,
    description TEXT, created_at TEXT, updated_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS ont_action_runs (
    id TEXT PRIMARY KEY, action_id TEXT NOT NULL REFERENCES ont_actions(id),
    status TEXT NOT NULL DEFAULT 'succeeded', params_json TEXT,
    row_count INTEGER, error TEXT, duration_ms INTEGER, created_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS ont_versions (
    id TEXT PRIMARY KEY, ontology_id TEXT NOT NULL, version_number INTEGER NOT NULL,
    status TEXT DEFAULT 'draft', name TEXT, description TEXT,
    config_snapshot_json TEXT, created_at TEXT, submitted_at TEXT, published_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS ont_version_entities (
    version_id TEXT NOT NULL, version_entity_id TEXT PRIMARY KEY,
    source_entity_id TEXT NOT NULL)`,
];

export function ensureOntologyTables(db: DatabaseSync): void {
  for (const ddl of DDL) db.exec(ddl);
}
