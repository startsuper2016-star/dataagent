import type { DatabaseSync } from "node:sqlite";

export type Binding = {
  datasourceId: string;
  table: string;
  idColumn: string;
  fieldMap: Record<string, string>;
  sourceSql?: string;
  status: string;
};

export function resolveBinding(db: DatabaseSync, entityId: string): Binding {
  const row = db.prepare(
    "SELECT datasource_id, table_name, id_column, source_sql, field_mappings_json, status FROM ont_bindings WHERE entity_id = ? AND status = 'approved'",
  ).get(entityId) as Record<string, unknown> | undefined;
  if (!row) throw new Error(`实体 ${entityId} 未绑定活动数据源`);
  const fieldMap = JSON.parse(String(row.field_mappings_json ?? "{}")) as Record<string, string>;
  return {
    datasourceId: String(row.datasource_id),
    table: String(row.table_name),
    idColumn: String(row.id_column ?? "id"),
    fieldMap,
    sourceSql: row.source_sql ? String(row.source_sql) : undefined,
    status: String(row.status),
  };
}
