import type { DatabaseSync } from "node:sqlite";
import { buildWhere } from "./dsl.js";
import type { Filters } from "./dsl.js";
import type { Binding } from "./bindings.js";

export const MAX_ROWS = 200;

export function objectQuery(
  conn: DatabaseSync,
  binding: Binding,
  filters: Filters,
  limit = 20,
  offset = 0,
): { columns: string[]; rows: unknown[][]; rowCount: number } {
  const cols = Object.keys(binding.fieldMap);
  if (cols.length === 0) throw new Error("对象没有可查询的已映射属性");
  const select = cols.map(c => `"${binding.fieldMap[c]}" AS "${c}"`).join(", ");
  const source = binding.sourceSql ? `(${binding.sourceSql})` : `"${binding.table}"`;
  const { where, params } = buildWhere(binding.fieldMap, filters);
  let sql = `SELECT ${select} FROM ${source}`;
  if (where.length) sql += " WHERE " + where.join(" AND ");
  if (binding.idColumn) sql += ` ORDER BY "${binding.idColumn}"`;
  const lim = Math.max(1, Math.min(Math.trunc(Number(limit)) || 20, MAX_ROWS));
  const off = Math.max(0, Math.trunc(Number(offset)) || 0);
  sql += ` LIMIT ${lim} OFFSET ${off}`;
  const rows = (conn.prepare(sql).all(...params) as Record<string, unknown>[])
    .map(r => cols.map(c => r[c] ?? null));
  return { columns: cols, rows, rowCount: rows.length };
}
