export function inlineParams(sql: string, params: Record<string, unknown>): string {
  for (const key of Object.keys(params)) {
    if (!/^p\d+(_\d+)?$/.test(key)) throw new Error(`参数键名不合法: ${key}（必须为 p<N>[_<M>]）`);
  }
  const entries = Object.entries(params);
  if (entries.length === 0) return sql;
  const re = new RegExp(`:(?:${entries.map(([k]) => k).join("|")})\\b`, "g");
  return sql.replace(re, (token) => {
    const key = token.slice(1);
    if (!(key in params)) return token;
    const v = params[key];
    if (v === null || v === undefined) return "NULL";
    if (typeof v === "number") {
      if (!Number.isFinite(v)) return `'${String(v)}'`;
      return String(v);
    }
    if (typeof v === "boolean") return v ? "1" : "0";
    return `'${String(v).replace(/'/g, "''")}'`;
  });
}

/**
 * P3-3 加固 — 字符串字面量感知的参数绑定：把字面量外的 `:pN` 改写为位置占位符 `?`，
 * 值按出现顺序收集，走 SQLite 原生绑定（替代 executeOntologySql 的字面量内联通道）。
 *
 * 相比 inlineParams 修正两点：
 * - 引号内 `:pN` 不再被误替换（inlineParams 的 `'a:p1'` 会污染值）；
 * - 数值/字符串由驱动绑定，消除类型感知转义这一层自担的注入面。
 *
 * 未登记键（如 `:x1`）原样保留 → prepare 阶段报错（fail-closed，与 inlineParams 一致）。
 */
export function bindParams(
  sql: string,
  params: Record<string, unknown>
): { sql: string; values: unknown[] } {
  for (const key of Object.keys(params)) {
    if (!/^p\d+(_\d+)?$/.test(key)) throw new Error(`参数键名不合法: ${key}（必须为 p<N>[_<M>]）`);
  }
  // 长键优先：`:p12` 不能被 `p1` 吃掉前缀
  const keys = Object.keys(params).sort((a, b) => b.length - a.length);
  const values: unknown[] = [];
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    if (ch === "'") {
      // 字符串字面量原样拷贝（'' 为转义引号）
      out += ch;
      i += 1;
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") {
          out += "''";
          i += 2;
          continue;
        }
        out += sql[i];
        const closed = sql[i] === "'";
        i += 1;
        if (closed) break;
      }
      continue;
    }
    if (ch === ":") {
      const rest = sql.slice(i + 1);
      const key = keys.find(
        (k) => rest.startsWith(k) && !/[\p{L}\p{N}_]/u.test(rest[k.length] ?? "")
      );
      if (key) {
        values.push(normalizeBindValue(params[key]));
        out += "?";
        i += 1 + key.length;
        continue;
      }
    }
    out += ch;
    i += 1;
  }
  return { sql: out, values };
}

const normalizeBindValue = (v: unknown): unknown => {
  if (v === undefined) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  return v;
};
