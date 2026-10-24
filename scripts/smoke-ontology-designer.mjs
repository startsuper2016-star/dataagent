import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { createServer as createApiServer } from "../apps/api/dist/server.js";
import { closeCachedOntologyConnections } from "../apps/api/dist/routes/ontology.js";
import { createMetadataStore } from "../packages/metadata/dist/index.js";
import { ensureOntologyTables } from "../packages/ontology/dist/index.js";
import { createTaskStateRuntime } from "../packages/agent-runtime/dist/index.js";
import { createAuthenticatedTestClient } from "./lib/authenticated-test-client.mjs";

/**
 * Phase 3 slice 验收 — 本体设计器端到端（真实 HTTP，Bearer 服务身份）。
 *
 * 覆盖建模闭环全链路（设计器 → 绑定 → 审批 → 版本发布 → 遍历/查询 → 清理）：
 *   a. 未认证写端点 → 401
 *   b. POST /entities 建 draft 实体 + 属性；重名 409；非法名（正则元字符）400
 *   c. PUT /bindings/:entity 绑定行缺失自动创建 → draft；审批（覆盖率 2/2）→ approved
 *   d. query 新实体返回物理表数据（列序 = 映射序）
 *   e. PUT /entities 属性同步：保 id 更新 + 新增属性；删被绑定引用属性 → 400
 *   f. POST /relations 建关系 + traverse 经新关系跨实体查询；重复 409；字段白名单 400
 *   g. 版本流：create(含设计器实体) → submit → publish
 *   h. 删除守卫：版本登记中的实体 409；干净 draft 实体删除 + 关系级联；published 实体 409
 */

const root = mkdtempSync(join(tmpdir(), "open-data-foundry-ontology-designer-"));
const spcPath = join(root, "spc.db");

// --- 数据侧 fixture（与 smoke-ontology-api 同构）。
{
  const spc = new DatabaseSync(spcPath);
  try {
    spc.exec(`
      CREATE TABLE v_anom_wafer (id TEXT PRIMARY KEY, wafer_id TEXT, chamber_id TEXT, lot TEXT);
      CREATE TABLE dim_tool_event (id TEXT PRIMARY KEY, chamber_id TEXT, event_name TEXT);
      INSERT INTO v_anom_wafer VALUES ('w1', 'W-001', 'CH1', 'L1'), ('w2', 'W-002', 'CH1', 'L1'), ('w3', 'W-003', 'CH2', 'L2');
      INSERT INTO dim_tool_event VALUES ('t1', 'CH1', 'alarm'), ('t2', 'CH1', 'pm'), ('t3', 'CH2', 'idle');
    `);
  } finally {
    spc.close();
  }
}

// --- 环境变量（必须在 createServer 之前）。
const serviceToken = randomBytes(24).toString("hex");
process.env.AUTH_SESSION_SECRET = "ontology-designer-smoke-secret-0123456789abcdef";
process.env.AUTH_PUBLIC_BASE_URL = "http://127.0.0.1:3000";
process.env.AUTH_EMAIL_DELIVERY = "test";
process.env.AUTH_REGISTRATION_MODE = "open";
process.env.ONTOLOGY_SERVICE_TOKEN = serviceToken;
process.env.EMBEDDING_API_KEY = "";
process.env.MASTRA_STORAGE_PATH = join(root, "mastra.sqlite");
process.env.STORAGE_ROOT_DIR = root;

const metadataStore = createMetadataStore({
  database_path: join(root, "metadata.sqlite"),
  secret_master_key: "ontology-designer-smoke-master-key"
});
const taskStateRuntime = await createTaskStateRuntime(join(root, "task-state.sqlite"));

const server = await createApiServer({ metadataStore, taskStateRuntime });
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert(address && typeof address === "object");
const baseUrl = `http://127.0.0.1:${address.port}`;

// authenticateServiceToken 硬编码找 admin@fusion.local；Bearer 身份的 data_sources 归属该用户。
const adminClient = createAuthenticatedTestClient({ baseUrl });
const adminIdentity = await adminClient.registerAndLogin({
  email: "admin@fusion.local",
  displayName: "Ontology Designer Admin"
});

