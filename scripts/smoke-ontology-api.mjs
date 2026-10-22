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
 * Phase 1-B Task 5 — 本体 API smoke（/api/v1/ontology/*）。
 *
 * 环境构造照抄 scripts/smoke-config-api.mjs：临时目录 + createMetadataStore(临时 sqlite)
 * + createTaskStateRuntime + createServer({ metadataStore, taskStateRuntime }) 随机端口。
 *
 * 集成断言（真实 HTTP，覆盖 T3/T4 评审要求的 Bearer/CSRF 行为）：
 *   a. 无 Authorization 头 POST query → 401
 *   b. Bearer 错值 → 401
 *   c. Bearer 对值 + unsafe POST（无 CSRF 头）→ 200（service 身份无 session，天然免 CSRF）
 *   d. session cookie + unsafe POST（无 x-csrf-token 头）→ 403 CSRF_INVALID（session 仍强制 CSRF）
 *   e. query 返回 fixture 3 行（列序 = fieldMap 键序）
 *   f. sql 端点白名单拒绝（SELECT * FROM sqlite_master → 400 含"白名单"）
 *   g. traverse 返回 DISTINCT 去重事件
 *   h. bindings 返回 approved 清单（draft 绑定不出现）
 */

const root = mkdtempSync(join(tmpdir(), "open-data-foundry-ontology-smoke-"));
const spcPath = join(root, "spc.db");

// --- 数据侧 fixture：临时 SPC sqlite（生产同构：data_sources.config_json.path 指向的物理库）。
// v_anom_wafer 3 行，其中 W-001/W-002 同 chamber（CH1）——traverse 的 DISTINCT 去重由此可证。
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

// --- 环境变量：必须在 createServer 调用前设置（auth/config loader 在调用时读 process.env）。
const serviceToken = randomBytes(24).toString("hex");
process.env.AUTH_SESSION_SECRET = "ontology-smoke-session-secret-0123456789abcdef";
process.env.AUTH_PUBLIC_BASE_URL = "http://127.0.0.1:3000";
process.env.AUTH_EMAIL_DELIVERY = "test";
process.env.AUTH_REGISTRATION_MODE = "open";
process.env.ONTOLOGY_SERVICE_TOKEN = serviceToken;
process.env.EMBEDDING_API_KEY = "";
process.env.MASTRA_STORAGE_PATH = join(root, "mastra.sqlite");
process.env.STORAGE_ROOT_DIR = root;

const metadataStore = createMetadataStore({
  database_path: join(root, "metadata.sqlite"),
  secret_master_key: "ontology-smoke-master-key"
});
const taskStateRuntime = await createTaskStateRuntime(join(root, "task-state.sqlite"));

const server = await createApiServer({ metadataStore, taskStateRuntime });
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert(address && typeof address === "object");
const baseUrl = `http://127.0.0.1:${address.port}`;

// --- 服务身份对齐：authenticateServiceToken 硬编码找 users.findByEmail("admin@fusion.local")，
// fixture 里注册的账号邮箱必须一致，Bearer 身份才有 data_sources 归属用户。
const adminClient = createAuthenticatedTestClient({ baseUrl });
const adminIdentity = await adminClient.registerAndLogin({
  email: "admin@fusion.local",
  displayName: "Ontology Admin"
});
const adminUserId = adminIdentity.userId;

