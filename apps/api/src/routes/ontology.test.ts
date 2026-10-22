import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createMetadataStore, type MetadataStore } from "@datafoundry/metadata";
import { ensureOntologyTables } from "@datafoundry/ontology";

import { closeCachedOntologyConnections, handleOntologyRequest } from "./ontology.js";
import type { ConfigApiResponse } from "./types.js";

/**
 * Phase 1-B Task 4 — 本体 REST 路由 handler 级测试。
 *
 * fixture 全内存/临时文件构造：
 * - metadata 侧：createMetadataStore 临时库 + ensureOntologyTables（与生产同构，ont_* 与
 *   metadataStore 同库），手插 实体/属性/绑定/关系 + SPC_MVP_SQLITE data_sources 行；
 * - 数据侧：临时 spc.db（生产同构：data_sources.config_json.path 指向的物理库）。
 *
 * 覆盖：query/sql/traverse 成功+失败、bindings 清单、未知端点 404、坏 JSON 400、
 * 未知实体 400、无 approved 绑定 404、关系路径不存在 404、数据源路径变更后连接重建。
 */

type ApiBody = {
  success: boolean;
  data?: unknown;
  error?: { code: string; message: string };
};

const USER_ID = "user-ont-test";
const SPC_DATASOURCE_ID = "ds-spc-test";

const EID = {
  wafer: "eid-wafer",
  tool: "eid-tool",
  left: "eid-left",
  right: "eid-right",
  ghost: "eid-ghost"
} as const;

let root: string;
let metadata: MetadataStore;
let spcPath: string;

const bodyRequest = (body: unknown): IncomingMessage =>
  Readable.from([
    Buffer.from(typeof body === "string" ? body : JSON.stringify(body))
  ]) as unknown as IncomingMessage;

const call = (
  method: string,
  subPath: string[],
  request: IncomingMessage
): Promise<ConfigApiResponse> =>
  handleOntologyRequest(request, method, subPath, { metadataStore: metadata, userId: USER_ID });

const postJson = (subPath: string[], body: unknown): Promise<ConfigApiResponse> =>
  call("POST", subPath, bodyRequest(body));

const bodyOf = (response: ConfigApiResponse): ApiBody => response.body as ApiBody;

const createSpcFixture = (path: string): void => {
  const db = new DatabaseSync(path);
  try {
    db.exec(`
      CREATE TABLE v_anom_wafer (id TEXT PRIMARY KEY, wafer_id TEXT, chamber_id TEXT, lot TEXT);
      CREATE TABLE dim_tool_event (id TEXT PRIMARY KEY, chamber_id TEXT, event_name TEXT);
      CREATE TABLE lonely_left (id TEXT PRIMARY KEY, code TEXT);
      CREATE TABLE lonely_right (id TEXT PRIMARY KEY, code TEXT);
      INSERT INTO v_anom_wafer VALUES ('w1', 'w-001', 'CH1', 'L1'), ('w2', 'w-002', 'CH2', 'L2');
      INSERT INTO dim_tool_event VALUES ('t1', 'CH1', 'alarm'), ('t2', 'CH1', 'pm'), ('t3', 'CH2', 'idle');
      INSERT INTO lonely_left VALUES ('l1', 'left-1');
      INSERT INTO lonely_right VALUES ('r1', 'right-1');
    `);
  } finally {
    db.close();
  }
};

