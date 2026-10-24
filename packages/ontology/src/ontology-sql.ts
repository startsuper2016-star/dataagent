import type { DatabaseSync } from "node:sqlite";
import { bindParams } from "./inline-params.js";
import type { Binding } from "./bindings.js";

export function rewriteObjectNames(
  sql: string, nameToTable: Record<string, string>,
): { sql: string; referenced: string[] } {
  let out = sql;
  const referenced: string[] = [];
  for (const [name, table] of Object.entries(nameToTable).sort(([a], [b]) => b.length - a.length)) {
    const re = new RegExp(`(?<![\\p{L}\\p{N}_.])${name}(?![\\p{L}\\p{N}_])`, "gu");
    if (re.test(out)) { referenced.push(name); out = out.replace(re, table); }
  }
  return { sql: out, referenced };
}

export function executeOntologySql(
  conn: DatabaseSync, bindings: Record<string, Binding>,
  sql: string, params: Record<string, unknown> = {},
): { columns: string[]; rows: unknown[][]; rowCount: number } {
  const nameToTable: Record<string, string> = {};
  // bindings 键=实体名：仅重建 实体名→物理表 映射（长名优先由 rewriteObjectNames 排序保证）
  for (const [entity, b] of Object.entries(bindings)) nameToTable[entity] = b.table;
  const { sql: rewritten, referenced } = rewriteObjectNames(sql, nameToTable);
  if (referenced.length === 0) throw new Error("SQL 未引用任何本体对象（白名单拒绝执行）");
  // P3-3：字面量感知的 `:pN` → `?` 改写 + 原生参数绑定（替代 Phase 1 的字面量内联）
  const bound = bindParams(rewritten, params);
  const stmt = conn.prepare(bound.sql);
  const columns = stmt.columns().map(c => c.name);
  // node:sqlite 默认行形态是对象（同名列会折叠）；按列序还原为数组形态契约
  const raw = stmt.all(...(bound.values as never[])) as Record<string, unknown>[];
  const rows = raw.map(r => columns.map(c => r[c]));
  return { columns, rows, rowCount: rows.length };
}
