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

const delJson = (subPath: string[]): Promise<ConfigApiResponse> =>
  call("DELETE", subPath, bodyRequest({}));

const patchJson = (subPath: string[], body: unknown): Promise<ConfigApiResponse> =>
  call("PATCH", subPath, bodyRequest(body));
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
      ('attr-w3', '${EID.wafer}', 'lot'),
      ('attr-t1', '${EID.tool}', 'chamber_id'),
      ('attr-t2', '${EID.tool}', 'event_name');
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

  it("rejects unsupported methods on the entities collection with 405", async () => {
    const response = await patchJson(["entities"], {});
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

  it("deletes draft versions but refuses submitted/published ones", async () => {
    const draft = await postJson(["versions"], { name: "v-deletable", entityIds: [EID.wafer] });
    const draftId = (bodyOf(draft).data as { id: string }).id;
    const deleted = await delJson(["versions", draftId]);
    expect(deleted.status).toBe(200);
    const gone = await call("GET", ["versions", draftId], bodyRequest(""));
    expect(gone.status).toBe(404);

    // 登记行一并清：实体可再入新版本（无悬空登记）
    const reused = await postJson(["versions"], { name: "v-reuse", entityIds: [EID.wafer] });
    expect(reused.status).toBe(200);

    const submitted = await postJson(["versions"], { name: "v-submitted", entityIds: [EID.wafer] });
    const submittedId = (bodyOf(submitted).data as { id: string }).id;
    await call("POST", ["versions", submittedId, "submit"], bodyRequest({}));
    const blocked = await delJson(["versions", submittedId]);
    expect(blocked.status).toBe(409);
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

  it("enforces the same identifier/cardinality whitelist as the designer (rollback on reject)", async () => {
    // 正则元字符实体名会炸 rewriteObjectNames 的内插正则（.* 还能击穿 /sql 白名单门）
    const badName = await postJson(["promote"], { entities: [{ name: "订单(", table: "v_anom_wafer" }] });
    expect(badName.status).toBe(400);
    expect(bodyOf(badName).error?.message).toContain("非法字符");

    const badAttr = await postJson(["promote"], {
      entities: [{ name: "PromotedOk", table: "v_anom_wafer", attributes: [{ name: "a\"b" }] }]
    });
    expect(badAttr.status).toBe(400);

    const duplicateAttr = await postJson(["promote"], {
      entities: [{
        name: "PromotedDup",
        table: "v_anom_wafer",
        attributes: [{ name: "lot" }, { name: "lot", sourceColumn: "wafer_id" }]
      }]
    });
    expect(duplicateAttr.status).toBe(400);
    expect(bodyOf(duplicateAttr).error?.message).toContain("属性名重复");

    const badCardinality = await postJson(["promote"], {
      entities: [{
        name: "PromotedCard",
        table: "v_anom_wafer",
        relations: [{ name: "r", to: "AnomWafer", cardinality: "many" }]
      }]
    });
    expect(badCardinality.status).toBe(400);

    const badDatasource = await postJson(["promote"], {
      datasourceId: "ds-does-not-exist",
      entities: [{ name: "PromotedDs", table: "v_anom_wafer" }]
    });
    expect(badDatasource.status).toBe(400);
    expect(bodyOf(badDatasource).error?.message).toContain("数据源不存在");

    // 全部拒绝后无残留（事务回滚）
    const entities = await call("GET", ["entities"], bodyRequest(""));
    const names = (bodyOf(entities).data as { entities: Array<{ name: string }> }).entities.map((e) => e.name);
    expect(names.filter((n) => n.startsWith("Promoted"))).toEqual([]);
  });
});

describe("P3-4 designer — entity modeling", () => {
  it("creates a draft entity with attributes; rejects duplicates, unsafe names and missing name", async () => {
    const created = await postJson(["entities"], {
      name: "Chamber",
      nameCn: "腔体",
      description: "设计器新建",
      attributes: [
        { name: "chamber_id", displayName: "腔体编号", type: "string", required: true },
        { name: "capacity", type: "number" }
      ]
    });
    expect(created.status).toBe(200);
    const data = bodyOf(created).data as {
      name: string;
      status: string;
      attributes: Array<{ name: string; display_name: string | null; required: number }>;
    };
    expect(data.status).toBe("draft");
    expect(data.attributes.map((a) => a.name)).toEqual(["chamber_id", "capacity"]);
    expect(data.attributes[0]).toMatchObject({ display_name: "腔体编号", required: 1 });

    const duplicate = await postJson(["entities"], { name: "Chamber" });
    expect(duplicate.status).toBe(409);
    expect(bodyOf(duplicate).error?.code).toBe("CONFLICT");

    // 实体名进入 rewriteObjectNames 的正则与 SQL 引号拼接：元字符必须在门口拒绝
    const unsafe = await postJson(["entities"], { name: "Bad(Name" });
    expect(unsafe.status).toBe(400);

    const missing = await postJson(["entities"], { nameCn: "无名" });
    expect(missing.status).toBe(400);
  });

  it("syncs attributes on PUT: keeps ids for surviving attributes, refuses deleting referenced ones", async () => {
    const created = await postJson(["entities"], {
      name: "Editable",
      attributes: [
        { name: "alpha", type: "string" },
        { name: "beta", type: "string" }
      ]
    });
    const before = bodyOf(created).data as { attributes: Array<{ id: string; name: string }> };
    const alphaId = before.attributes.find((a) => a.name === "alpha")?.id;

    // 删 beta、改 alpha（display/type）、加 gamma —— alpha 的 id 必须保持（绑定映射按 id 引用）
    const updated = await putJson(["entities", "Editable"], {
      nameCn: "可编辑",
      attributes: [
        { name: "alpha", displayName: "甲", type: "number" },
        { name: "gamma", type: "boolean", required: true }
      ]
    });
    expect(updated.status).toBe(200);
    const after = bodyOf(updated).data as {
      name_cn: string | null;
      attributes: Array<{ id: string; name: string; display_name: string | null; type: string; required: number }>;
    };
    expect(after.name_cn).toBe("可编辑");
    expect(after.attributes.map((a) => a.name)).toEqual(["alpha", "gamma"]);
    expect(after.attributes[0]?.id).toBe(alphaId);
    expect(after.attributes[0]).toMatchObject({ display_name: "甲", type: "number" });
    expect(after.attributes[1]?.required).toBe(1);

    // 被 approved 绑定映射引用的属性不可删（AnomWafer: wafer_id/chamber_id/lot 全部在映射里）
    const blocked = await putJson(["entities", "AnomWafer"], {
      attributes: [{ name: "chamber_id" }, { name: "lot" }]
    });
    expect(blocked.status).toBe(400);
    expect(bodyOf(blocked).error?.message).toContain("wafer_id");

    const renamed = await putJson(["entities", "Editable"], { name: "Renamed" });
    expect(renamed.status).toBe(400);

    const unknown = await putJson(["entities", "NoSuchEntity"], {});
    expect(unknown.status).toBe(400);

    const malformed = await putJson(["entities", "Editable"], { attributes: "not-an-array" });
    expect(malformed.status).toBe(400);
  });

  it("deletes a draft entity with relation cascade; refuses published and version-registered ones", async () => {
    const created = await postJson(["entities"], { name: "Doomed", attributes: [{ name: "code" }] });
    const doomedId = (bodyOf(created).data as { id: string }).id;

    // 版本登记中的 draft 实体不可删
    const version = await postJson(["versions"], { name: "v-doomed", entityIds: [doomedId] });
    expect(version.status).toBe(200);
    const blockedByVersion = await delJson(["entities", "Doomed"]);
    expect(blockedByVersion.status).toBe(409);

    // 干净 draft 实体：删除 + 关系级联
    await postJson(["entities"], { name: "Doomed2", attributes: [{ name: "code" }] });
    const rel = await postJson(["relations"], {
      name: "doomed2_has",
      fromEntity: "Doomed2",
      toEntity: "AnomWafer",
      sourceField: "code",
      targetField: "lot"
    });
    const relId = (bodyOf(rel).data as { id: string }).id;
    const deleted = await delJson(["entities", "Doomed2"]);
    expect(deleted.status).toBe(200);
    const entities = await call("GET", ["entities"], bodyRequest(""));
    const names = (bodyOf(entities).data as { entities: Array<{ name: string }> }).entities.map((e) => e.name);
    expect(names).not.toContain("Doomed2");
    const relGone = await delJson(["relations", relId]);
    expect(relGone.status).toBe(404);

    const published = await delJson(["entities", "AnomWafer"]);
    expect(published.status).toBe(409);

    const unknown = await delJson(["entities", "NoSuchEntity"]);
    expect(unknown.status).toBe(400);
  });

  it("carries a designer-created entity through binding creation and approval", async () => {
    const created = await postJson(["entities"], {
      name: "FreshEntity",
      nameCn: "新实体",
      attributes: [{ name: "wafer_id", type: "string" }]
    });
    expect(created.status).toBe(200);
    const attr = (bodyOf(created).data as { attributes: Array<{ id: string; name: string }> }).attributes[0];
    expect(attr?.name).toBe("wafer_id");

    // 无绑定 → 查询 404
    const before = await postJson(["query"], { entity: "FreshEntity" });
    expect(before.status).toBe(404);

    // 绑定编辑器首次保存：绑定行不存在则创建（datasource 解析 SPC_MVP_SQLITE）
    const bind = await putJson(["bindings", "FreshEntity"], {
      table: "v_anom_wafer",
      idColumn: "id",
      fieldMappings: [{ attribute_id: attr?.id, source_column: "wafer_id" }]
    });
    expect(bind.status).toBe(200);
    expect((bodyOf(bind).data as { status: string }).status).toBe("draft");

    const approve = await call("POST", ["bindings", "FreshEntity", "approve"], bodyRequest({}));
    expect(approve.status).toBe(200);

    const query = await postJson(["query"], { entity: "FreshEntity" });
    expect(query.status).toBe(200);
    expect(bodyOf(query).data).toEqual({ columns: ["wafer_id"], rows: [["w-001"], ["w-002"]], rowCount: 2 });
  });

  it("refuses deleting a draft entity that carries an approved binding (409)", async () => {
    const created = await postJson(["entities"], {
      name: "BoundDraft",
      attributes: [{ name: "wafer_id", type: "string" }]
    });
    const attr = (bodyOf(created).data as { attributes: Array<{ id: string }> }).attributes[0];
    await putJson(["bindings", "BoundDraft"], {
      table: "v_anom_wafer",
      idColumn: "id",
      fieldMappings: [{ attribute_id: attr?.id, source_column: "wafer_id" }]
    });
    await call("POST", ["bindings", "BoundDraft", "approve"], bodyRequest({}));

    const deleted = await delJson(["entities", "BoundDraft"]);
    expect(deleted.status).toBe(409);
    expect(bodyOf(deleted).error?.message).toContain("已审批绑定");
  });

  it("guards Record-form mapping references by attribute name (not just array-form ids)", async () => {
    // bind-tool 的 field_mappings_json 是历史 Record 形态（键=属性名）：删其中任一属性都必须被拦
    const blocked = await putJson(["entities", "ToolEvent"], {
      attributes: [{ name: "chamber_id" }]
    });
    expect(blocked.status).toBe(400);
    expect(bodyOf(blocked).error?.message).toContain("event_name");

    // Record 形态的审批覆盖率按 键数 计、物理校验按 值(列名) 做——draft 化后重审批应通过
    metadata.db.prepare("UPDATE ont_bindings SET status = 'draft' WHERE id = 'bind-tool'").run();
    const approve = await call("POST", ["bindings", "ToolEvent", "approve"], bodyRequest({}));
    expect(approve.status).toBe(200);
    expect((bodyOf(approve).data as { status: string }).status).toBe("approved");
  });

  it("decodes URL-encoded entity names in path segments (Chinese roundtrip)", async () => {
    await postJson(["entities"], { name: "腔体", nameCn: "腔体", attributes: [{ name: "code" }] });

    // config-api 按 pathname.split("/") 切段不解码；浏览器侧 encodeURIComponent 后到这里是 %XX
    const deleted = await delJson(["entities", encodeURIComponent("腔体")]);
    expect(deleted.status).toBe(200);

    const entities = await call("GET", ["entities"], bodyRequest(""));
    const names = (bodyOf(entities).data as { entities: Array<{ name: string }> }).entities.map((e) => e.name);
    expect(names).not.toContain("腔体");

    const malformed = await delJson(["entities", "%zz"]);
    expect(malformed.status).toBe(400);
  });
});

describe("P3-4 designer — relations", () => {
  it("creates and deletes relations with entity/field/cardinality validation", async () => {
    const created = await postJson(["relations"], {
      name: "wafer_same_chamber_events",
      fromEntity: "AnomWafer",
      toEntity: "ToolEvent",
      cardinality: "N:1",
      sourceField: "chamber_id",
      targetField: "chamber_id",
      description: "同腔体事件"
    });
    expect(created.status).toBe(200);
    const data = bodyOf(created).data as {
      id: string;
      from_entity: string;
      to_entity: string;
      cardinality: string;
    };
    expect(data).toMatchObject({ from_entity: "AnomWafer", to_entity: "ToolEvent", cardinality: "N:1" });

    const duplicate = await postJson(["relations"], {
      name: "wafer_same_chamber_events",
      fromEntity: "AnomWafer",
      toEntity: "ToolEvent"
    });
    expect(duplicate.status).toBe(409);

    const badTarget = await postJson(["relations"], { name: "x", fromEntity: "AnomWafer", toEntity: "NoSuch" });
    expect(badTarget.status).toBe(400);

    // 关系字段会拼进 traverse 的 JOIN，元字符拒绝
    const badField = await postJson(["relations"], {
      name: "x2",
      fromEntity: "AnomWafer",
      toEntity: "ToolEvent",
      sourceField: "a b"
    });
    expect(badField.status).toBe(400);

    const badCardinality = await postJson(["relations"], {
      name: "x3",
      fromEntity: "AnomWafer",
      toEntity: "ToolEvent",
      cardinality: "many"
    });
    expect(badCardinality.status).toBe(400);

    const context = await call("GET", ["context"], bodyRequest(""));
    const relations = (bodyOf(context).data as { relations: Array<{ name: string }> }).relations;
    expect(relations.find((r) => r.name === "wafer_same_chamber_events")).toBeTruthy();

    const deleted = await delJson(["relations", data.id]);
    expect(deleted.status).toBe(200);
    const deletedAgain = await delJson(["relations", data.id]);
    expect(deletedAgain.status).toBe(404);
  });

  it("rejects non-POST methods on the relations collection with 405", async () => {
    const response = await call("GET", ["relations"], bodyRequest(""));
    expect(response.status).toBe(405);
  });

  it("updates a relation to register connection keys, validating against entity attributes", async () => {
    // seed: rel-wt AnomWafer -[has_events]-> ToolEvent，已带 chamber_id 键；改键并改基数
    const updated = await putJson(["relations", "rel-wt"], {
      name: "has_events",
      cardinality: "1:N",
      sourceField: "wafer_id",
      targetField: "chamber_id",
    });
    expect(updated.status).toBe(200);
    expect(bodyOf(updated).data).toMatchObject({ source_field: "wafer_id", target_field: "chamber_id" });

    // 目标端不存在的属性 → 400
    const badTarget = await putJson(["relations", "rel-wt"], {
      name: "has_events",
      sourceField: "lot",
      targetField: "no_such_col",
    });
    expect(badTarget.status).toBe(400);
    expect(bodyOf(badTarget).error?.message).toContain("ToolEvent 不存在属性");

    // 只登记一端 → 400
    const halfKey = await putJson(["relations", "rel-wt"], { name: "has_events", sourceField: "lot" });
    expect(halfKey.status).toBe(400);

    // 未知关系 404
    const unknown = await putJson(["relations", "rel-nope"], { name: "x" });
    expect(unknown.status).toBe(404);
  });
});

describe("P3-5 designer — rules and actions", () => {
  it("creates inference and logic rules with condition validation, updates and deletes", async () => {
    const created = await postJson(["rules"], {
      entity: "AnomWafer",
      name: "chamber_watch",
      ruleType: "inference",
      conditions: [{ field: "chamber_id", op: "=", value: "CH1" }],
      then: "标记为 CH1 观察对象",
    });
    expect(created.status).toBe(200);
    const rule = bodyOf(created).data as { id: string; expr: string; entity: string };
    expect(rule.entity).toBe("AnomWafer");
    expect(rule.expr).toBe("WHEN chamber_id = CH1 THEN 标记为 CH1 观察对象");

    const duplicate = await postJson(["rules"], {
      entity: "AnomWafer",
      name: "chamber_watch",
      ruleType: "inference",
      then: "x",
    });
    expect(duplicate.status).toBe(409);

    const badField = await postJson(["rules"], {
      entity: "AnomWafer",
      name: "bad_field_rule",
      conditions: [{ field: "no_such_attr", op: "=", value: 1 }],
      then: "x",
    });
    expect(badField.status).toBe(400);
    expect(bodyOf(badField).error?.message).toContain("已登记属性");

    const noThen = await postJson(["rules"], { entity: "AnomWafer", name: "no_then", ruleType: "inference" });
    expect(noThen.status).toBe(400);

    const badType = await postJson(["rules"], { entity: "AnomWafer", name: "bad_type", ruleType: "magic" });
    expect(badType.status).toBe(400);

    const updated = await putJson(["rules", rule.id], {
      entity: "AnomWafer",
      name: "chamber_watch",
      ruleType: "validation",
      conditions: [{ field: "lot", op: "!=", value: "" }],
      then: "判定批次有效",
      enabled: false,
    });
    expect(updated.status).toBe(200);
    expect((bodyOf(updated).data as { enabled: number; rule_type: string }).enabled).toBe(0);

    const logic = await postJson(["rules"], {
      entity: "AnomWafer",
      name: "lot_summary_sql",
      ruleType: "logic",
      carrier: "sql",
      then: "SELECT lot, COUNT(*) FROM v_anom_wafer GROUP BY lot",
    });
    expect(logic.status).toBe(200);
    expect((bodyOf(logic).data as { expr: string }).expr).toContain("GROUP BY");

    const list = await call("GET", ["rules"], bodyRequest(""));
    const names = (bodyOf(list).data as { rules: Array<{ name: string; enabled: number }> }).rules;
    expect(names.find((r) => r.name === "chamber_watch")?.enabled).toBe(0);

    const deleted = await delJson(["rules", rule.id]);
    expect(deleted.status).toBe(200);
    const deletedAgain = await delJson(["rules", rule.id]);
    expect(deletedAgain.status).toBe(404);
  });

  it("creates actions with executor-specific validation, lists and deletes", async () => {
    const created = await postJson(["actions"], {
      entity: "AnomWafer",
      code: "query_anom_by_lot",
      name: "按批次查异常",
      executor: "sql",
      config: { sql: "SELECT * FROM v_anom_wafer WHERE lot = {lot}" },
      risk: "LOW",
      discovery: "auto",
      intent: "查询异常,批次明细",
      params: [{ name: "lot", type: "string", required: true }],
      description: "按批次标识查询异常明细。",
    });
    expect(created.status).toBe(200);
    const action = bodyOf(created).data as { id: string; entity: string; params_json: string };
    expect(action.entity).toBe("AnomWafer");
    expect(JSON.parse(action.params_json)).toEqual([{ name: "lot", type: "string", required: true }]);

    const duplicate = await postJson(["actions"], {
      entity: "AnomWafer",
      code: "query_anom_by_lot",
      name: "重复",
      executor: "sql",
      config: { sql: "SELECT * FROM v_anom_wafer" },
    });
    expect(duplicate.status).toBe(409);

    const nonSelect = await postJson(["actions"], {
      entity: "AnomWafer",
      code: "bad_sql",
      name: "非只读",
      executor: "sql",
      config: { sql: "DELETE FROM v_anom_wafer" },
    });
    expect(nonSelect.status).toBe(400);
    expect(bodyOf(nonSelect).error?.message).toContain("SELECT");

    const badApi = await postJson(["actions"], {
      entity: "AnomWafer",
      code: "bad_api",
      name: "外置写缺白名单",
      executor: "api",
      config: { method: "POST", path: "http://crm.example.com/freeze" },
    });
    expect(badApi.status).toBe(400);

    const badParam = await postJson(["actions"], {
      entity: "AnomWafer",
      code: "bad_param",
      name: "参数名非法",
      params: [{ name: "a b", type: "string" }],
    });
    expect(badParam.status).toBe(400);

    const context = await call("GET", ["context"], bodyRequest(""));
    const actions = (bodyOf(context).data as { actions: Array<{ code: string }> }).actions;
    expect(actions.find((a) => a.code === "query_anom_by_lot")).toBeTruthy();

    const deleted = await delJson(["actions", action.id]);
    expect(deleted.status).toBe(200);
  });
});

describe("P3-5 review fixes — lifecycle integration", () => {
  it("cascades rules and actions when deleting a draft entity", async () => {
    await postJson(["entities"], { name: "Doomed3", attributes: [{ name: "code" }] });
    await postJson(["rules"], {
      entity: "Doomed3",
      name: "doomed_rule",
      ruleType: "inference",
      conditions: [{ field: "code", op: "=", value: "X" }],
      then: "命中",
    });
    await postJson(["actions"], {
      entity: "Doomed3",
      code: "doomed_action",
      name: "附带动作",
      executor: "sql",
      config: { sql: "SELECT 1" },
    });

    const deleted = await delJson(["entities", "Doomed3"]);
    expect(deleted.status).toBe(200);

    const rules = await call("GET", ["rules"], bodyRequest(""));
    expect((bodyOf(rules).data as { rules: Array<{ name: string }> }).rules.find((r) => r.name === "doomed_rule")).toBeUndefined();
    const actions = await call("GET", ["actions"], bodyRequest(""));
    expect((bodyOf(actions).data as { actions: Array<{ code: string }> }).actions.find((a) => a.code === "doomed_action")).toBeUndefined();
  });

  it("includes rules and actions in the submitted version snapshot", async () => {
    await postJson(["rules"], {
      entity: "AnomWafer",
      name: "snap_rule",
      ruleType: "inference",
      conditions: [{ field: "chamber_id", op: "=", value: "CH1" }],
      then: "快照校验",
    });
    const version = await postJson(["versions"], { name: "v-snap", entityIds: [EID.wafer] });
    const versionId = (bodyOf(version).data as { id: string }).id;
    await call("POST", ["versions", versionId, "submit"], bodyRequest({}));

    const detail = await call("GET", ["versions", versionId], bodyRequest(""));
    const snapshot = (bodyOf(detail).data as { snapshot: Record<string, Array<Record<string, unknown>>> }).snapshot;
    expect(snapshot.rules ?? []).toHaveLength(1);
    expect((snapshot.rules ?? [])[0]).toMatchObject({ name: "snap_rule" });
    expect(Array.isArray(snapshot.actions)).toBe(true);
  });

  it("blocks rule PUT renames onto existing names and entity moves", async () => {
    await postJson(["rules"], {
      entity: "AnomWafer",
      name: "fix_rule_a",
      ruleType: "inference",
      conditions: [{ field: "lot", op: "=", value: "L1" }],
      then: "A",
    });
    const b = await postJson(["rules"], {
      entity: "AnomWafer",
      name: "fix_rule_b",
      ruleType: "inference",
      conditions: [{ field: "lot", op: "=", value: "L2" }],
      then: "B",
    });
    const bId = (bodyOf(b).data as { id: string }).id;

    const renamed = await putJson(["rules", bId], {
      entity: "AnomWafer",
      name: "fix_rule_a",
      ruleType: "inference",
      then: "B",
    });
    expect(renamed.status).toBe(409);

    const moved = await putJson(["rules", bId], {
      entity: "ToolEvent",
      name: "fix_rule_b",
      ruleType: "inference",
      then: "B",
    });
    expect(moved.status).toBe(400);
    expect(bodyOf(moved).error?.message).toContain("所属实体不可修改");
  });

  it("rejects malformed conditions/params arrays and unsafe action configs", async () => {
    const badConditions = await postJson(["rules"], {
      entity: "AnomWafer",
      name: "bad_conditions",
      ruleType: "inference",
      conditions: { field: "lot" },
      then: "x",
    });
    expect(badConditions.status).toBe(400);
    expect(bodyOf(badConditions).error?.message).toContain("conditions 必须是对象数组");

    const badParams = await postJson(["actions"], {
      entity: "AnomWafer",
      code: "bad_params",
      name: "参数非数组",
      executor: "sql",
      config: { sql: "SELECT 1" },
      params: { name: "lot" },
    });
    expect(badParams.status).toBe(400);
    expect(bodyOf(badParams).error?.message).toContain("params 必须是对象数组");

    const multiStatement = await postJson(["actions"], {
      entity: "AnomWafer",
      code: "multi_stmt",
      name: "多语句",
      executor: "sql",
      config: { sql: "SELECT 1; DROP TABLE t" },
    });
    expect(multiStatement.status).toBe(400);
    expect(bodyOf(multiStatement).error?.message).toContain("分号");

    const badType = await postJson(["actions"], {
      entity: "AnomWafer",
      code: "bad_param_type",
      name: "参数类型越界",
      executor: "sql",
      config: { sql: "SELECT 1" },
      params: [{ name: "lot", type: "object" }],
    });
    expect(badType.status).toBe(400);
    expect(bodyOf(badType).error?.message).toContain("string/number/boolean");
  });

  it("guards attribute deletion against relation keys and rule conditions", async () => {
    await postJson(["entities"], { name: "Guarded", attributes: [{ name: "alpha" }, { name: "beta" }] });
    await postJson(["relations"], {
      name: "guarded_rel",
      fromEntity: "Guarded",
      toEntity: "AnomWafer",
      sourceField: "alpha",
      targetField: "lot",
    });
    await postJson(["rules"], {
      entity: "Guarded",
      name: "guarded_rule",
      ruleType: "inference",
      conditions: [{ field: "beta", op: "=", value: "1" }],
      then: "x",
    });

    const dropBeta = await putJson(["entities", "Guarded"], { attributes: [{ name: "alpha" }] });
    expect(dropBeta.status).toBe(400);
    expect(bodyOf(dropBeta).error?.message).toContain("规则条件");

    const dropAlpha = await putJson(["entities", "Guarded"], { attributes: [{ name: "beta" }] });
    expect(dropAlpha.status).toBe(400);
    expect(bodyOf(dropAlpha).error?.message).toContain("关系连接键");
  });
});

describe("P3-6 action runtime and publish promotion", () => {
  const createAction = async (code: string, template: string) => {
    const res = await postJson(["actions"], {
      entity: "AnomWafer",
      code,
      name: code,
      executor: "sql",
      config: { sql: template },
      params: [{ name: "lot", type: "string", required: true }],
    });
    expect(res.status).toBe(200);
    return (bodyOf(res).data as { id: string }).id;
  };

  it("runs sql actions: simulate previews without recording, execute records the run", async () => {
    const actionId = await createAction("run_smoke", "SELECT * FROM v_anom_wafer WHERE lot = {lot}");

    const simulated = await postJson(["actions", actionId, "run"], {
      mode: "simulate",
      params: { lot: "L1" },
    });
    expect(simulated.status).toBe(200);
    expect((bodyOf(simulated).data as { rowCount: number }).rowCount).toBeGreaterThanOrEqual(0);
    expect((bodyOf(simulated).data as { runId: string | null }).runId).toBeNull();

    const executed = await postJson(["actions", actionId, "run"], {
      mode: "execute",
      params: { lot: "L1" },
    });
    expect(executed.status).toBe(200);
    const runId = (bodyOf(executed).data as { runId: string }).runId;
    expect(runId).toBeTruthy();

    const history = await call("GET", ["actions", actionId, "runs"], bodyRequest(""));
    const runs = (bodyOf(history).data as { runs: Array<{ id: string; status: string }> }).runs;
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ id: runId, status: "succeeded" });
  });

  it("validates params against the declared contract and rejects undeclared template tokens", async () => {
    const actionId = await createAction("param_guard", "SELECT * FROM v_anom_wafer WHERE lot = {lot}");

    const missing = await postJson(["actions", actionId, "run"], { mode: "execute", params: {} });
    expect(missing.status).toBe(400);
    expect(bodyOf(missing).error?.message).toContain("缺少必填参数: lot");

    const undeclared = await postJson(["actions", actionId, "run"], {
      mode: "execute",
      params: { lot: "L1", extra: "x" },
    });
    expect(undeclared.status).toBe(400);
    expect(bodyOf(undeclared).error?.message).toContain("未在参数契约中声明");

    const badToken = await createAction("bad_token", "SELECT * FROM v_anom_wafer WHERE lot = {nope}");
    const badTokenRun = await postJson(["actions", badToken, "run"], { params: { lot: "L1" } });
    expect(badTokenRun.status).toBe(400);
    expect(bodyOf(badTokenRun).error?.message).toContain("未声明的参数");
  });

  it("rejects non-sql executors, disabled actions and unknown ids at run time", async () => {
    const apiAction = await postJson(["actions"], {
      entity: "AnomWafer",
      code: "audit_api_action",
      name: "外置写",
      executor: "api",
      config: { method: "POST", path: "https://crm.example.com/f", hosts: "crm.example.com" },
    });
    const apiId = (bodyOf(apiAction).data as { id: string }).id;
    const apiRun = await postJson(["actions", apiId, "run"], { params: {} });
    expect(apiRun.status).toBe(400);
    expect(bodyOf(apiRun).error?.message).toContain("运行时未接入");

    const sqlId = await createAction("disabled_run", "SELECT * FROM v_anom_wafer");
    await putJson(["actions", sqlId], {
      entity: "AnomWafer",
      code: "disabled_run",
      name: "disabled_run",
      executor: "sql",
      config: { sql: "SELECT * FROM v_anom_wafer" },
      enabled: false,
    });
    const disabledRun = await postJson(["actions", sqlId, "run"], { params: {} });
    expect(disabledRun.status).toBe(400);
    expect(bodyOf(disabledRun).error?.message).toContain("已停用");

    const unknown = await postJson(["actions", "nope", "run"], { params: {} });
    expect(unknown.status).toBe(404);
  });

  it("deleting an action removes its run history", async () => {
    const actionId = await createAction("with_history", "SELECT * FROM v_anom_wafer");
    await postJson(["actions", actionId, "run"], { mode: "execute", params: {} });
    const deleted = await delJson(["actions", actionId]);
    expect(deleted.status).toBe(200);
    const history = await call("GET", ["actions", actionId, "runs"], bodyRequest(""));
    expect((bodyOf(history).data as { runs: unknown[] }).runs).toHaveLength(0);
  });

  it("publish promotes member entities to published (delete gate becomes effective)", async () => {
    const created = await postJson(["entities"], {
      name: "PromotedEntity",
      attributes: [{ name: "wafer_id", type: "string" }],
    });
    const createdBody = bodyOf(created).data as { id: string; attributes: Array<{ id: string }> };
    const attr = createdBody.attributes[0];
    if (!attr) throw new Error("fixture: attributes missing");
    await putJson(["bindings", "PromotedEntity"], {
      table: "v_anom_wafer",
      idColumn: "id",
      fieldMappings: [{ attribute_id: attr.id, source_column: "wafer_id" }],
    });
    await call("POST", ["bindings", "PromotedEntity", "approve"], bodyRequest({}));

    const version = await postJson(["versions"], { name: "v-promote", entityIds: ["eid-wafer", createdBody.id] });
    const versionId = (bodyOf(version).data as { id: string }).id;
    const submitted = await call("POST", ["versions", versionId, "submit"], bodyRequest({}));
    expect(submitted.status).toBe(200);
    const published = await call("POST", ["versions", versionId, "publish"], bodyRequest({}));
    expect(published.status).toBe(200);

    const entities = await call("GET", ["entities"], bodyRequest(""));
    const promoted = (bodyOf(entities).data as { entities: Array<{ name: string; status: string }> }).entities.find(
      (e) => e.name === "PromotedEntity",
    );
    expect(promoted?.status).toBe("published");

    const blocked = await delJson(["entities", "PromotedEntity"]);
    expect(blocked.status).toBe(409);
  });
});

