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
