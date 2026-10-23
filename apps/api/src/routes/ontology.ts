import type { IncomingMessage } from "node:http";
import { DatabaseSync } from "node:sqlite";
import {
  createErrorResult,
  createSuccessResult,
  type AppErrorCode
} from "@datafoundry/contracts";
import {
  executeOntologySql,
  objectQuery,
  resolveBinding,
  traverse,
  type Binding,
  type Filters,
  type RelationEdge
} from "@datafoundry/ontology";

import type { ConfigApiContext, ConfigApiResponse } from "./types.js";

/**
 * Phase 1-B Task 4 — 本体 REST 面（/api/v1/ontology/*）。
 *
 * 设计边界（与侦查事实对齐）：
 * - 本路由在 server.ts resolveRequestAuth 之后经 config-api 分发链执行，Bearer/session 均可；
 * - 保持薄：语义全部复用 @datafoundry/ontology（objectQuery/executeOntologySql/traverse/
 *   resolveBinding），路由只做 参数解包 → 实体名→id → 连接获取 → 结果包装；
 * - 元数据（ont_* 表）经 context.metadataStore.db（workbench 句柄；ont_* 与 metadataStore
 *   同库，由本包 ensureOntologyTables 建立）；数据连接经 data_sources 行 SPC_MVP_SQLITE
 *   的 config_json.path 打开（path→conn 模块级缓存，路径变更即自然重建）。
 *
 * 端点（全部只读，不暴露写路径；数据连接以 readOnly 打开作第二道防线）：
 * - POST /api/v1/ontology/query    {entity, filters?, limit?, offset?} → {columns, rows, rowCount}
 * - POST /api/v1/ontology/sql      {sql, params?}                      → {columns, rows, rowCount}
 * - POST /api/v1/ontology/traverse {fromEntity, fromFilters?, toEntity, limit?} → {columns, rows, rowCount}
 * - GET  /api/v1/ontology/bindings                                     → {bindings: [{entity, table, status}]}
 *
 * 错误约定：未知实体/缺参数/坏 JSON/SQL 白名单拒绝 → 400；实体无 approved 绑定、关系路径
 * 不存在、SPC 数据源缺失、未知端点 → 404；其余（含数据侧打开失败/元数据损坏）→ 500。
 */

/** 路由只消费 metadataStore + userId；结构化子集让 handler 级测试免搭全套网关依赖。 */
export type OntologyRouteContext = Pick<ConfigApiContext, "metadataStore" | "userId">;

const SPC_DATASOURCE_NAME = "SPC_MVP_SQLITE";
const MAX_JSON_BODY_BYTES = 1024 * 1024;

/**
 * 数据连接缓存：path → DatabaseSync。数据源行改指新库（新 path）即自然重建连接；
 * 旧连接不主动关闭（MVP：数据源路径变更是罕见运维动作，进程生命周期内容忍少量悬挂句柄）。
 */
const connectionsByPath = new Map<string, DatabaseSync>();

/** 关闭并清空全部缓存连接（测试隔离用；也供将来的运维停机钩子复用）。 */
export const closeCachedOntologyConnections = (): void => {
  for (const conn of connectionsByPath.values()) {
    conn.close();
  }
  connectionsByPath.clear();
};

class OntologyHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: AppErrorCode,
    message: string
  ) {
    super(message);
    this.name = "OntologyHttpError";
  }
}

export const handleOntologyRequest = async (
  request: IncomingMessage,
  method: string | undefined,
  subPath: string[],
  context: OntologyRouteContext
): Promise<ConfigApiResponse> => {
  try {
    switch (subPath[0] ?? "") {
      case "query":
        return await handleQuery(request, method, context);
      case "sql":
        return await handleSql(request, method, context);
      case "traverse":
        return await handleTraverse(request, method, context);
      case "bindings":
        return handleBindings(method, context.metadataStore.db);
      case "context":
        return handleContext(method, context.metadataStore.db);
      default:
        throw new OntologyHttpError(404, "RESOURCE_NOT_FOUND", `未知本体端点: ${subPath[0] ?? ""}`);
    }
  } catch (error) {
    return ontologyErrorResponse(error);
  }
};

const handleQuery = async (
  request: IncomingMessage,
  method: string | undefined,
  context: OntologyRouteContext
): Promise<ConfigApiResponse> => {
  requireMethod(method, "POST");
  const body = await readJsonBody(request);
  const entityName = stringValue(body.entity);
  if (!entityName) {
    throw new OntologyHttpError(400, "BAD_REQUEST", "缺少 entity");
  }
  const db = context.metadataStore.db;
  const binding = resolveBinding(db, requireEntityId(db, entityName));
  const conn = openSpcConnection(context.metadataStore, context.userId);
  return ok(
    objectQuery(conn, binding, filtersOf(body), numberValue(body.limit) ?? 20, numberValue(body.offset) ?? 0)
  );
};