describe("P3-7 rule evaluate and consistency", () => {
  it("evaluates an inference rule against bound data with preview", async () => {
    const rule = await postJson(["rules"], {
      entity: "AnomWafer",
      name: "eval_ch1",
      ruleType: "inference",
      conditions: [{ field: "chamber_id", op: "=", value: "CH1" }],
      then: "观察对象",
    });
    const id = (bodyOf(rule).data as { id: string }).id;

    const ev = await call("POST", ["rules", id, "evaluate"], bodyRequest({}));
    expect(ev.status).toBe(200);
    const data = bodyOf(ev).data as {
      entity: string;
      matchedRows: number;
      preview: { columns: string[]; rows: Array<Record<string, unknown>> };
    };
    expect(data.entity).toBe("AnomWafer");
    expect(data.matchedRows).toBe(1);
    expect(data.preview.rows[0]).toMatchObject({ chamber_id: "CH1" });
  });

  it("rejects logic-rule evaluate and unmapped condition fields", async () => {
    const logic = await postJson(["rules"], {
      entity: "AnomWafer",
      name: "eval_logic",
      ruleType: "logic",
      carrier: "sql",
      then: "SELECT 1",
    });
    const logicId = (bodyOf(logic).data as { id: string }).id;
    const logicEval = await call("POST", ["rules", logicId, "evaluate"], bodyRequest({}));
    expect(logicEval.status).toBe(400);
    expect(bodyOf(logicEval).error?.message).toContain("无 WHEN 条件");

    // 新增未映射属性并让规则引用它 → 试运行 400 未映射
    await putJson(["entities", "AnomWafer"], {
      attributes: [
        { name: "wafer_id" },
        { name: "chamber_id" },
        { name: "lot" },
        { name: "extra_unmapped", type: "string" },
      ],
    });
    const rule = await postJson(["rules"], {
      entity: "AnomWafer",
      name: "eval_unmapped",
      ruleType: "inference",
      conditions: [{ field: "extra_unmapped", op: "=", value: "1" }],
      then: "x",
    });
    const ruleId = (bodyOf(rule).data as { id: string }).id;
    const ev = await call("POST", ["rules", ruleId, "evaluate"], bodyRequest({}));
    expect(ev.status).toBe(400);
    expect(bodyOf(ev).error?.message).toContain("未映射到物理列");
  });

  it("version consistency reports rule condition fields missing after attribute drift", async () => {
    const rule = await postJson(["rules"], {
      entity: "AnomWafer",
      name: "drift_rule",
      ruleType: "inference",
      conditions: [{ field: "lot", op: "=", value: "L1" }],
      then: "x",
    });
    expect(rule.status).toBe(200);

    // 模拟漂移：直接删除属性行（API 层被规则条件守卫拦截，正常流程到不了这里）
    metadata.db.exec("DELETE FROM ont_attributes WHERE name = 'lot' AND entity_id = 'eid-wafer'");

    const version = await postJson(["versions"], { name: "v-drift", entityIds: [EID.wafer] });
    const versionId = (bodyOf(version).data as { id: string }).id;
    const check = await call("GET", ["versions", versionId, "check"], bodyRequest(""));
    const checks = (bodyOf(check).data as { checks: Array<{ entity: string; ok: boolean; reason?: string }> }).checks;
    const waferCheck = checks.find((c) => c.entity === "AnomWafer");
    expect(waferCheck?.ok).toBe(false);
    expect(waferCheck?.reason).toContain("规则条件字段缺失");
  });
});