// --- 元数据侧 fixture：ont_* 最小本体（AnomWafer/ToolEvent + approved 绑定 + 1 条关系，
// 另置 1 个 draft 绑定实体验证 bindings 只列 approved）+ SPC_MVP_SQLITE 数据源行。
{
  ensureOntologyTables(metadataStore.db);
  metadataStore.db.exec(`
    INSERT INTO ont_ontologies (id, name) VALUES ('ont-smoke', 'SPC');
    INSERT INTO ont_entities (id, ontology_id, name, status) VALUES
      ('eid-wafer', 'ont-smoke', 'AnomWafer', 'published'),
      ('eid-tool', 'ont-smoke', 'ToolEvent', 'published'),
      ('eid-ghost', 'ont-smoke', 'OrphanGhost', 'published');
    INSERT INTO ont_attributes (id, entity_id, name) VALUES
      ('attr-w1', 'eid-wafer', 'wafer_id'),
      ('attr-w2', 'eid-wafer', 'chamber_id'),
      ('attr-w3', 'eid-wafer', 'lot');
    INSERT INTO ont_bindings (id, entity_id, datasource_id, table_name, id_column, field_mappings_json, status) VALUES
      ('bind-wafer', 'eid-wafer', 'ds-spc-smoke', 'v_anom_wafer', 'id',
       '{"wafer_id":"wafer_id","chamber_id":"chamber_id","lot":"lot"}', 'approved'),
      ('bind-tool', 'eid-tool', 'ds-spc-smoke', 'dim_tool_event', 'id',
       '{"chamber_id":"chamber_id","event_name":"event_name"}', 'approved'),
      ('bind-ghost', 'eid-ghost', 'ds-spc-smoke', 'ghost_table', 'id', '{"x":"x"}', 'draft');
    INSERT INTO ont_relations (id, from_entity_id, to_entity_id, name, source_field, target_field) VALUES
      ('rel-wt', 'eid-wafer', 'eid-tool', 'has_events', 'chamber_id', 'chamber_id');
  `);
  metadataStore.dataSources.create({
    id: "ds-spc-smoke",
    user_id: adminUserId,
    name: "SPC_MVP_SQLITE",
    type: "sqlite",
    config: { path: spcPath }
  });
}

