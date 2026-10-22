export type Filters = Record<string, unknown>;
export const FILTER_OPS = ["eq","neq","gt","gte","lt","lte","like","not_like","in","not_in","is_null","not_null"] as const;
export type Op = (typeof FILTER_OPS)[number];
const OP_SQL: Record<string, string> = { eq: "=", neq: "<>", gt: ">", gte: ">=", lt: "<", lte: "<=", like: "LIKE", not_like: "NOT LIKE" };

export function* iterFilterConditions(filters: Filters): Generator<[string, Op, unknown]> {
  for (const [name, value] of Object.entries(filters ?? {})) {
    if (value !== null && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length > 0) {
      const unknown = Object.keys(value).filter(k => !FILTER_OPS.includes(k as Op)).sort();
      if (unknown.length) throw new Error(`不支持的过滤操作符: ${unknown.join(", ")}`);
      for (const [op, v] of Object.entries(value)) yield [name, op as Op, v];
    } else {
      yield [name, "eq", value];
    }
  }
}

export function likeToRegex(pattern: string): RegExp {
  const body = [...pattern].map(ch => ch === "%" ? ".*" : ch === "_" ? "." : ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("");
  return new RegExp(`^${body}$`, "i");   // SQLite LIKE 默认 ASCII 不敏感
}

function isComparable(a: unknown, b: unknown): boolean {
  return (typeof a === "number" && typeof b === "number") || (typeof a === "string" && typeof b === "string");
}

export function matchSingle(value: unknown, op: Op, cond: unknown): boolean {
  if (op === "is_null") return value === null || value === undefined;
  if (op === "not_null") return !(value === null || value === undefined);
  if (value === null || value === undefined) return false;
  switch (op) {
    case "eq": return value === cond;
    case "neq": return value !== cond;
    case "gt": case "gte": case "lt": case "lte": {
      if (!isComparable(value, cond)) throw new Error(`'<' not supported between instances of '${typeof value}' and '${typeof cond}'`);
      const v = value as string | number, c = cond as string | number;
      return op === "gt" ? v > c : op === "gte" ? v >= c : op === "lt" ? v < c : v <= c;
    }
    case "in": return (Array.isArray(cond) ? cond : [cond]).includes(value as never);
    case "not_in": return !(Array.isArray(cond) ? cond : [cond]).includes(value as never);
    case "like": return likeToRegex(String(cond)).test(String(value));
    case "not_like": return !likeToRegex(String(cond)).test(String(value));
    default: throw new Error(`不支持的过滤操作符: ${op}`);
  }
}

export function matchFilterValue(value: unknown, condition: unknown): boolean {
  if (condition !== null && typeof condition === "object" && !Array.isArray(condition) && Object.keys(condition).length > 0) {
    const unknown = Object.keys(condition).filter(k => !FILTER_OPS.includes(k as Op)).sort();
    if (unknown.length) throw new Error(`不支持的过滤操作符: ${unknown.join(", ")}`);
    return Object.entries(condition).every(([op, v]) => matchSingle(value, op as Op, v));
  }
  return matchSingle(value, "eq", condition);
}

// 位置参数形态（? + unknown[]）：node:sqlite prepare 位置绑定最简且无键冲突面。
// named 形态（:pN）留给 inlineParams 的 SQL 内联场景。
export function buildWhere(fieldMap: Record<string, string>, filters: Filters): { where: string[]; params: unknown[] } {
  const where: string[] = [];
  const params: unknown[] = [];
  for (const [attr, op, value] of iterFilterConditions(filters)) {
    const col = fieldMap[attr];
    if (!col) throw new Error(`属性未定义或未绑定: ${attr}`);
    const quoted = `"${col}"`;
    if (op === "is_null") { where.push(`${quoted} IS NULL`); continue; }
    if (op === "not_null") { where.push(`${quoted} IS NOT NULL`); continue; }
    if (op === "in" || op === "not_in") {
      const values = Array.isArray(value) ? value : [value];
      if (values.length === 0) { where.push(op === "in" ? "1 = 0" : "1 = 1"); continue; }
      where.push(`${quoted} ${op === "in" ? "IN" : "NOT IN"} (${values.map(() => "?").join(", ")})`);
      params.push(...values);
      continue;
    }
    where.push(`${quoted} ${OP_SQL[op]} ?`);
    params.push(value);
  }
  return { where, params };
}