const seedMetadata = (spcDbPath: string): void => {
  const db = metadata.db;
  ensureOntologyTables(db);
  db.exec(`
    INSERT INTO ont_ontologies (id, name) VALUES ('ont-1', 'SPC');
    INSERT INTO ont_entities (id, ontology_id, name, status) VALUES
      ('${EID.wafer}', 'ont-1', 'AnomWafer', 'published'),
      ('${EID.tool}', 'ont-1', 'ToolEvent', 'published'),
      ('${EID.left}', 'ont-1', 'LonelyLeft', 'published'),
      ('${EID.right}', 'ont-1', 'LonelyRight', 'published'),
      ('${EID.ghost}', 'ont-1', 'OrphanGhost', 'published');
    INSERT INTO ont_attributes (id, entity_id, name) VALUES
      ('attr-w1', '${EID.wafer}', 'wafer_id'),
      ('attr-w2', '${EID.wafer}', 'chamber_id'),
      ('attr-w3', '${EID.wafer}', 'lot');
    INSERT INTO ont_bindings (id, entity_id, datasource_id, table_name, id_column, field_mappings_json, status) VALUES
      ('bind-wafer', '${EID.wafer}', '${SPC_DATASOURCE_ID}', 'v_anom_wafer', 'id',
       '[{"attribute_id":"attr-w1","source_column":"wafer_id"},{"attribute_id":"attr-w2","source_column":"chamber_id"},{"attribute_id":"attr-w3","source_column":"lot"}]',
       'approved'),
      ('bind-tool', '${EID.tool}', '${SPC_DATASOURCE_ID}', 'dim_tool_event', 'id',
       '{"chamber_id":"chamber_id","event_name":"event_name"}', 'approved'),
      ('bind-left', '${EID.left}', '${SPC_DATASOURCE_ID}', 'lonely_left', 'id',
       '{"code":"code"}', 'approved'),
      ('bind-right', '${EID.right}', '${SPC_DATASOURCE_ID}', 'lonely_right', 'id',
       '{"code":"code"}', 'approved'),
      ('bind-ghost', '${EID.ghost}', '${SPC_DATASOURCE_ID}', 'ghost_table', 'id', '{"x":"x"}', 'draft');
    INSERT INTO ont_relations (id, from_entity_id, to_entity_id, name, source_field, target_field) VALUES
      ('rel-wt', '${EID.wafer}', '${EID.tool}', 'has_events', 'chamber_id', 'chamber_id'),
      ('rel-l1g', '${EID.left}', '${EID.ghost}', 'via_ghost', 'code', 'x'),
      ('rel-gr', '${EID.ghost}', '${EID.right}', 'ghost_to_right', 'x', 'code');
  `);
  // data_sources.user_id 有外键约束，先落用户行
  metadata.users.createPasswordUser({ id: USER_ID, email: "ont-test@fusion.local", display_name: "Ont Test" });
  metadata.dataSources.create({
    id: SPC_DATASOURCE_ID,
    user_id: USER_ID,
    name: "SPC_MVP_SQLITE",
    type: "sqlite",
    config: { path: spcDbPath }
  });
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ontology-route-"));
  spcPath = join(root, "spc.db");
  createSpcFixture(spcPath);
  metadata = createMetadataStore({ database_path: join(root, "metadata.sqlite") });
  seedMetadata(spcPath);
});

afterEach(() => {
  // 先关路由层缓存连接（Windows 下打开中的 sqlite 文件会让 rmSync 失败），再关元数据库
  closeCachedOntologyConnections();
  metadata.close();
  rmSync(root, { recursive: true, force: true });
});

describe("POST /api/v1/ontology/query", () => {
  it("resolves the entity by name and returns objectQuery columns/rows", async () => {
    const response = await postJson(["query"], {
      entity: "AnomWafer",
      filters: { chamber_id: "CH1" },
      limit: 10,
      offset: 0
    });

    expect(response.status).toBe(200);
    const body = bodyOf(response);
    expect(body.success).toBe(true);
    expect(body.data).toEqual({
      columns: ["wafer_id", "chamber_id", "lot"],
      rows: [["w-001", "CH1", "L1"]],
      rowCount: 1
    });
  });

  it("rejects an unknown entity name with 400", async () => {
    const response = await postJson(["query"], { entity: "NoSuchEntity" });

    expect(response.status).toBe(400);
    expect(bodyOf(response).error?.code).toBe("BAD_REQUEST");
    expect(bodyOf(response).error?.message).toContain("NoSuchEntity");
  });

  it("returns 404 when the entity has no approved binding", async () => {
    const response = await postJson(["query"], { entity: "OrphanGhost" });

    expect(response.status).toBe(404);
    expect(bodyOf(response).error?.code).toBe("RESOURCE_NOT_FOUND");
  });
});

describe("POST /api/v1/ontology/sql", () => {
  it("rewrites bound entity names and executes with inline params", async () => {
    const response = await postJson(["sql"], {
      sql: "SELECT wafer_id FROM AnomWafer WHERE chamber_id = :p1",
      params: { p1: "CH1" }
    });

    expect(response.status).toBe(200);
    const body = bodyOf(response);
    expect(body.success).toBe(true);
    expect(body.data).toEqual({
      columns: ["wafer_id"],
      rows: [["w-001"]],
      rowCount: 1
    });
  });

  it("rejects SQL that references no bound object with 400", async () => {
    const response = await postJson(["sql"], { sql: "SELECT 1" });

    expect(response.status).toBe(400);
    expect(bodyOf(response).error?.message).toContain("未引用任何本体对象");
  });
});

