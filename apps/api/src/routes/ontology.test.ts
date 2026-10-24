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

const putJson = (subPath: string[], body: unknown): Promise<ConfigApiResponse> =>
  call("PUT", subPath, bodyRequest(body));

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

describe("P1-C governance — GET /entities and /datasource/tables", () => {
  it("lists all entities with attributes and latest binding (including draft)", async () => {
    const response = await call("GET", ["entities"], bodyRequest(""));

    expect(response.status).toBe(200);
    const data = bodyOf(response).data as {
      entities: Array<{ name: string; attributes: unknown[]; binding: { status: string } | null }>;
    };
    const ghost = data.entities.find((e) => e.name === "OrphanGhost");
    expect(ghost?.binding?.status).toBe("draft");
    const wafer = data.entities.find((e) => e.name === "AnomWafer");
    expect(wafer?.attributes).toHaveLength(3);
    expect(wafer?.binding?.status).toBe("approved");
  });

  it("rejects non-GET methods with 405", async () => {
    const response = await postJson(["entities"], {});
    expect(response.status).toBe(405);
  });

  it("introspects datasource tables with columns and a sample row", async () => {
    const response = await call("GET", ["datasource", "tables"], bodyRequest(""));

    expect(response.status).toBe(200);
    const data = bodyOf(response).data as {
      tables: Array<{ name: string; columns: Array<{ name: string }>; sample: Record<string, unknown> | null }>;
    };
    const wafer = data.tables.find((t) => t.name === "v_anom_wafer");
    expect(wafer?.columns.map((c) => c.name)).toEqual(["id", "wafer_id", "chamber_id", "lot"]);
    expect(wafer?.sample).toMatchObject({ wafer_id: "w-001" });
  });
});

describe("P1-C governance — binding edit and approve", () => {
  it("edits a binding (physical validation), demotes to draft, then re-approves", async () => {
    // 1) 非法表名 → 400，绑定不动
    const badTable = await putJson(["bindings", "AnomWafer"], {
      table: "no_such_table",
      idColumn: "id",
      fieldMappings: [{ attribute_id: "attr-w1", source_column: "wafer_id" }]
    });
    expect(badTable.status).toBe(400);
    expect(bodyOf(badTable).error?.message).toContain("no_such_table");

    // 2) 非法列 → 400
    const badColumn = await putJson(["bindings", "AnomWafer"], {
      table: "v_anom_wafer",
      idColumn: "id",
      fieldMappings: [{ attribute_id: "attr-w1", source_column: "no_such_col" }]
    });
    expect(badColumn.status).toBe(400);

    // 3) 合法编辑 → draft；approved-only 查询立刻 404
    const edit = await putJson(["bindings", "AnomWafer"], {
      table: "v_anom_wafer",
      idColumn: "id",
      fieldMappings: [
        { attribute_id: "attr-w1", source_column: "wafer_id" },
        { attribute_id: "attr-w2", source_column: "chamber_id" }
      ]
    });
    expect(edit.status).toBe(200);
    expect((edit.body as ApiBody & { data: { status: string } }).data.status).toBe("draft");
    const queryWhileDraft = await postJson(["query"], { entity: "AnomWafer" });
    expect(queryWhileDraft.status).toBe(404);

    // 4) 覆盖率 2/3 ≥ 50% → 审批通过，查询恢复
    const approve = await call("POST", ["bindings", "AnomWafer", "approve"], bodyRequest({}));
    expect(approve.status).toBe(200);
    const queryAfter = await postJson(["query"], { entity: "AnomWafer" });
    expect(queryAfter.status).toBe(200);
  });

  it("rejects approval when mapping coverage is below 50%", async () => {
    const edit = await putJson(["bindings", "AnomWafer"], {
      table: "v_anom_wafer",
      idColumn: "id",
      fieldMappings: [{ attribute_id: "attr-w1", source_column: "wafer_id" }]
    });
    expect(edit.status).toBe(200);

    const approve = await call("POST", ["bindings", "AnomWafer", "approve"], bodyRequest({}));
    expect(approve.status).toBe(400);
    expect(bodyOf(approve).error?.message).toContain("50%");
    expect(bodyOf(approve).error?.code).toBe("BAD_REQUEST");
  });
});