const handleSql = async (
  request: IncomingMessage,
  method: string | undefined,
  context: OntologyRouteContext
): Promise<ConfigApiResponse> => {
  requireMethod(method, "POST");
  const body = await readJsonBody(request);
  const sql = stringValue(body.sql);
  if (!sql) {
    throw new OntologyHttpError(400, "BAD_REQUEST", "缺少 sql");
  }
  const db = context.metadataStore.db;
  const conn = openSpcConnection(context.metadataStore, context.userId);
  return ok(executeOntologySql(conn, approvedBindingsByName(db), sql, recordValue(body.params) ?? {}));
};

const handleTraverse = async (
  request: IncomingMessage,
  method: string | undefined,
  context: OntologyRouteContext
): Promise<ConfigApiResponse> => {
  requireMethod(method, "POST");
  const body = await readJsonBody(request);
  const fromEntity = stringValue(body.fromEntity);
  const toEntity = stringValue(body.toEntity);
  if (!fromEntity || !toEntity) {
    throw new OntologyHttpError(400, "BAD_REQUEST", "缺少 fromEntity/toEntity");
  }
  const db = context.metadataStore.db;
  requireEntityId(db, fromEntity);
  requireEntityId(db, toEntity);
  const bindings = approvedBindingsByName(db);
  const conn = openSpcConnection(context.metadataStore, context.userId);
  return ok(
    traverse(
      conn,
      bindings,
      traversableEdges(db),
      fromEntity,
      recordValue(body.fromFilters) ?? {},
      toEntity,
      numberValue(body.limit) ?? 200
    )
  );
};

const handleBindings = (method: string | undefined, db: DatabaseSync): ConfigApiResponse => {
  requireMethod(method, "GET");
  const rows = db
    .prepare(
      `SELECT e.name AS entity, b.table_name AS "table", b.status AS status
       FROM ont_bindings b JOIN ont_entities e ON e.id = b.entity_id
       WHERE b.status = 'approved' ORDER BY e.name`
    )
    .all();
  return ok({ bindings: rows });
};

const handleContext = (method: string | undefined, db: DatabaseSync): ConfigApiResponse => {
  requireMethod(method, "GET");
  const bindings = db
    .prepare(
      `SELECT e.name AS entity, b.table_name AS "table", b.id_column AS id_column,
              b.field_mappings_json AS field_mappings, b.status AS status
       FROM ont_bindings b JOIN ont_entities e ON e.id = b.entity_id
       WHERE b.status = 'approved' ORDER BY e.name`
    )
    .all();
  const relations = db
    .prepare(
      `SELECT r.name AS name, ef.name AS from_entity, et.name AS to_entity,
              r.cardinality AS cardinality, r.source_field AS source_field,
              r.target_field AS target_field
       FROM ont_relations r
       JOIN ont_entities ef ON ef.id = r.from_entity_id
       JOIN ont_entities et ON et.id = r.to_entity_id
       ORDER BY ef.name, r.name`
    )
    .all();
  const functions = db
    .prepare(
      `SELECT callable_name, description, input_schema_json
       FROM ont_functions WHERE status = 'active' ORDER BY callable_name`
    )
    .all()
    .map((row: Record<string, unknown>) => ({
      callable_name: row.callable_name,
      description: row.description,
      input_schema: typeof row.input_schema_json === "string"
        ? JSON.parse(row.input_schema_json as string)
        : row.input_schema_json,
    }));
  return ok({ bindings, relations, functions });
};

// --- 数据连接与元数据读取 ----------------------------------------------------------

const openSpcConnection = (metadataStore: OntologyRouteContext["metadataStore"], userId: string): DatabaseSync => {
  const ds = metadataStore.dataSources
    .list({ user_id: userId, enabled_only: true })
    .find((d) => d.name === SPC_DATASOURCE_NAME);
  if (!ds) {
    throw new OntologyHttpError(404, "RESOURCE_NOT_FOUND", `当前用户未配置数据源 ${SPC_DATASOURCE_NAME}`);
  }
  const config = recordValue(safeJsonParse(ds.config_json));
  const path = typeof config?.path === "string" ? config.path : "";
  if (!path) {
    throw new Error(`${SPC_DATASOURCE_NAME} 的 config_json.path 缺失或非法`);
  }
  const cached = connectionsByPath.get(path);
  if (cached) {
    return cached;
  }
  const conn = new DatabaseSync(path, { readOnly: true });
  connectionsByPath.set(path, conn);
  return conn;
};

const requireEntityId = (db: DatabaseSync, name: string): string => {
  const row = db.prepare("SELECT id FROM ont_entities WHERE name = ?").get(name) as
    | { id: string }
    | undefined;
  if (!row) {
    throw new OntologyHttpError(400, "BAD_REQUEST", `未知实体: ${name}`);
  }
  return row.id;
};