describe("POST /api/v1/ontology/traverse", () => {
  it("travels registered relations to target rows", async () => {
    const response = await postJson(["traverse"], {
      fromEntity: "AnomWafer",
      fromFilters: { wafer_id: "w-001" },
      toEntity: "ToolEvent",
      limit: 10
    });

    expect(response.status).toBe(200);
    const body = bodyOf(response);
    expect(body.success).toBe(true);
    expect(body.data).toEqual({
      columns: ["chamber_id", "event_name"],
      rows: [
        ["CH1", "alarm"],
        ["CH1", "pm"]
      ],
      rowCount: 2
    });
  });

  it("returns 404 when every relation path leaves the bound set", async () => {
    // LonelyLeft→LonelyRight 的唯一登记路径经过未绑定实体 OrphanGhost（按绑定集过滤后无边可走）
    const response = await postJson(["traverse"], {
      fromEntity: "LonelyLeft",
      toEntity: "LonelyRight"
    });

    expect(response.status).toBe(404);
    expect(bodyOf(response).error?.message).toContain("没有登记字段映射的关系路径");
  });
});

describe("GET /api/v1/ontology/bindings", () => {
  it("lists approved bindings as entity/table/status", async () => {
    const response = await call("GET", ["bindings"], bodyRequest(""));

    expect(response.status).toBe(200);
    expect(bodyOf(response).data).toEqual({
      bindings: [
        { entity: "AnomWafer", table: "v_anom_wafer", status: "approved" },
        { entity: "LonelyLeft", table: "lonely_left", status: "approved" },
        { entity: "LonelyRight", table: "lonely_right", status: "approved" },
        { entity: "ToolEvent", table: "dim_tool_event", status: "approved" }
      ]
    });
  });

  it("rejects non-GET methods with 405", async () => {
    const response = await postJson(["bindings"], {});

    expect(response.status).toBe(405);
  });
});

describe("routing and transport errors", () => {
  it("returns 404 for an unknown ontology endpoint", async () => {
    const response = await call("GET", ["nope"], bodyRequest(""));

    expect(response.status).toBe(404);
    expect(bodyOf(response).error?.code).toBe("RESOURCE_NOT_FOUND");
  });

  it("returns 400 for a malformed JSON body", async () => {
    const response = await postJson(["query"], "{not-json");

    expect(response.status).toBe(400);
    expect(bodyOf(response).error?.code).toBe("BAD_REQUEST");
  });

  it("rejects wrong methods on query with 405", async () => {
    const response = await call("GET", ["query"], bodyRequest(""));

    expect(response.status).toBe(405);
  });
});

describe("data connection", () => {
  it("rebuilds the cached connection when the datasource path changes", async () => {
    const before = await postJson(["query"], { entity: "AnomWafer" });
    expect(bodyOf(before).success).toBe(true);

    const otherPath = join(root, "spc-other.db");
    const other = new DatabaseSync(otherPath);
    try {
      other.exec("CREATE TABLE v_anom_wafer (id TEXT PRIMARY KEY, wafer_id TEXT, chamber_id TEXT, lot TEXT)");
      other.exec("INSERT INTO v_anom_wafer VALUES ('o1', 'w-other', 'CH9', 'LOT-X')");
    } finally {
      other.close();
    }
    metadata.dataSources.create({
      id: SPC_DATASOURCE_ID,
      user_id: USER_ID,
      name: "SPC_MVP_SQLITE",
      type: "sqlite",
      config: { path: otherPath },
      expected_revision: 1
    });

    const after = await postJson(["query"], { entity: "AnomWafer" });
    expect(after.status).toBe(200);
    expect(bodyOf(after).data).toEqual({
      columns: ["wafer_id", "chamber_id", "lot"],
      rows: [["w-other", "CH9", "LOT-X"]],
      rowCount: 1
    });
  });

  it("returns 404 when the user has no SPC_MVP_SQLITE datasource", async () => {
    // 同一元数据库里的另一用户（无 data_sources 行）：本体元数据可见，但数据连接无从建立
    const lonelyUser = "user-without-spc";
    metadata.users.createPasswordUser({ id: lonelyUser, email: "lonely@fusion.local", display_name: "Lonely" });
    const response = await handleOntologyRequest(bodyRequest({ entity: "AnomWafer" }), "POST", ["query"], {
      metadataStore: metadata,
      userId: lonelyUser
    });
    expect(response.status).toBe(404);
    expect(bodyOf(response).error?.message).toContain("SPC_MVP_SQLITE");
  });
});
