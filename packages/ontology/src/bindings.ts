import type { DatabaseSync } from "node:sqlite";

export type Binding = {
  datasourceId: string;
  table: string;
  idColumn: string;
  fieldMap: Record<string, string>;
  sourceSql?: string | undefined;
  status: string;
};

/** ont_attributes 行投影：attribute_id → 属性名 的还原依据（与表列 id/name 对应）。 */
export type AttributeRef = { id: string; name: string };

/** 元枢 object_bindings.field_mappings 原样条目（迁移契约"原样拷贝"的数组形态）。 */
type YuanShuMapping = { attribute_id?: unknown; source_column?: unknown };

/**
 * fieldMap 规范化：把 ont_bindings.field_mappings_json 的两种形态统一为 Record<属性名, 物理列>。
 *
 * - Record 形态（属性名→物理列，手工契约 fixture）：原样直通（同一引用）；
 * - 数组形态（元枢原样拷贝 `[{attribute_id, source_column, transform?}]`）：经 attributes
 *   （ont_attributes 的 [{id, name}]）把 attribute_id 还原为属性名，键序 = 元枢映射序；
 * - 数组形态而 attributes 缺省（undefined）→ 抛错：显式失败优于静默坏 SQL——直通数组会让
 *   fieldMap 的键变成数组下标，objectQuery/traverse 生成坏 SQL（phase1 T8 验收发现并上报）；
 * - attribute_id 在 attributes 中找不到 → 抛错（映射数据不完整，不得静默丢列）；
 * - 空数组 → 空 Record（objectQuery 对空 fieldMap 有既有守卫，会在查询时响亮失败）。
 *
 * transform 字段在迁移数据中原样存在，但本层不消费——列对齐验收已证 属性名==物理列，
 * 无转换需求；若未来引入，应在此处显式扩展而非上层猜测。
 */
export function normalizeFieldMap(raw: unknown, attributes?: AttributeRef[]): Record<string, string> {
  if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Record<string, string>;
  }
  if (Array.isArray(raw)) {
    if (attributes === undefined) {
      throw new Error("field_mappings_json 是元枢数组形态但未提供 attributes（ont_attributes id→name），拒绝静默生成坏 fieldMap");
    }
    const nameById = new Map<string, string>(attributes.map(a => [a.id, a.name]));
    const fieldMap: Record<string, string> = {};
    for (const entry of raw) {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
        throw new Error(`field_mappings_json 数组条目不是对象: ${JSON.stringify(entry)}`);
      }
      const m = entry as YuanShuMapping;
      if (typeof m.attribute_id !== "string" || typeof m.source_column !== "string") {
        throw new Error(`field_mappings_json 条目缺 attribute_id/source_column 字符串: ${JSON.stringify(entry)}`);
      }
      const attrName = nameById.get(m.attribute_id);
      if (attrName === undefined) {
        throw new Error(`映射的 attribute_id ${m.attribute_id} 在 attributes 中不存在（映射数据不完整）`);
      }
      fieldMap[attrName] = m.source_column;
    }
    return fieldMap;
  }
  throw new Error(`field_mappings_json 既非对象也非数组，无法规范化: ${JSON.stringify(raw)}`);
}

/**
 * resolveBinding：读实体 approved 绑定的行级事实（datasource/table/id_column/source_sql/status），
 * fieldMap 一律经 normalizeFieldMap 规范化为 属性名→物理列。
 *
 * attributes 默认来源是本库 ont_attributes（`SELECT id, name FROM ont_attributes WHERE entity_id = ?`）
 * —— db 句柄在手，调用方无需重复查询；仅当解析结果确为数组形态（需要还原）时才查询，
 * Record 形态直通不受 ont_attributes 行存在性影响。调用方显式传入 attributes 时原样透传。
 */
export function resolveBinding(db: DatabaseSync, entityId: string, attributes?: AttributeRef[]): Binding {
  const row = db.prepare(
    "SELECT datasource_id, table_name, id_column, source_sql, field_mappings_json, status FROM ont_bindings WHERE entity_id = ? AND status = 'approved'",
  ).get(entityId) as Record<string, unknown> | undefined;
  if (!row) throw new Error(`实体 ${entityId} 未绑定活动数据源`);
  const parsed: unknown = JSON.parse(String(row.field_mappings_json ?? "{}"));
  const attrs = attributes ?? (Array.isArray(parsed) ? defaultAttributes(db, entityId) : undefined);
  return {
    datasourceId: String(row.datasource_id),
    table: String(row.table_name),
    idColumn: String(row.id_column ?? "id"),
    fieldMap: normalizeFieldMap(parsed, attrs),
    sourceSql: row.source_sql ? String(row.source_sql) : undefined,
    status: String(row.status),
  };
}

function defaultAttributes(db: DatabaseSync, entityId: string): AttributeRef[] {
  return db.prepare("SELECT id, name FROM ont_attributes WHERE entity_id = ?").all(entityId) as AttributeRef[];
}