// --- 元数据侧 fixture：既有本体（AnomWafer/ToolEvent published + approved 绑定 + 1 条关系）+ SPC 数据源。
{
  ensureOntologyTables(metadataStore.db);
  metadataStore.db.exec(`
    INSERT INTO ont_ontologies (id, name) VALUES ('ont-smoke', 'SPC');
    INSERT INTO ont_entities (id, ontology_id, name, status) VALUES
      ('eid-wafer', 'ont-smoke', 'AnomWafer', 'published'),
      ('eid-tool', 'ont-smoke', 'ToolEvent', 'published');
    INSERT INTO ont_attributes (id, entity_id, name) VALUES
      ('attr-w1', 'eid-wafer', 'wafer_id'),
      ('attr-w2', 'eid-wafer', 'chamber_id'),
      ('attr-w3', 'eid-wafer', 'lot'),
      ('attr-t1', 'eid-tool', 'chamber_id'),
      ('attr-t2', 'eid-tool', 'event_name');
    INSERT INTO ont_bindings (id, entity_id, datasource_id, table_name, id_column, field_mappings_json, status) VALUES
      ('bind-wafer', 'eid-wafer', 'ds-spc-smoke', 'v_anom_wafer', 'id',
       '[{"attribute_id":"attr-w1","source_column":"wafer_id"},{"attribute_id":"attr-w2","source_column":"chamber_id"},{"attribute_id":"attr-w3","source_column":"lot"}]', 'approved'),
      ('bind-tool', 'eid-tool', 'ds-spc-smoke', 'dim_tool_event', 'id',
       '[{"attribute_id":"attr-t1","source_column":"chamber_id"},{"attribute_id":"attr-t2","source_column":"event_name"}]', 'approved');
    INSERT INTO ont_relations (id, from_entity_id, to_entity_id, name, source_field, target_field) VALUES
      ('rel-wt', 'eid-wafer', 'eid-tool', 'has_events', 'chamber_id', 'chamber_id');
  `);
  metadataStore.dataSources.create({
    id: "ds-spc-smoke",
    user_id: adminIdentity.userId,
    name: "SPC_MVP_SQLITE",
    type: "sqlite",
    config: { path: spcPath }
  });
}

// --- HTTP 辅助（raw fetch + Bearer；service 身份无 session 天然免 CSRF）。
const bearer = `Bearer ${serviceToken}`;
const request = async (method, path, body) =>
  fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      authorization: bearer
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
const getJson = (path) => request("GET", path);
const postJson = (path, body) => request("POST", path, body);
const putJson = (path, body) => request("PUT", path, body);
const delJson = (path) => request("DELETE", path);

const closeHttpServer = async (httpServer) => {
  await new Promise((resolve, reject) => {
    httpServer.close((error) => (error ? reject(error) : resolve()));
    setImmediate(() => httpServer.closeAllConnections?.());
  });
  httpServer.unref?.();
};

let passed = 0;
const check = (label, fn) => {
  fn();
  passed += 1;
  console.log(`  PASS  ${label}`);
};

