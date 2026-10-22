import type { DatabaseSync } from "node:sqlite";
import { buildWhere } from "./dsl.js";
import type { Filters } from "./dsl.js";
import type { Binding } from "./bindings.js";
import { MAX_ROWS, objectQuery } from "./query.js";

/**
 * 关系边（由调用方从 ont_relations 查询后传入，保持本包与 DB schema 解耦；
 * Task 7 迁移完成后即可用真实关系数据）。
 */
export type RelationEdge = {
  fromEntityId: string;
  toEntityId: string;
  sourceField: string;
  targetField: string;
};

/**
 * 沿本体关系从 fromEntity（按 fromFilters 过滤）遍历到 toEntity，返回目标对象行。
 *
 * 语义（与元枢 Python 参考实现 backend/app/services/function_runtime/executor.py
 * 的 traverse helper 同构）：
 * - 关系图双向 BFS 最短路径（无向遍历：from→to 与 to→from 的边都可走，反向时字段对调）；
 * - JOIN 只使用 relation 登记的 source_field/target_field，经各实体 fieldMap 翻译为物理列，
 *   字段未映射即抛错（`关系字段 ... 未映射到物理列`）；
 * - SQL 形如 `SELECT DISTINCT <目标 fieldMap 列> FROM <起点> a0 JOIN ... ON a{i}.x = a{i+1}.y
 *   [WHERE a0."col" op ? ...] ORDER BY aN."idColumn" LIMIT n`；
 * - WHERE 由 fromFilters 经 Task 2 buildWhere 生成后挂 `a0.` 别名前缀（? 占位与参数数组顺序保持）；
 * - LIMIT 钳制 max(1, min(truncate(limit), MAX_ROWS=200))；
 * - 同实体（from===to）直接复用 objectQuery 按起点对象查询（objectQuery 等价行）。
 *
 * 安全边界说明（评审实锤，必须知悉）：
 * - traverse 不经 executeOntologySql 通道，SQL 由本函数构造、列名全部来自受控 fieldMap，
 *   因此不存在 Task 5 评审指出的 replace `$` 未转义风险；
 * - 但需写明：executeOntologySql 的白名单门实为"无引用拒绝"——SQL 只要引用了至少一个
 *   绑定对象即放行，混合引用（绑定对象 + 未绑定物理表）会执行。任何把 traverse 产物的
 *   拼接 SQL 再交给 executeOntologySql 或用户可控 SQL 通道的调用方，都不得依赖该白名单
 *   提供隔离；
 * - 同名物理列折叠限制：目标 fieldMap 若把两个属性映射到同一物理列，行以对象形态读取时
 *   后者覆盖前者（与 objectQuery 同一限制），列序仍按 fieldMap 键序。
 */
