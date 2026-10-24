import type { DatabaseSync } from "node:sqlite";

/**
 * P3-1 — OntologyContextClient 的 apps/api 实现：直接读 workbench 库 ont_* 表。
 *
 * 语义（与 /api/v1/ontology/context 同口径，多一层 datasource 收敛）：
 * - bindings：该数据源上 approved 的绑定（entity/table/id_column/field_mappings）；
 *   数据源无本体建模 → 返回 null（链上视为 ONTOLOGY_NOT_CONFIGURED，落回 datalink）；
 * - relations：两端实体都在该数据源上有 approved 绑定的关系边；
 * - functions：active 的本体函数（callable/schema）。
 *
 * 同步 sqlite 读取，包成 Promise 满足 agent-runtime 的异步契约；查询轻量（元数据行），
 * 不做缓存——绑定审批/发布后下一个 run 立即生效。
 */
export const createOntologyContextClient = (getDb: () => DatabaseSync) => ({
  async loadContext(datasourceId: string): Promise<unknown | null> {
    const db = getDb();
    const bindings = db
      .prepare(
        `SELECT e.name AS entity, b.table_name AS "table", b.id_column AS id_column,
                b.field_mappings_json AS field_mappings
         FROM ont_bindings b JOIN ont_entities e ON e.id = b.entity_id
         WHERE b.datasource_id = ? AND b.status = 'approved' ORDER BY e.name`
      )
      .all(datasourceId) as unknown[];
    if (bindings.length === 0) {
      return null;
    }
    const relations = db
      .prepare(
        `SELECT r.name AS name, ef.name AS from_entity, et.name AS to_entity,
                r.cardinality AS cardinality, r.source_field AS source_field,
                r.target_field AS target_field
         FROM ont_relations r
         JOIN ont_entities ef ON ef.id = r.from_entity_id
         JOIN ont_entities et ON et.id = r.to_entity_id
         WHERE EXISTS (
           SELECT 1 FROM ont_bindings bf
           WHERE bf.entity_id = r.from_entity_id AND bf.datasource_id = ? AND bf.status = 'approved'
         ) AND EXISTS (
           SELECT 1 FROM ont_bindings bt
           WHERE bt.entity_id = r.to_entity_id AND bt.datasource_id = ? AND bt.status = 'approved'
         )
         ORDER BY ef.name, r.name`
      )
      .all(datasourceId, datasourceId) as unknown[];
    const functions = (
      db
        .prepare(
          "SELECT callable_name, description, input_schema_json FROM ont_functions WHERE status = 'active' ORDER BY callable_name"
        )
        .all() as Array<Record<string, unknown>>
    ).map((row) => ({
      callable_name: row.callable_name,
      description: row.description,
      input_schema:
        typeof row.input_schema_json === "string"
          ? safeJsonParse(row.input_schema_json)
          : row.input_schema_json
    }));
    return { bindings, relations, functions };
  }
});

const safeJsonParse = (raw: string): unknown => {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
};
