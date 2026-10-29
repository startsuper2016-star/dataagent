import type { DatabaseSync } from "node:sqlite";
import { bindParams } from "./inline-params.js";
import type { Binding } from "./bindings.js";

/**
 * 对象名改写（P3-4 加固）：字符串字面量（''）、带引号标识符（"" / ``）与
 * -- / /** 注释按不透明 span 原样拷贝——span 内出现的实体名不改写（旧实现的全局
 * 正则会把注释/字面量里的名字误替换成物理表，既破坏语义又击穿白名单门的判定）。
 * 改写只发生在纯文本段；长名优先（:p12 不被 :p1 吃掉的同款排序保证）。
 */
export function rewriteObjectNames(
  sql: string, nameToTable: Record<string, string>,
): { sql: string; referenced: string[] } {
  const resolvers = Object.entries(nameToTable)
    .sort(([a], [b]) => b.length - a.length)
    .map(([name, table]) => ({
      name,
      table,
      re: new RegExp(`(?<![\\p{L}\\p{N}_.])${name}(?![\\p{L}\\p{N}_])`, "gu"),
    }));
  const referenced = new Set<string>();
  let out = "";
  let plain = "";
  const flushPlain = (): void => {
    if (!plain) return;
    for (const r of resolvers) {
      r.re.lastIndex = 0;
      if (r.re.test(plain)) {
        referenced.add(r.name);
        r.re.lastIndex = 0;
        plain = plain.replace(r.re, r.table);
      }
    }
    out += plain;
    plain = "";
  };
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i]!;
    if (ch === "'" || ch === '"' || ch === "`") {
      // 字面量/带引号标识符整体不透明（'' 为转义引号）
      flushPlain();
      out += ch;
      i += 1;
      while (i < sql.length) {
        if (sql[i] === ch && sql[i + 1] === ch) {
          out += ch + ch;
          i += 2;
          continue;
        }
        out += sql[i]!;
        const closed = sql[i] === ch;
        i += 1;
        if (closed) break;
      }
      continue;
    }
    if (ch === "-" && sql[i + 1] === "-") {
      // 行注释：拷贝到行尾
      flushPlain();
      const end = sql.indexOf("\n", i);
      if (end === -1) {
        out += sql.slice(i);
        i = sql.length;
        continue;
      }
      out += sql.slice(i, end);
      i = end;
      continue;
    }
    if (ch === "/" && sql[i + 1] === "*") {
      // 块注释：拷贝到 */（未闭合则拷贝到尾）
      flushPlain();
      const end = sql.indexOf("*/", i + 2);
      if (end === -1) {
        out += sql.slice(i);
        i = sql.length;
        continue;
      }
      out += sql.slice(i, end + 2);
      i = end + 2;
      continue;
    }
    plain += ch;
    i += 1;
  }
  flushPlain();
  return { sql: out, referenced: [...referenced] };
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