describe("P3-8 rules apply batch", () => {
  it("applies all enabled inference rules to entity rows in one call", async () => {
    await postJson(["rules"], {
      entity: "AnomWafer",
      name: "apply_ch1",
      ruleType: "inference",
      conditions: [{ field: "chamber_id", op: "=", value: "CH1" }],
      then: "CH1 观察对象",
    });
    await postJson(["rules"], {
      entity: "AnomWafer",
      name: "apply_lot",
      ruleType: "inference",
      conditions: [{ field: "lot", op: "=", value: "L2" }],
      then: "L2 关注批次",
    });

    const applied = await postJson(["rules", "apply"], { entity: "AnomWafer" });
    expect(applied.status).toBe(200);
    const data = bodyOf(applied).data as {
      rulesApplied: Array<{ name: string; matchedRows: number }>;
      rows: Array<{ wafer_id: string; rule_labels: string[] }>;
    };
    expect(data.rulesApplied).toHaveLength(2);
    const w1 = data.rows.find((r) => r.wafer_id === "w-001");
    const w2 = data.rows.find((r) => r.wafer_id === "w-002");
    expect(w1?.rule_labels).toEqual(["CH1 观察对象"]);
    expect(w2?.rule_labels).toEqual(["L2 关注批次"]);

    const scoped = await postJson(["rules", "apply"], {
      entity: "AnomWafer",
      filters: { chamber_id: "CH1" },
      limit: 1,
    });
    expect(scoped.status).toBe(200);
    const scopedData = bodyOf(scoped).data as { rowCount: number; rows: Array<{ wafer_id: string }> };
    expect(scopedData.rowCount).toBe(1);
    expect(scopedData.rows[0]?.wafer_id).toBe("w-001");
  });

  it("fails with a clear message when the entity has no mapped attributes", async () => {
    await postJson(["entities"], { name: "SkipEntity", attributes: [{ name: "alpha" }] });
    await postJson(["rules"], {
      entity: "SkipEntity",
      name: "skip_rule",
      ruleType: "inference",
      conditions: [{ field: "alpha", op: "=", value: "1" }],
      then: "x",
    });

    // 实体尚无绑定：resolveBinding 先于字段映射检查，404「未绑定」语义
    const applied = await postJson(["rules", "apply"], { entity: "SkipEntity" });
    expect(applied.status).toBe(404);
    expect(bodyOf(applied).error?.message).toContain("未绑定");
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
