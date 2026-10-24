import { randomUUID } from "node:crypto";
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
 * 端点分两组：
 * 只读（数据连接以 readOnly 打开作第二道防线）：
 * - POST /api/v1/ontology/query    {entity, filters?, limit?, offset?} → {columns, rows, rowCount}
 * - POST /api/v1/ontology/sql      {sql, params?}                      → {columns, rows, rowCount}
 * - POST /api/v1/ontology/traverse {fromEntity, fromFilters?, toEntity, limit?} → {columns, rows, rowCount}
 * - GET  /api/v1/ontology/bindings                                     → {bindings: [{entity, table, status}]}
 * - GET  /api/v1/ontology/context                                      → {bindings, relations, functions}
 *
 * 治理写路径（P1-C 编辑流；ont_* 元数据写，数据源连接仍只读）：
 * - GET  /api/v1/ontology/entities                → {entities: [{id,name,status,attributes:[...],binding:{...}|null}]}
 * - GET  /api/v1/ontology/datasource/tables       → {tables: [{name, columns: [{name,type}], sample?}]}
 * - PUT  /api/v1/ontology/bindings/:entity        {table, idColumn, fieldMappings, filterExpr?} → 编辑即打回 draft
 * - POST /api/v1/ontology/bindings/:entity/approve → 校验（物理表/列存在 + id_column + 覆盖率≥50%）→ approved
 * - GET|POST /api/v1/ontology/versions            → 版本清单 / 创建 draft（{name, description?, entityIds}）
 * - GET  /api/v1/ontology/versions/:id            → 版本详情（含实体清单与一致性检查）
 * - POST /api/v1/ontology/versions/:id/submit     → 一致性检查全过 → 快照组件 → submitted
 * - POST /api/v1/ontology/versions/:id/publish    → submitted → published
 * - POST /api/v1/ontology/promote                 → DataLink 候选转正（实体/属性/关系 draft，人工审批）
 *
 * 写守卫：与会话认证同惯例（config-api 分发链已解析 session/bearer），无独立角色体系；
 * 写面仅限 ont_* 表，物理数据连接保持 readOnly。
 *
 * 错误约定：未知实体/缺参数/坏 JSON/校验失败/SQL 白名单拒绝 → 400；实体无 approved 绑定、关系路径
 * 不存在、SPC 数据源缺失、未知端点 → 404；状态机非法迁移 → 409；其余（含数据侧打开失败/元数据损坏）→ 500。
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
    const db = context.metadataStore.db;
    switch (subPath[0] ?? "") {
      case "query":
        return await handleQuery(request, method, context);
      case "sql":
        return await handleSql(request, method, context);
      case "traverse":
        return await handleTraverse(request, method, context);
      case "bindings":
        return await handleBindingsRoute(request, method, subPath.slice(1), context);
      case "context":
        return handleContext(method, db);
      case "entities":
        return handleEntities(method, db);
      case "datasource":
        return await handleDatasourceTables(method, subPath.slice(1), context);
      case "versions":
        return await handleVersionsRoute(request, method, subPath.slice(1), context);
      case "promote":
        return await handlePromote(request, method, context);
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

const handleBindingsRoute = async (
  request: IncomingMessage,
  method: string | undefined,
  rest: string[],
  context: OntologyRouteContext
): Promise<ConfigApiResponse> => {
  const db = context.metadataStore.db;
  if (rest.length === 0) {
    // 契约保持 approved-only（smoke 脚本与 MCP 侧依赖）；治理全量清单走 GET /entities
    requireMethod(method, "GET");
    const rows = db
      .prepare(
        `SELECT e.name AS entity, b.table_name AS "table", b.status AS status
         FROM ont_bindings b JOIN ont_entities e ON e.id = b.entity_id
         WHERE b.status = 'approved' ORDER BY e.name`
      )
      .all();
    return ok({ bindings: rows });
  }
  const entityName = rest[0];
  if (!entityName) {
    throw new OntologyHttpError(404, "RESOURCE_NOT_FOUND", "缺少实体名");
  }
  if (rest.length === 1) {
    requireMethod(method, "PUT");
    return handleBindingUpdate(request, entityName, db, context);
  }
  if (rest.length === 2 && rest[1] === "approve") {
    requireMethod(method, "POST");
    return handleBindingApprove(entityName, db, context);
  }
  throw new OntologyHttpError(404, "RESOURCE_NOT_FOUND", `未知绑定端点: ${rest.join("/")}`);
};

/** PUT /bindings/:entity —— 覆盖表/ID列/字段映射；编辑即打回 draft（重走审批）。 */
const handleBindingUpdate = async (
  request: IncomingMessage,
  entityName: string,
  db: DatabaseSync,
  context: OntologyRouteContext
): Promise<ConfigApiResponse> => {
  const entityId = requireEntityId(db, entityName);
  const body = await readJsonBody(request);
  const table = stringValue(body.table);
  const idColumn = stringValue(body.idColumn);
  const mappings = arrayValue(body.fieldMappings);
  if (!table || !idColumn || !mappings) {
    throw new OntologyHttpError(400, "BAD_REQUEST", "缺少 table/idColumn/fieldMappings");
  }
  const conn = openSpcConnection(context.metadataStore, context.userId);
  assertTableAndColumns(conn, table, idColumn, mappings);
  const bindingId = requireBindingId(db, entityId);
  db.prepare(
    `UPDATE ont_bindings SET table_name = ?, id_column = ?, field_mappings_json = ?,
            filter_expr = COALESCE(?, filter_expr), status = 'draft' WHERE id = ?`
  ).run(
    table,
    idColumn,
    JSON.stringify(
      mappings.map((m) => ({ attribute_id: String(m.attribute_id ?? ""), source_column: String(m.source_column ?? "") }))
    ),
    stringValue(body.filterExpr) ?? null,
    bindingId
  );
  return ok(bindingRow(db, bindingId, entityName));
};

/** POST /bindings/:entity/approve —— 审批校验：物理列存在 + id_column + 映射覆盖 ≥50% 属性。 */
const handleBindingApprove = (
  entityName: string,
  db: DatabaseSync,
  context: OntologyRouteContext
): ConfigApiResponse => {
  const entityId = requireEntityId(db, entityName);
  const bindingId = requireBindingId(db, entityId);
  const binding = db
    .prepare("SELECT table_name, id_column, field_mappings_json FROM ont_bindings WHERE id = ?")
    .get(bindingId) as { table_name: string; id_column: string; field_mappings_json: string };
  const mappings = safeJsonParse(binding.field_mappings_json);
  if (!Array.isArray(mappings) || mappings.length === 0) {
    throw new OntologyHttpError(400, "BAD_REQUEST", "字段映射为空，无法审批");
  }
  const conn = openSpcConnection(context.metadataStore, context.userId);
  assertTableAndColumns(
    conn,
    binding.table_name,
    binding.id_column,
    mappings as { attribute_id?: unknown; source_column?: unknown }[]
  );
  const total = db.prepare("SELECT COUNT(*) AS n FROM ont_attributes WHERE entity_id = ?").get(entityId) as {
    n: number;
  };
  if (total.n > 0 && mappings.length * 2 < total.n) {
    throw new OntologyHttpError(
      400,
      "BAD_REQUEST",
      `映射覆盖 ${mappings.length}/${total.n} 低于 50%，无法审批`
    );
  }
  db.prepare("UPDATE ont_bindings SET status = 'approved' WHERE id = ?").run(bindingId);
  return ok(bindingRow(db, bindingId, entityName));
};

/** GET /entities —— 治理视图：实体 + 属性 + 当前绑定（含 draft）。 */
const handleEntities = (method: string | undefined, db: DatabaseSync): ConfigApiResponse => {
  requireMethod(method, "GET");
  const entities = db
    .prepare("SELECT id, name, name_cn, status, tier FROM ont_entities ORDER BY name")
    .all() as { id: string; name: string; name_cn: string | null; status: string; tier: number }[];
  const attrStmt = db.prepare(
    "SELECT id, name, display_name, type, required FROM ont_attributes WHERE entity_id = ? ORDER BY sort, name"
  );
  const bindingStmt = db.prepare(
    "SELECT id, table_name, id_column, field_mappings_json, filter_expr, status FROM ont_bindings WHERE entity_id = ? ORDER BY rowid DESC LIMIT 1"
  );
  return ok({
    entities: entities.map((e) => ({
      ...e,
      attributes: attrStmt.all(e.id),
      binding: (bindingStmt.get(e.id) as Record<string, unknown> | undefined) ?? null
    }))
  });
};

/** GET /datasource/tables —— SPC 数据源物理表/视图 + 列 + 首行样例（映射编辑器左栏）。 */
const handleDatasourceTables = async (
  method: string | undefined,
  rest: string[],
  context: OntologyRouteContext
): Promise<ConfigApiResponse> => {
  requireMethod(method, "GET");
  if (rest[0] !== "tables") {
    throw new OntologyHttpError(404, "RESOURCE_NOT_FOUND", `未知数据源端点: ${rest.join("/")}`);
  }
  const conn = openSpcConnection(context.metadataStore, context.userId);
  const names = (
    conn
      .prepare(
        "SELECT name, type FROM sqlite_master WHERE (type = 'table' OR type = 'view') AND name NOT LIKE 'sqlite_%' ORDER BY name"
      )
      .all() as { name: string; type: string }[]
  ).filter((t) => isSafeIdentifier(t.name));
  const tables = names.map(({ name, type }) => {
    const columns = conn
      .prepare("SELECT name, type FROM pragma_table_info(?)")
      .all(name) as { name: string; type: string }[];
    let sample: Record<string, unknown> | null = null;
    try {
      const row = conn.prepare(`SELECT * FROM "${name}" LIMIT 1`).get() as
        | Record<string, unknown>
        | undefined;
      sample = row ?? null;
    } catch {
      sample = null;
    }
    return { name, kind: type, columns, sample };
  });
  return ok({ tables });
};

const handleVersionsRoute = async (
  request: IncomingMessage,
  method: string | undefined,
  rest: string[],
  context: OntologyRouteContext
): Promise<ConfigApiResponse> => {
  const db = context.metadataStore.db;
  if (rest.length === 0) {
    if (method === "GET") {
      return ok({ versions: listVersions(db) });
    }
    requireMethod(method, "POST");
    return handleVersionCreate(request, db);
  }
  const versionId = rest[0];
  if (!versionId) {
    throw new OntologyHttpError(404, "RESOURCE_NOT_FOUND", "缺少版本 ID");
  }
  if (rest.length === 1) {
    requireMethod(method, "GET");
    return ok(versionDetail(db, versionId));
  }
  if (rest.length === 2 && rest[1] === "check") {
    requireMethod(method, "GET");
    return ok({ checks: versionEntityIds(db, versionId).map((id) => checkEntityConsistency(db, id)) });
  }
  if (rest.length === 2 && rest[1] === "submit") {
    requireMethod(method, "POST");
    return handleVersionSubmit(versionId, db);
  }
  if (rest.length === 2 && rest[1] === "publish") {
    requireMethod(method, "POST");
    return handleVersionPublish(versionId, db);
  }
  throw new OntologyHttpError(404, "RESOURCE_NOT_FOUND", `未知版本端点: ${rest.join("/")}`);
};

/** POST /versions —— 创建 draft 版本并登记选中实体（元枢发布四步的第一步）。 */
const handleVersionCreate = async (
  request: IncomingMessage,
  db: DatabaseSync
): Promise<ConfigApiResponse> => {
  const body = await readJsonBody(request);
  const name = stringValue(body.name);
  const entityIds = arrayValue(body.entityIds)?.map((v) => String(v)) ?? [];
  if (!name || entityIds.length === 0) {
    throw new OntologyHttpError(400, "BAD_REQUEST", "缺少 name 或 entityIds");
  }
  const firstEntityId = entityIds[0];
  if (typeof firstEntityId !== "string") {
    throw new OntologyHttpError(400, "BAD_REQUEST", "entityIds 含非法项");
  }
  const ontologyId = (
    db.prepare("SELECT ontology_id FROM ont_entities WHERE id = ?").get(firstEntityId) as
      | { ontology_id: string }
      | undefined
  )?.ontology_id;
  if (!ontologyId) {
    throw new OntologyHttpError(400, "BAD_REQUEST", "entityIds 首项不是已知实体");
  }
  const versionId = randomUUID();
  const insertVersion = db.prepare(
    `INSERT INTO ont_versions (id, ontology_id, version_number, status, name, description, created_at)
     VALUES (?, ?, (SELECT COALESCE(MAX(version_number), 0) + 1 FROM ont_versions WHERE ontology_id = ?),
             'draft', ?, ?, ?)`
  );
  const insertEntity = db.prepare(
    "INSERT INTO ont_version_entities (version_id, version_entity_id, source_entity_id) VALUES (?, ?, ?)"
  );
  const now = new Date().toISOString();
  db.exec("BEGIN IMMEDIATE");
  try {
    insertVersion.run(versionId, ontologyId, ontologyId, name, stringValue(body.description) ?? null, now);
    for (const entityId of entityIds) {
      if (!db.prepare("SELECT 1 FROM ont_entities WHERE id = ?").get(entityId)) {
        throw new OntologyHttpError(400, "BAD_REQUEST", `未知实体: ${entityId}`);
      }
      insertEntity.run(versionId, randomUUID(), entityId);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return ok(versionDetail(db, versionId));
};

/** POST /versions/:id/submit —— 一致性检查（绑定 approved + id_column + 覆盖率≥50%），全过则快照组件。 */
const handleVersionSubmit = (versionId: string, db: DatabaseSync): ConfigApiResponse => {
  requireVersion(db, versionId, "draft");
  const entityIds = versionEntityIds(db, versionId);
  const checks = entityIds.map((entityId) => checkEntityConsistency(db, entityId));
  const failed = checks.filter((c) => !c.ok);
  if (failed.length > 0) {
    throw new OntologyHttpError(
      409,
      "CONFLICT",
      `一致性检查未通过：${failed.map((c) => `${c.entity}: ${c.reason}`).join("；")}（用 check 端点查看明细）`
    );
  }
  const snapshot: Record<string, unknown[]> = { entities: [], attributes: [], bindings: [], relations: [] };
  snapshot.entities = db
    .prepare(
      `SELECT * FROM ont_entities WHERE id IN (${entityIds.map(() => "?").join(",")})`
    )
    .all(...entityIds);
  snapshot.attributes = db
    .prepare(
      `SELECT * FROM ont_attributes WHERE entity_id IN (${entityIds.map(() => "?").join(",")})`
    )
    .all(...entityIds);
  snapshot.bindings = db
    .prepare(
      `SELECT * FROM ont_bindings WHERE entity_id IN (${entityIds.map(() => "?").join(",")}) AND status = 'approved'`
    )
    .all(...entityIds);
  snapshot.relations = db
    .prepare(
      `SELECT * FROM ont_relations WHERE from_entity_id IN (${entityIds.map(() => "?").join(",")})
       AND to_entity_id IN (${entityIds.map(() => "?").join(",")})`
    )
    .all(...entityIds, ...entityIds);
  db.prepare(
    "UPDATE ont_versions SET status = 'submitted', config_snapshot_json = ?, submitted_at = ? WHERE id = ?"
  ).run(JSON.stringify(snapshot), new Date().toISOString(), versionId);
  return ok({ ...versionDetail(db, versionId), checks });
};

/** POST /versions/:id/publish —— submitted → published（终态）。 */
const handleVersionPublish = (versionId: string, db: DatabaseSync): ConfigApiResponse => {
  requireVersion(db, versionId, "submitted");
  db.prepare("UPDATE ont_versions SET status = 'published', published_at = ? WHERE id = ?").run(
    new Date().toISOString(),
    versionId
  );
  return ok(versionDetail(db, versionId));
};

/** POST /promote —— DataLink 推断候选人工转正：实体/属性/绑定/关系落 draft，走既有审批流。 */
const handlePromote = async (
  request: IncomingMessage,
  method: string | undefined,
  context: OntologyRouteContext
): Promise<ConfigApiResponse> => {
  requireMethod(method, "POST");
  const db = context.metadataStore.db;
  const body = await readJsonBody(request);
  const candidates = arrayValue(body.entities);
  if (!candidates || candidates.length === 0) {
    throw new OntologyHttpError(400, "BAD_REQUEST", "缺少 entities 候选清单");
  }
  const datasourceId = resolvePromotionDatasourceId(context, stringValue(body.datasourceId));
  const ontologyId = requireOntologyId(db);

  const insertEntity = db.prepare(
    "INSERT INTO ont_entities (id, ontology_id, name, name_cn, tier, status, description) VALUES (?, ?, ?, ?, 2, 'draft', ?)"
  );
  const insertAttribute = db.prepare(
    "INSERT INTO ont_attributes (id, entity_id, name, display_name, type, required, sort) VALUES (?, ?, ?, ?, ?, 0, ?)"
  );
  const insertBinding = db.prepare(
    "INSERT INTO ont_bindings (id, entity_id, datasource_id, table_name, id_column, field_mappings_json, status) VALUES (?, ?, ?, ?, ?, ?, 'draft')"
  );
  const insertRelation = db.prepare(
    "INSERT INTO ont_relations (id, from_entity_id, to_entity_id, name, rel_type, cardinality, source_field, target_field, description) VALUES (?, ?, ?, ?, 'has_many', ?, ?, ?, ?)"
  );

  const results: Array<Record<string, unknown>> = [];
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const candidate of candidates) {
      const name = stringValue(candidate.name);
      const table = stringValue(candidate.table);
      if (!name || !table) {
        throw new OntologyHttpError(400, "BAD_REQUEST", "候选缺少 name 或 table");
      }
      const attrs = arrayValue(candidate.attributes) ?? [];
      const existing = db.prepare("SELECT id FROM ont_entities WHERE name = ?").get(name) as
        | { id: string }
        | undefined;
      let entityId: string;
      let reused: boolean;
      if (existing) {
        entityId = existing.id;
        reused = true;
      } else {
        entityId = randomUUID();
        reused = false;
        insertEntity.run(entityId, ontologyId, name, stringValue(candidate.nameCn) ?? null, stringValue(candidate.description) ?? null);
        attrs.forEach((attr, index) => {
          const attrName = stringValue(attr.name);
          if (!attrName) {
            throw new OntologyHttpError(400, "BAD_REQUEST", `候选 ${name} 存在缺 name 的属性`);
          }
          insertAttribute.run(
            randomUUID(),
            entityId,
            attrName,
            stringValue(attr.displayName) ?? null,
            stringValue(attr.type) ?? "string",
            index
          );
        });
      }
      // 绑定：同实体已有任一绑定则不重复建（编辑/审批走既有绑定）
      const existingBinding = db
        .prepare("SELECT id FROM ont_bindings WHERE entity_id = ? LIMIT 1")
        .get(entityId) as { id: string } | undefined;
      let bindingId: string | undefined;
      if (!existingBinding) {
        const idColumn = stringValue(candidate.idColumn) ?? "id";
        bindingId = randomUUID();
        const attributeRows = db
          .prepare("SELECT id, name FROM ont_attributes WHERE entity_id = ?")
          .all(entityId) as Array<{ id: string; name: string }>;
        const columns = new Set(
          (arrayValue(candidate.attributes) ?? [])
            .map((a) => stringValue(a.sourceColumn))
            .filter((c): c is string => Boolean(c))
        );
        const idColumns = columns.has(idColumn) ? idColumn : (stringValue(candidate.idColumn) ?? "id");
        const mappings = attributeRows
          .map((row) => {
            const candidateAttr = (arrayValue(candidate.attributes) ?? []).find(
              (a) => stringValue(a.name) === row.name
            );
            const sourceColumn = stringValue(candidateAttr?.sourceColumn) ?? row.name;
            return { attribute_id: row.id, source_column: sourceColumn };
          });
        insertBinding.run(bindingId, entityId, datasourceId, table, idColumns, JSON.stringify(mappings));
      }
      results.push({
        entity: name,
        reused,
        entityId,
        bindingCreated: Boolean(bindingId)
      });
    }
    // 关系：全部实体处理完后按名解析插入（两端实体存在性已保证）
    for (const candidate of candidates) {
      const fromName = stringValue(candidate.name);
      if (!fromName) continue;
      for (const rel of arrayValue(candidate.relations) ?? []) {
        const relName = stringValue(rel.name);
        const toName = stringValue(rel.to);
        if (!relName || !toName) {
          throw new OntologyHttpError(400, "BAD_REQUEST", `候选 ${fromName} 存在不完整关系（缺 name/to）`);
        }
        const from = db.prepare("SELECT id FROM ont_entities WHERE name = ?").get(fromName) as { id: string };
        const to = db.prepare("SELECT id FROM ont_entities WHERE name = ?").get(toName);
        if (!to) {
          throw new OntologyHttpError(400, "BAD_REQUEST", `关系终点实体不存在: ${toName}`);
        }
        const duplicate = db
          .prepare("SELECT 1 FROM ont_relations WHERE from_entity_id = ? AND to_entity_id = ? AND name = ?")
          .get(from.id, (to as { id: string }).id, relName);
        if (!duplicate) {
          insertRelation.run(
            randomUUID(),
            from.id,
            (to as { id: string }).id,
            relName,
            stringValue(rel.cardinality) ?? "1:N",
            stringValue(rel.sourceField) ?? null,
            stringValue(rel.targetField) ?? null,
            stringValue(rel.description) ?? null
          );
        }
      }
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return ok({
    datasource: datasourceId,
    entities: results,
    next: "到 /ontology/bindings/:entity 逐个编辑并审批，或到 /ontology/versions 发起版本发布"
  });
};

/** 晋升目标数据源：body.datasourceId 优先，缺省解析当前用户的 SPC 数据源。 */
const resolvePromotionDatasourceId = (
  context: OntologyRouteContext,
  explicitId: string | undefined
): string => {
  if (explicitId) {
    return explicitId;
  }
  const ds = context.metadataStore.db
    .prepare("SELECT id FROM data_sources WHERE user_id = ? AND name = ? AND status = 'ready'")
    .get(context.userId, SPC_DATASOURCE_NAME) as { id: string } | undefined;
  if (!ds) {
    throw new OntologyHttpError(404, "RESOURCE_NOT_FOUND", `未找到数据源 ${SPC_DATASOURCE_NAME}`);
  }
  return ds.id;
};

/** 取本体归属：库中唯一本体（MVP 单本体），缺失即 400。 */
const requireOntologyId = (db: DatabaseSync): string => {
  const row = db.prepare("SELECT id FROM ont_ontologies LIMIT 1").get() as { id: string } | undefined;
  if (!row) {
    throw new OntologyHttpError(400, "BAD_REQUEST", "库中没有本体，先完成本体建模");
  }
  return row.id;
};

// --- 版本/绑定辅助 -------------------------------------------------------------------

/** 每实体一致性检查项（元枢规则：绑定 approved + id_column 登记 + 映射覆盖 ≥50% 属性）。 */
const checkEntityConsistency = (
  db: DatabaseSync,
  entityId: string
): { entity: string; ok: boolean; reason?: string } => {
  const entity = db.prepare("SELECT name FROM ont_entities WHERE id = ?").get(entityId) as
    | { name: string }
    | undefined;
  const name = entity?.name ?? entityId;
  const binding = db
    .prepare("SELECT status, table_name, id_column, field_mappings_json FROM ont_bindings WHERE entity_id = ?")
    .get(entityId) as
    | { status: string; table_name: string; id_column: string; field_mappings_json: string }
    | undefined;
  if (!binding) {
    return { entity: name, ok: false, reason: "无绑定" };
  }
  if (binding.status !== "approved") {
    return { entity: name, ok: false, reason: `绑定状态 ${binding.status}（需 approved）` };
  }
  if (!binding.id_column) {
    return { entity: name, ok: false, reason: "未登记 id_column" };
  }
  const mappings = safeJsonParse(binding.field_mappings_json);
  const mapped = Array.isArray(mappings) ? mappings.length : 0;
  const total = (db.prepare("SELECT COUNT(*) AS n FROM ont_attributes WHERE entity_id = ?").get(entityId) as { n: number }).n;
  if (total > 0 && mapped * 2 < total) {
    return { entity: name, ok: false, reason: `映射覆盖 ${mapped}/${total} 低于 50%` };
  }
  return { entity: name, ok: true };
};

const requireVersion = (
  db: DatabaseSync,
  versionId: string,
  expectedStatus: string
): { id: string; status: string } => {
  const version = db.prepare("SELECT id, status FROM ont_versions WHERE id = ?").get(versionId) as
    | { id: string; status: string }
    | undefined;
  if (!version) {
    throw new OntologyHttpError(404, "RESOURCE_NOT_FOUND", `未知版本: ${versionId}`);
  }
  if (version.status !== expectedStatus) {
    throw new OntologyHttpError(
      409,
      "CONFLICT",
      `版本状态为 ${version.status}，该操作要求 ${expectedStatus}`
    );
  }
  return version;
};

const versionEntityIds = (db: DatabaseSync, versionId: string): string[] =>
  (
    db
      .prepare("SELECT source_entity_id FROM ont_version_entities WHERE version_id = ?")
      .all(versionId) as { source_entity_id: string }[]
  ).map((row) => row.source_entity_id);

const listVersions = (db: DatabaseSync): unknown[] =>
  db
    .prepare(
      `SELECT v.id, v.version_number, v.status, v.name, v.description, v.created_at, v.submitted_at, v.published_at,
              (SELECT COUNT(*) FROM ont_version_entities x WHERE x.version_id = v.id) AS entity_count
       FROM ont_versions v ORDER BY v.version_number DESC`
    )
    .all();

const versionDetail = (db: DatabaseSync, versionId: string): Record<string, unknown> => {
  const version = db
    .prepare(
      "SELECT id, ontology_id, version_number, status, name, description, created_at, submitted_at, published_at FROM ont_versions WHERE id = ?"
    )
    .get(versionId) as Record<string, unknown> | undefined;
  if (!version) {
    throw new OntologyHttpError(404, "RESOURCE_NOT_FOUND", `未知版本: ${versionId}`);
  }
  const entityIds = versionEntityIds(db, versionId);
  const entities =
    entityIds.length > 0
      ? db
          .prepare(
            `SELECT id, name, name_cn, status FROM ont_entities WHERE id IN (${entityIds.map(() => "?").join(",")})`
          )
          .all(...entityIds)
      : [];
  const snapshot = safeJsonParse(
    (db.prepare("SELECT config_snapshot_json FROM ont_versions WHERE id = ?").get(versionId) as { config_snapshot_json: string | null }).config_snapshot_json ?? ""
  );
  return { ...version, entities, snapshot: recordValue(snapshot) ?? null };
};

const bindingRow = (db: DatabaseSync, bindingId: string, entityName: string): unknown => {
  const row = db
    .prepare(
      `SELECT b.id, ? AS entity, b.table_name AS "table", b.id_column AS id_column,
              b.field_mappings_json AS field_mappings, b.filter_expr, b.status
       FROM ont_bindings b WHERE b.id = ?`
    )
    .get(entityName, bindingId);
  return row;
};

const requireBindingId = (db: DatabaseSync, entityId: string): string => {
  const row = db.prepare("SELECT id FROM ont_bindings WHERE entity_id = ?").get(entityId) as
    | { id: string }
    | undefined;
  if (!row) {
    throw new OntologyHttpError(404, "RESOURCE_NOT_FOUND", "实体尚无绑定，先在本体建模侧创建");
  }
  return row.id;
};

/**
 * 物理校验：表存在、id_column 与全部 source_column 在表中存在。
 * 标识符先过 isSafeIdentifier（纯字母数字下划线/中文），再用双引号拼接，杜绝注入面。
 */
const assertTableAndColumns = (
  conn: DatabaseSync,
  table: string,
  idColumn: string,
  mappings: { attribute_id?: unknown; source_column?: unknown }[]
): void => {
  if (!isSafeIdentifier(table) || !isSafeIdentifier(idColumn)) {
    throw new OntologyHttpError(400, "BAD_REQUEST", "表名/ID 列含非法字符");
  }
  const exists = conn
    .prepare("SELECT 1 FROM sqlite_master WHERE name = ? AND (type = 'table' OR type = 'view')")
    .get(table);
  if (!exists) {
    throw new OntologyHttpError(400, "BAD_REQUEST", `数据源中不存在表: ${table}`);
  }
  const columns = new Set(
    (conn.prepare("SELECT name FROM pragma_table_info(?)").all(table) as { name: string }[]).map((c) => c.name)
  );
  if (!columns.has(idColumn)) {
    throw new OntologyHttpError(400, "BAD_REQUEST", `表 ${table} 中不存在 ID 列: ${idColumn}`);
  }
  for (const mapping of mappings) {
    const column = typeof mapping.source_column === "string" ? mapping.source_column : "";
    if (!isSafeIdentifier(column) || !columns.has(column)) {
      throw new OntologyHttpError(400, "BAD_REQUEST", `表 ${table} 中不存在映射列: ${column}`);
    }
  }
};

/** 标识符白名单：字母/数字/下划线/中文，防引号与括号注入（拼 PRAGMA/SELECT 场景的硬前置）。 */
const isSafeIdentifier = (name: string): boolean => /^[\p{L}\p{N}_]+$/u.test(name);

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

const requireMethod = (
  method: string | undefined,
  expected: "GET" | "POST" | "PUT"
): void => {
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
const arrayValue = (value: unknown): Record<string, unknown>[] | undefined =>
  Array.isArray(value) ? (value as Record<string, unknown>[]) : undefined;
const filtersOf = (body: Record<string, unknown>): Filters => recordValue(body.filters) ?? {};
const safeJsonParse = (raw: string): unknown => {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
};
