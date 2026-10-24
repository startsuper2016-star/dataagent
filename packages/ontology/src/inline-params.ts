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
 * 评审加固（P3-3 follow-up）：
 * - `--` 行注释与 `/* *\/` 块注释按原样拷贝（注释里的 `:pN` 改写会吞占位符，
 *   使合法 SQL 在 bind/step 阶段以晦涩的 out-of-range 报错被误拒）；
 * - 双引号标识符（`"col:p1"`）同样按不透明 span 拷贝；
 * - 未登记键（如 `:x1`）在扫描时直接抛错（fail-closed 前移：SQLite 对未知命名参数
 *   prepare 不报错、bind/step 才抛 out-of-range，驱动报错不含键名，可诊断性差）。
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
    if (ch === "'" || ch === '"' || ch === "`") {
      // 字符串字面量/带引号标识符（SQLite 双引号与反引号两种引用）整体按不透明 span 拷贝（'' 为转义引号）
      out += ch;
      i += 1;
      while (i < sql.length) {
        if (sql[i] === ch && sql[i + 1] === ch) {
          out += ch + ch;
          i += 2;
          continue;
        }
        out += sql[i];
        const closed = sql[i] === ch;
        i += 1;
        if (closed) break;
      }
      continue;
    }
    if (ch === "-" && sql[i + 1] === "-") {
      // 行注释：拷贝到行尾
      const end = sql.indexOf("\n", i);
      if (end === -1) {
        out += sql.slice(i);
        break;
      }
      out += sql.slice(i, end);
      i = end;
      continue;
    }
    if (ch === "/" && sql[i + 1] === "*") {
      // 块注释：拷贝到 */（未闭合则拷贝到尾）
      const end = sql.indexOf("*/", i + 2);
      if (end === -1) {
        out += sql.slice(i);
        break;
      }
      out += sql.slice(i, end + 2);
      i = end + 2;
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
      const unregistered = /^[\p{L}_][\p{L}\p{N}_]*/u.exec(rest);
      if (unregistered) {
        throw new Error(`SQL 引用了未登记的命名参数 :${unregistered[0]}（登记键：${keys.join("、") || "无"}）`);
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