describe("P1-C governance — version lifecycle", () => {
  it("runs create → check → submit(fail) → submit(pass) → publish → publish(conflict)", async () => {
    // 1) 创建含 draft 绑定实体的版本：check 能看到失败项，submit 拒绝
    const badVersion = await postJson(["versions"], {
      name: "v-bad",
      entityIds: [EID.wafer, EID.ghost]
    });
    expect(badVersion.status).toBe(200);
    const badId = (bodyOf(badVersion).data as { id: string }).id;

    const check = await call("GET", ["versions", badId, "check"], bodyRequest(""));
    expect(check.status).toBe(200);
    const checks = (bodyOf(check).data as { checks: Array<{ entity: string; ok: boolean; reason?: string }> }).checks;
    expect(checks.find((c) => c.entity === "OrphanGhost")?.ok).toBe(false);

    const failedSubmit = await call("POST", ["versions", badId, "submit"], bodyRequest({}));
    expect(failedSubmit.status).toBe(409);
    expect(bodyOf(failedSubmit).error?.code).toBe("CONFLICT");

    // 2) 合规版本：create → submit（快照落库）→ publish
    const goodVersion = await postJson(["versions"], {
      name: "v-good",
      description: "governance flow",
      entityIds: [EID.wafer, EID.tool]
    });
    expect(goodVersion.status).toBe(200);
    const good = bodyOf(goodVersion).data as { id: string; status: string; version_number: number };
    expect(good.status).toBe("draft");
    // 版本号按 ontology 递增：v-bad 已占 1，这里应为 2（也侧面验证失败创建未占号回滚正确）
    expect(good.version_number).toBe(2);

    const submit = await call("POST", ["versions", good.id, "submit"], bodyRequest({}));
    expect(submit.status).toBe(200);
    const submitted = bodyOf(submit).data as { status: string; snapshot: Record<string, unknown[]> };
    expect(submitted.status).toBe("submitted");
    expect(submitted.snapshot.bindings).toHaveLength(2);

    const publish = await call("POST", ["versions", good.id, "publish"], bodyRequest({}));
    expect(publish.status).toBe(200);
    expect((bodyOf(publish).data as { status: string }).status).toBe("published");

    // 3) 状态机：published 后再 publish → 409；draft 前置的 submit 也只能走一次
    const republish = await call("POST", ["versions", good.id, "publish"], bodyRequest({}));
    expect(republish.status).toBe(409);
    const resubmit = await call("POST", ["versions", badId, "submit"], bodyRequest({}));
    expect(resubmit.status).toBe(409);
  });

  it("rolls back version creation when an entity id is unknown", async () => {
    const response = await postJson(["versions"], {
      name: "v-ghost-id",
      entityIds: [EID.wafer, "eid-nonexistent"]
    });
    expect(response.status).toBe(400);

    const list = await call("GET", ["versions"], bodyRequest(""));
    const versions = (bodyOf(list).data as { versions: Array<{ name: string }> }).versions;
    expect(versions.find((v) => v.name === "v-ghost-id")).toBeUndefined();
  });

  it("returns 404 for an unknown version id", async () => {
    const response = await call("GET", ["versions", "nope"], bodyRequest(""));
    expect(response.status).toBe(404);
  });
});

describe("P3-2 governance — POST /promote (DataLink candidates)", () => {
  const candidateBody = {
    entities: [
      {
        name: "PromotedLot",
        nameCn: "批次",
        table: "v_anom_wafer",
        idColumn: "id",
        description: "from datalink inference",
        attributes: [
          { name: "lot", displayName: "批次号", type: "string", sourceColumn: "lot" },
          { name: "chamber_id", type: "string", sourceColumn: "chamber_id" }
        ],
        relations: [{ name: "lots_in_chamber", to: "AnomWafer", sourceField: "chamber_id", targetField: "chamber_id" }]
      }
    ]
  };

  it("creates draft entity/attributes/binding/relation, then reuses on a second promote", async () => {
    const first = await postJson(["promote"], candidateBody);
    expect(first.status).toBe(200);
    const firstData = bodyOf(first).data as {
      entities: Array<{ entity: string; reused: boolean; bindingCreated: boolean }>;
    };
    expect(firstData.entities[0]).toMatchObject({ entity: "PromotedLot", reused: false, bindingCreated: true });

    // 落库形态：draft 实体 + 2 属性 + draft 绑定（mappings 对齐属性）+ 1 条关系
    const entities = await call("GET", ["entities"], bodyRequest(""));
    const promoted = (
      (bodyOf(entities).data as { entities: Array<{ name: string; status: string; attributes: unknown[]; binding: { status: string } | null }> })
        .entities.find((e) => e.name === "PromotedLot")
    );
    expect(promoted?.status).toBe("draft");
    expect(promoted?.attributes).toHaveLength(2);
    expect(promoted?.binding?.status).toBe("draft");

    const second = await postJson(["promote"], candidateBody);
    expect(second.status).toBe(200);
    const secondData = bodyOf(second).data as { entities: Array<{ reused: boolean; bindingCreated: boolean }> };
    expect(secondData.entities[0]).toMatchObject({ reused: true, bindingCreated: false });
  });

  it("rejects candidates missing name/table and unknown relation targets with rollback", async () => {
    const bad = await postJson(["promote"], { entities: [{ table: "v_anom_wafer" }] });
    expect(bad.status).toBe(400);

    const badRelation = await postJson(["promote"], {
      entities: [
        {
          name: "PromotedBroken",
          table: "v_anom_wafer",
          attributes: [{ name: "lot", sourceColumn: "lot" }],
          relations: [{ name: "r", to: "NoSuchEntity", sourceField: "lot", targetField: "lot" }]
        }
      ]
    });
    expect(badRelation.status).toBe(400);
    expect(bodyOf(badRelation).error?.message).toContain("NoSuchEntity");

    // 回滚：失败候选的实体不落库
    const entities = await call("GET", ["entities"], bodyRequest(""));
    const names = (bodyOf(entities).data as { entities: Array<{ name: string }> }).entities.map((e) => e.name);
    expect(names).not.toContain("PromotedBroken");
  });

  it("rejects non-POST methods with 405", async () => {
    const response = await call("GET", ["promote"], bodyRequest(""));
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