/** 全部 approved 绑定，键 = 实体名（executeOntologySql/traverse 的 bindings 契约键）。 */
const approvedBindingsByName = (db: DatabaseSync): Record<string, Binding> => {
  const rows = db
    .prepare(
      `SELECT e.id AS entity_id, e.name AS entity_name FROM ont_entities e
       WHERE EXISTS (SELECT 1 FROM ont_bindings b WHERE b.entity_id = e.id AND b.status = 'approved')`
    )
    .all() as { entity_id: string; entity_name: string }[];
  const bindings: Record<string, Binding> = {};
  for (const row of rows) {
    bindings[row.entity_name] = resolveBinding(db, row.entity_id);
  }
  return bindings;
};

/**
 * ont_relations → RelationEdge[]：只保留两端实体均在 approved 绑定集内的边（traverse 编译
 * JOIN 时每个途经实体都必须有绑定）；实体 id→名字经 ont_entities 反查以配合 bindings 的
 * 实体名键。source/target_field 为 NULL（迁移数据中未登记字段的边）映射为空串——traverse
 * 会跳过这类边。
 */
const traversableEdges = (db: DatabaseSync): RelationEdge[] => {
  const boundIds = new Set(
    (db.prepare("SELECT entity_id FROM ont_bindings WHERE status = 'approved'").all() as { entity_id: string }[])
      .map((row) => row.entity_id)
  );
  const nameById = new Map(
    (db.prepare("SELECT id, name FROM ont_entities").all() as { id: string; name: string }[]).map((row) => [
      row.id,
      row.name
    ])
  );
  const rows = db
    .prepare("SELECT from_entity_id, to_entity_id, source_field, target_field FROM ont_relations")
    .all() as { from_entity_id: string; to_entity_id: string; source_field: unknown; target_field: unknown }[];
  const edges: RelationEdge[] = [];
  for (const row of rows) {
    const from = nameById.get(row.from_entity_id);
    const to = nameById.get(row.to_entity_id);
    if (!from || !to || !boundIds.has(row.from_entity_id) || !boundIds.has(row.to_entity_id)) {
      continue;
    }
    edges.push({
      fromEntityId: from,
      toEntityId: to,
      sourceField: typeof row.source_field === "string" ? row.source_field : "",
      targetField: typeof row.target_field === "string" ? row.target_field : ""
    });
  }
  return edges;
};

// --- 传输辅助 ----------------------------------------------------------------------

const requireMethod = (method: string | undefined, expected: "GET" | "POST"): void => {
  if (method !== expected) {
    throw new OntologyHttpError(405, "BAD_REQUEST", `Method not allowed（需要 ${expected}）。`);
  }
};

const readJsonBody = async (request: IncomingMessage): Promise<Record<string, unknown>> => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_JSON_BODY_BYTES) {
      throw new OntologyHttpError(400, "BAD_REQUEST", "请求体超过大小限制");
    }
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  let parsed: unknown;
  try {
    parsed = raw.length > 0 ? JSON.parse(raw) : {};
  } catch {
    throw new OntologyHttpError(400, "BAD_REQUEST", "请求体不是合法 JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new OntologyHttpError(400, "BAD_REQUEST", "请求体必须是 JSON 对象");
  }
  return parsed as Record<string, unknown>;
};

const ontologyErrorResponse = (error: unknown): ConfigApiResponse => {
  if (error instanceof OntologyHttpError) {
    return { body: createErrorResult(error.code, error.message), status: error.status };
  }
  const message = error instanceof Error ? error.message : String(error);
  // resolveBinding：实体存在但无 approved 绑定
  if (message.includes("未绑定活动数据源")) {
    return errorResult(404, "RESOURCE_NOT_FOUND", message);
  }
  // traverse：绑定集内无边可走
  if (message.includes("没有登记字段映射的关系路径")) {
    return errorResult(404, "RESOURCE_NOT_FOUND", message);
  }
  // executeOntologySql：SQL 未引用任何绑定对象（白名单拒绝）
  if (message.includes("未引用任何本体对象")) {
    return errorResult(400, "BAD_REQUEST", message);
  }
  return errorResult(500, "INTERNAL_ERROR", message);
};

const errorResult = (status: number, code: AppErrorCode, message: string): ConfigApiResponse => ({
  body: createErrorResult(code, message),
  status
});

const ok = (data: unknown): ConfigApiResponse => ({ body: createSuccessResult(data), status: 200 });

const stringValue = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;
const numberValue = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;
const recordValue = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const filtersOf = (body: Record<string, unknown>): Filters => recordValue(body.filters) ?? {};
const safeJsonParse = (raw: string): unknown => {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
};