export function traverse(
  conn: DatabaseSync,
  bindings: Record<string, Binding>,
  relations: RelationEdge[],
  fromEntity: string,
  fromFilters: Filters,
  toEntity: string,
  limit = 200,
): { columns: string[]; rows: unknown[][]; rowCount: number } {
  // 1. 同实体：直接 objectQuery 式返回（目标列=起点列，objectQuery 等价行）
  if (fromEntity === toEntity) {
    const binding = bindings[fromEntity];
    if (!binding) throw new Error(`实体 ${fromEntity} 未绑定数据源`);
    return objectQuery(conn, binding, fromFilters, limit);
  }

  // 2. 双向邻接表：每条边两个方向都入队（反向时 source/target 字段对调）；
  //    未登记字段的边跳过（与 Python 参考一致：source_field/target_field 为空的关系不可走）
  type Edge = { to: string; leftField: string; rightField: string };
  const adj: Record<string, Edge[]> = {};
  for (const rel of relations) {
    if (!rel.sourceField || !rel.targetField) continue;
    (adj[rel.fromEntityId] ??= []).push({ to: rel.toEntityId, leftField: rel.sourceField, rightField: rel.targetField });
    (adj[rel.toEntityId] ??= []).push({ to: rel.fromEntityId, leftField: rel.targetField, rightField: rel.sourceField });
  }

  // 3. BFS 最短路径：出队即检查命中；入队时标记 seen（首达即最短），hops 随队携带即回溯结果
  type Hop = { node: string; leftField: string; next: string; rightField: string };
  const queue: [string, Hop[]][] = [[fromEntity, []]];
  const seen = new Set<string>([fromEntity]);
  let path: Hop[] | null = null;
  while (queue.length) {
    const [node, hops] = queue.shift()!;
    if (node === toEntity && hops.length) { path = hops; break; }
    for (const edge of adj[node] ?? []) {
      if (seen.has(edge.to)) continue;
      seen.add(edge.to);
      queue.push([edge.to, [...hops, { node, leftField: edge.leftField, next: edge.to, rightField: edge.rightField }]]);
    }
  }
  if (!path) {
    throw new Error(`对象 ${fromEntity} 到 ${toEntity} 之间没有登记字段映射的关系路径`);
  }

  // 4. 编译：别名 a0..aN；hop 字段经各自 fieldMap 翻译物理列，未映射抛错
  const nodeIds = [fromEntity, ...path.map(h => h.next)];
  const nodeBindings = nodeIds.map(id => {
    const b = bindings[id];
    if (!b) throw new Error(`遍历路径上的实体 ${id} 未绑定数据源，无法编译 JOIN`);
    return b;
  });
  // 绑定数据源：source_sql 语义与 objectQuery 一致（子查询括号包裹），否则物理表
  const nodeSources = nodeBindings.map(b => (b.sourceSql ? `(${b.sourceSql})` : `"${b.table}"`));
  // noUncheckedIndexedAccess 收窄——nodeBindings 各元素已在 map 内校验非空，此守卫实际不可达
  const srcBinding = nodeBindings[0];
  const targetBinding = nodeBindings[path.length];
  if (!srcBinding || !targetBinding) throw new Error("遍历路径实体绑定缺失");
  const targetAlias = `a${path.length}`;
  const selectParts = Object.entries(targetBinding.fieldMap)
    .map(([attr, col]) => `${targetAlias}."${col}" AS "${attr}"`);
  if (selectParts.length === 0) throw new Error("对象没有可查询的已映射属性");
  const sqlParts = [`SELECT DISTINCT ${selectParts.join(", ")} FROM ${nodeSources[0]} a0`];
  path.forEach((hop, i) => {
    const leftCol = nodeBindings[i]?.fieldMap[hop.leftField];
    const rightCol = nodeBindings[i + 1]?.fieldMap[hop.rightField];
    if (!leftCol || !rightCol) {
      throw new Error(`关系字段 ${hop.leftField}/${hop.rightField} 未映射到物理列，无法遍历`);
    }
    sqlParts.push(`JOIN ${nodeSources[i + 1]} a${i + 1} ON a${i}."${leftCol}" = a${i + 1}."${rightCol}"`);
  });

  // 5. WHERE：复用 Task 2 buildWhere（列引用形如 "col"），挂 a0. 别名前缀；
  //    占位符 ? 与参数数组顺序保持；buildWhere 的 1 = 0 / 1 = 1 恒等片段不加前缀
  const { where, params } = buildWhere(srcBinding.fieldMap, fromFilters);
  let sql = sqlParts.join(" ");
  const prefixed = where.map(w => (w.startsWith('"') ? `a0.${w}` : w));
  if (prefixed.length) sql += " WHERE " + prefixed.join(" AND ");
  // 目标实体 idColumn 排序（与 golden `ORDER BY t.id` 及 objectQuery 的 ORDER BY 语义对齐）
  if (targetBinding.idColumn) sql += ` ORDER BY ${targetAlias}."${targetBinding.idColumn}"`;

  // 6. LIMIT：max(1, min(truncate(limit), 200))；非有限数回退默认 200
  const n = Math.trunc(Number(limit));
  const lim = Math.max(1, Math.min(Number.isFinite(n) ? n : 200, MAX_ROWS));
  sql += ` LIMIT ${lim}`;

  // 7. 返回按目标实体 fieldMap 列序的 rows: unknown[][]（占位参数按位置绑定）
  const columns = Object.keys(targetBinding.fieldMap);
  const stmt = conn.prepare(sql);
  const raw = stmt.all(...(params as Parameters<typeof stmt.all>)) as Record<string, unknown>[];
  const rows = raw.map(r => columns.map(c => r[c] ?? null));
  return { columns, rows, rowCount: rows.length };
}