// --- HTTP 辅助：raw fetch（Bearer 调用不经过 test client，避免其自动补 x-csrf-token）。
const postJson = async (path, body, authorization) =>
  fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(authorization ? { authorization } : {})
    },
    body: JSON.stringify(body)
  });

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
  const bearer = `Bearer ${serviceToken}`;
  const queryUrl = `${baseUrl}/api/v1/ontology/query`;

  // a. 无 Authorization 头 → 401
  {
    const response = await postJson("/api/v1/ontology/query", { entity: "AnomWafer" });
    const body = await response.json();
    check("a. no Authorization header -> 401", () => {
      assert.equal(response.status, 401, JSON.stringify(body));
      assert.equal(body.error?.code, "UNAUTHORIZED");
    });
  }

  // b. Bearer 错值 → 401
  {
    const response = await postJson("/api/v1/ontology/query", { entity: "AnomWafer" }, "Bearer not-the-service-token");
    const body = await response.json();
    check("b. wrong bearer token -> 401", () => {
      assert.equal(response.status, 401, JSON.stringify(body));
      assert.equal(body.error?.code, "UNAUTHORIZED");
    });
  }

  // c. Bearer 对值 + unsafe POST 无 CSRF 头 → 200（service 身份无 session，跳过 CSRF）
  //    —— T3 评审要求的 Bearer+unsafe 免 CSRF 集成断言。
  {
    const response = await postJson("/api/v1/ontology/query", { entity: "AnomWafer" }, bearer);
    const body = await response.json();
    check("c. correct bearer + unsafe POST without CSRF header -> 200", () => {
      assert.equal(response.status, 200, JSON.stringify(body));
      assert.equal(body.success, true);
    });
  }

  // d. session 身份 + unsafe POST 无 x-csrf-token 头 → 403 CSRF_INVALID
  //    —— CSRF 对 session 仍强制（带 cookie 但不发 CSRF 头的 raw fetch）。
  {
    const response = await fetch(queryUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: adminClient.cookies.headerValue()
      },
      body: JSON.stringify({ entity: "AnomWafer" })
    });
    const body = await response.json();
    check("d. session cookie + unsafe POST without x-csrf-token -> 403 CSRF_INVALID", () => {
      assert.equal(response.status, 403, JSON.stringify(body));
      assert.equal(body.error?.code, "CSRF_INVALID");
    });
  }

  // e. query 正常返回 fixture 3 行，列序 = fieldMap 键序（wafer_id, chamber_id, lot）
  {
    const response = await postJson("/api/v1/ontology/query", { entity: "AnomWafer" }, bearer);
    const body = await response.json();
    check("e. query returns 3 fixture rows (column order = fieldMap order)", () => {
      assert.equal(response.status, 200, JSON.stringify(body));
      assert.deepEqual(body.data, {
        columns: ["wafer_id", "chamber_id", "lot"],
        rows: [
          ["W-001", "CH1", "L1"],
          ["W-002", "CH1", "L1"],
          ["W-003", "CH2", "L2"]
        ],
        rowCount: 3
      });
    });
  }

  // f. sql 端点白名单拒绝：未引用任何绑定对象的 SQL → 400（消息含"白名单"）
  {
    const response = await postJson("/api/v1/ontology/sql", { sql: "SELECT * FROM sqlite_master" }, bearer);
    const body = await response.json();
    check("f. sql whitelist rejects sqlite_master probe -> 400", () => {
      assert.equal(response.status, 400, JSON.stringify(body));
      assert.match(String(body.error?.message ?? ""), /白名单/u);
    });
  }

  // g. traverse 返回 DISTINCT 去重事件：W-001/W-002 同 chamber 都 JOIN 到 t1/t2，
  //    未去重时 alarm/pm 会各出现两次；去重后恰 3 行。
  {
    const response = await postJson(
      "/api/v1/ontology/traverse",
      { fromEntity: "AnomWafer", toEntity: "ToolEvent" },
      bearer
    );
    const body = await response.json();
    check("g. traverse returns deduplicated events", () => {
      assert.equal(response.status, 200, JSON.stringify(body));
      assert.deepEqual(body.data, {
        columns: ["chamber_id", "event_name"],
        rows: [
          ["CH1", "alarm"],
          ["CH1", "pm"],
          ["CH2", "idle"]
        ],
        rowCount: 3
      });
    });
  }

  // h. bindings 返回 approved 清单（draft 的 OrphanGhost 绑定不出现）
  {
    const response = await fetch(`${baseUrl}/api/v1/ontology/bindings`, {
      headers: { authorization: bearer }
    });
    const body = await response.json();
    check("h. bindings lists approved bindings only", () => {
      assert.equal(response.status, 200, JSON.stringify(body));
      assert.deepEqual(body.data, {
        bindings: [
          { entity: "AnomWafer", table: "v_anom_wafer", status: "approved" },
          { entity: "ToolEvent", table: "dim_tool_event", status: "approved" }
        ]
      });
    });
  }

  console.log(`Ontology API smoke OK: ${passed} assertion groups passed (bearer/csrf integration, query/sql/traverse/bindings)`);
} finally {
  // 顺序：先关 HTTP server（其 close 钩子会关 metadataStore），再关 task-state 运行时，
  // 最后关路由层数据连接缓存（Windows 下打开中的 sqlite 文件会让 rmSync 失败）。
  await closeHttpServer(server);
  await taskStateRuntime.close();
  closeCachedOntologyConnections();
  // Windows 下句柄释放略有延迟：带退避重试删临时目录，仍失败仅告警不致败
  let tempRemoved = false;
  for (let attempt = 1; ; attempt += 1) {
    try {
      rmSync(root, { recursive: true, force: true });
      tempRemoved = true;
      break;
    } catch (warning) {
      if (attempt >= 10) {
        console.warn(`[warn] failed to remove temp dir ${root}:`, warning?.message ?? warning);
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  console.log(`[cleanup] temp dir ${tempRemoved ? "removed" : "partially removed (best-effort)"}: ${root}`);
}

process.exit(0);