try {
  // a. 未认证 → 401（写端点同样走 config-api 分发链鉴权）
  {
    const response = await fetch(`${baseUrl}/api/v1/ontology/entities`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "NoAuth" })
    });
    const body = await response.json();
    check("a. unauthenticated designer write -> 401", () => {
      assert.equal(response.status, 401, JSON.stringify(body));
      assert.equal(body.error?.code, "UNAUTHORIZED");
    });
  }

  // b. 建实体：draft + 属性；重名 409；非法名 400
  let chamberId;
  let chamberAttrId;
  {
    const created = await (await postJson("/api/v1/ontology/entities", {
      name: "Chamber",
      nameCn: "腔体",
      description: "设计器 slice 验收",
      attributes: [
        { name: "chamber_id", displayName: "腔体", type: "string", required: true },
        { name: "lot", type: "string" }
      ]
    })).json();
    check("b1. create entity -> draft with attributes", () => {
      assert.equal(created.success, true, JSON.stringify(created));
      assert.equal(created.data.status, "draft");
      assert.equal(created.data.name_cn, "腔体");
      assert.deepEqual(created.data.attributes.map((a) => a.name), ["chamber_id", "lot"]);
      chamberId = created.data.id;
      chamberAttrId = created.data.attributes[0].id;
    });

    const duplicate = await (await postJson("/api/v1/ontology/entities", { name: "Chamber" })).json();
    check("b2. duplicate entity -> 409", () => {
      assert.equal(duplicate.error?.code, "CONFLICT", JSON.stringify(duplicate));
    });

    const unsafe = await (await postJson("/api/v1/ontology/entities", { name: "Bad(Name" })).json();
    check("b3. regex-metachar name -> 400", () => {
      assert.equal(unsafe.error?.code, "BAD_REQUEST", JSON.stringify(unsafe));
    });
  }

  // c. 绑定闭环：PUT 自动建行（draft）→ 审批 approved。
  //    故意带一个未知 attribute_id：审批门的物理校验（表/列存在+覆盖率）能过，
  //    映射完整性留给查询期 resolveBinding 显式失败（fail-closed，见 d1）。
  {
    const bind = await (await putJson("/api/v1/ontology/bindings/Chamber", {
      table: "v_anom_wafer",
      idColumn: "id",
      fieldMappings: [
        { attribute_id: chamberAttrId, source_column: "chamber_id" },
        { attribute_id: "missing-attr", source_column: "lot" }
      ]
    })).json();
    check("c1. first binding save auto-creates draft binding", () => {
      assert.equal(bind.success, true, JSON.stringify(bind));
      assert.equal(bind.data.status, "draft");
    });

    const approve = await (await postJson("/api/v1/ontology/bindings/Chamber/approve", {})).json();
    check("c2. approve passes physical checks", () => {
      assert.equal(approve.success, true, JSON.stringify(approve));
      assert.equal(approve.data?.status, "approved");
    });
  }

  // d. 坏映射在查询期 fail-closed；修复映射（正确 attribute_id）→ 重新审批 → 查询恢复
  {
    const broken = await (await postJson("/api/v1/ontology/query", { entity: "Chamber" })).json();
    check("d1. broken attribute mapping fails closed at query", () => {
      assert.equal(broken.success, false, JSON.stringify(broken));
    });

    const entities = (await (await getJson("/api/v1/ontology/entities")).json()).data.entities;
    const chamber = entities.find((e) => e.name === "Chamber");
    const lotAttr = chamber.attributes.find((a) => a.name === "lot");
    const fixed = await (await putJson("/api/v1/ontology/bindings/Chamber", {
      table: "v_anom_wafer",
      idColumn: "id",
      fieldMappings: [
        { attribute_id: chamberAttrId, source_column: "chamber_id" },
        { attribute_id: lotAttr.id, source_column: "lot" }
      ]
    })).json();
    check("d2. re-save with correct mappings", () => {
      assert.equal(fixed.success, true, JSON.stringify(fixed));
      assert.equal(fixed.data.status, "draft");
    });

    const approve = await (await postJson("/api/v1/ontology/bindings/Chamber/approve", {})).json();
    check("d3. re-approve", () => {
      assert.equal(approve.data?.status, "approved", JSON.stringify(approve));
    });

    const query = await (await postJson("/api/v1/ontology/query", { entity: "Chamber" })).json();
    check("d4. query designer entity returns physical rows", () => {
      assert.equal(query.success, true, JSON.stringify(query));
      assert.deepEqual(query.data.columns, ["chamber_id", "lot"]);
      assert.equal(query.data.rowCount, 3);
    });
  }

  // e. 属性同步：保 id 更新 + 新增；删被引用属性 400
  {
    const before = (await (await getJson("/api/v1/ontology/entities")).json()).data.entities
      .find((e) => e.name === "Chamber");
    const synced = await (await putJson("/api/v1/ontology/entities/Chamber", {
      nameCn: "腔体（改）",
      attributes: [
        { name: "chamber_id", displayName: "腔体编号", type: "string", required: true },
        { name: "lot", type: "string" },
        { name: "capacity", type: "number" }
      ]
    })).json();
    check("e1. attribute sync keeps ids and adds new", () => {
      assert.equal(synced.success, true, JSON.stringify(synced));
      assert.equal(synced.data.name_cn, "腔体（改）");
      const kept = synced.data.attributes.find((a) => a.name === "chamber_id");
      assert.equal(kept.id, chamberAttrId, "chamber_id 的 id 必须保持");
      assert.ok(synced.data.attributes.find((a) => a.name === "capacity"));
    });

    const blocked = await (await putJson("/api/v1/ontology/entities/Chamber", {
      attributes: [{ name: "capacity", type: "number" }]
    })).json();
    check("e2. deleting binding-referenced attributes -> 400", () => {
      assert.equal(blocked.error?.code, "BAD_REQUEST", JSON.stringify(blocked));
      assert.match(blocked.error?.message ?? "", /chamber_id/);
    });
  }

  // f. 关系 + traverse 经新关系跨实体
  {
    const rel = await (await postJson("/api/v1/ontology/relations", {
      name: "wafer_same_chamber",
      fromEntity: "AnomWafer",
      toEntity: "Chamber",
      cardinality: "N:1",
      sourceField: "chamber_id",
      targetField: "chamber_id"
    })).json();
    check("f1. create relation over designer entity", () => {
      assert.equal(rel.success, true, JSON.stringify(rel));
      assert.equal(rel.data.from_entity, "AnomWafer");
      assert.equal(rel.data.to_entity, "Chamber");
    });

    const traverse = await (await postJson("/api/v1/ontology/traverse", {
      fromEntity: "AnomWafer",
      fromFilters: { wafer_id: "W-001" },
      toEntity: "Chamber"
    })).json();
    check("f2. traverse uses the new relation", () => {
      assert.equal(traverse.success, true, JSON.stringify(traverse));
      assert.deepEqual(traverse.data.columns, ["chamber_id", "lot"]);
      assert.deepEqual(traverse.data.rows, [["CH1", "L1"]]);
    });

    const duplicate = await (await postJson("/api/v1/ontology/relations", {
      name: "wafer_same_chamber",
      fromEntity: "AnomWafer",
      toEntity: "Chamber"
    })).json();
    check("f3. duplicate relation -> 409", () => {
      assert.equal(duplicate.error?.code, "CONFLICT", JSON.stringify(duplicate));
    });

    const badField = await (await postJson("/api/v1/ontology/relations", {
      name: "bad_field",
      fromEntity: "AnomWafer",
      toEntity: "Chamber",
      sourceField: "a b"
    })).json();
    check("f4. unsafe relation field -> 400", () => {
      assert.equal(badField.error?.code, "BAD_REQUEST", JSON.stringify(badField));
    });
  }

  // g. 版本流：设计器实体进版本 → submit → publish
  {
    const entities = (await (await getJson("/api/v1/ontology/entities")).json()).data.entities;
    const chamber = entities.find((e) => e.name === "Chamber");
    const created = await (await postJson("/api/v1/ontology/versions", {
      name: "v-designer-slice",
      entityIds: ["eid-wafer", chamber.id]
    })).json();
    check("g1. version create with designer entity", () => {
      assert.equal(created.success, true, JSON.stringify(created));
      assert.equal(created.data.status, "draft");
    });
    const submitted = await (await postJson(`/api/v1/ontology/versions/${created.data.id}/submit`, {})).json();
    check("g2. submit passes consistency checks", () => {
      assert.equal(submitted.data?.status, "submitted", JSON.stringify(submitted));
    });
    const published = await (await postJson(`/api/v1/ontology/versions/${created.data.id}/publish`, {})).json();
    check("g3. publish", () => {
      assert.equal(published.data?.status, "published", JSON.stringify(published));
    });
  }

  // h. 删除守卫：版本登记 409；干净 draft 级联删；published 409
  {
    const blocked = await (await delJson("/api/v1/ontology/entities/Chamber")).json();
    check("h1. version-registered entity delete -> 409", () => {
      assert.equal(blocked.error?.code, "CONFLICT", JSON.stringify(blocked));
    });

    await postJson("/api/v1/ontology/entities", { name: "Throwaway", attributes: [{ name: "code" }] });
    const rel = await (await postJson("/api/v1/ontology/relations", {
      name: "throwaway_rel",
      fromEntity: "Throwaway",
      toEntity: "Chamber"
    })).json();
    const relId = rel.data.id;
    const deleted = await (await delJson("/api/v1/ontology/entities/Throwaway")).json();
    check("h2. clean draft delete cascades relations", () => {
      assert.equal(deleted.success, true, JSON.stringify(deleted));
    });
    const relGone = await (await delJson(`/api/v1/ontology/relations/${relId}`)).json();
    check("h3. cascaded relation is gone (404)", () => {
      assert.equal(relGone.error?.code, "RESOURCE_NOT_FOUND", JSON.stringify(relGone));
    });

    const publishedDelete = await (await delJson("/api/v1/ontology/entities/AnomWafer")).json();
    check("h4. published entity delete -> 409", () => {
      assert.equal(publishedDelete.error?.code, "CONFLICT", JSON.stringify(publishedDelete));
    });
  }

  console.log(`Ontology designer smoke OK: ${passed} assertion groups passed (modeling -> binding -> approve -> version -> traverse -> delete guards)`);
} finally {
  await closeHttpServer(server);
  closeCachedOntologyConnections();
  try {
    metadataStore.close();
    taskStateRuntime.close?.();
  } catch {
    // best-effort
  }
  try {
    rmSync(root, { recursive: true, force: true });
  } catch (error) {
    console.warn(`[cleanup] temp dir partially removed (best-effort): ${root} (${error.code ?? error.message})`);
  }
}
