// Mount the ontology-logic MCP server (services/ontology-logic, streamable-http
// on 127.0.0.1:8902/mcp) into the live workbench as a kind="mcp-server"
// config_resource so DataFoundry agent runs pick it up through the standard
// run-config path (run-config-resolver.buildMcpServerConfig consumes
// transport/serverUrl/toolManifest; default_enabled=true puts it in workspace
// defaults -> enabledMcpServerIds without any client-side run_config).
//
// Idempotent: upserts by (workspace, user, kind, id); re-running refreshes the
// manifest and bumps revision. Run while apps/api is up — better-sqlite3 WAL
// readers see committed rows immediately, no restart needed.
//
// Usage: node scripts/mount-ontology-mcp.mjs [workbench.sqlite path]
//   default path: apps/api/storage/metadata/workbench.sqlite (live workbench)

import { createMetadataStore } from "../packages/metadata/dist/index.js";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const dbPath = process.argv[2] ?? join(repoRoot, "apps", "api", "storage", "metadata", "workbench.sqlite");

const ID = "ontology-logic";
const KIND = "mcp-server";
const USER_ID = "6d7962f9-ea0e-4014-80e1-23ac703e16f3";
const WORKSPACE_ID = `personal-${USER_ID}`;
const MCP_URL = "http://127.0.0.1:8902/mcp";

// toolManifest mirrors the FastMCP registrations in
// services/ontology-logic/src/ontology_logic/mcp/server.py (schemas simplified
// to plain JSON Schema — FastMCP pydantic titles are dropped, enums kept).
const TOOL_MANIFEST = [
  {
    name: "ontology_run_logic",
    description:
      "Run one registered SPC/RCA logic function in the ontology-logic sandbox and return its JSON result. "
      + "logic_name: \"spc_detect\" (SPC 离群检测锚定，输出 {anchor: station/window/baseline/anomalies}) → "
      + "\"rca_rank\" (根因候选因子统计排名，输出 {ranking, top1, top_chamber}) → "
      + "\"rca_evidence\" (根因证据评分与门控，输出 {conclusion, confidence, gate}；params.candidates 必填 rca_rank 输出的 ranking 列表)。"
      + "典型 RCA 链路：spc_detect → rca_rank(带 anchor 上下文参数) → rca_evidence(带 ranking)。错误时 isError content 原文可直接自纠。",
    inputSchema: {
      type: "object",
      properties: {
        logic_name: { type: "string", enum: ["spc_detect", "rca_rank", "rca_evidence"], description: "注册函数名" },
        params: { type: "object", additionalProperties: true, description: "函数入参（rca_evidence 必填 candidates）" }
      },
      required: ["logic_name"]
    }
  },
  {
    name: "ontology_query",
    description:
      "Query rows of one ontology entity through the apps/api HTTP callback (Bearer service token). "
      + "entity: 实体名（AnomWafer、RcaDaily、ToolEvent、WindowConfig 等）；filters: 等值/范围过滤 "
      + "（如 {\"lot_id\":\"L1\"}、{\"stat_date\":{\"gte\":\"2026-09-21\"}}）。返回 {\"rows\":[dict],\"rowCount\":n}。",
    inputSchema: {
      type: "object",
      properties: {
        entity: { type: "string", description: "本体实体名" },
        filters: { type: "object", additionalProperties: true, description: "等值/范围过滤条件" },
        limit: { type: "integer", default: 100 },
        offset: { type: "integer", default: 0 },
        apply_rules: { type: "boolean", default: false, description: "true 时按启用的推理规则对每行追加 rule_conclusions 结论标注列" }
      },
      required: ["entity"]
    }
  },
  {
    name: "ontology_run_action",
    description:
      "Run one ontology action (agent-invokable contract declared in the ontology governance workbench) "
      + "and return its result. action_code: 行为英文标识（ontology_context 的 actions 清单，含 intent/风险/参数契约）；"
      + "params: 参数契约入参；mode: simulate=仿真预览（≤20 行，不留痕）/ execute=执行并留痕。"
      + "典型用途：按意图标签匹配后执行只读查询动作（如 查询异常明细）。错误时 isError content 原文可直接自纠。",
    inputSchema: {
      type: "object",
      properties: {
        action_code: { type: "string", description: "行为英文标识" },
        params: { type: "object", additionalProperties: true, description: "行为参数契约入参" },
        mode: { type: "string", enum: ["simulate", "execute"], default: "execute", description: "仿真或执行" }
      },
      required: ["action_code"]
    }
  },
  {
    name: "ontology_eval_rule",
    description:
      "Evaluate one ontology inference/validation rule against its bound data and return matching rows "
      + "with a rule_conclusion label column. rule_name: 规则名（ontology_context 的 rules 清单含 expr 可读表达式）；"
      + "filters: 可选行级过滤（与规则条件 AND 组合）。典型用途：验证业务判断是否命中数据（如 VIP 客户标记）。",
    inputSchema: {
      type: "object",
      properties: {
        rule_name: { type: "string", description: "规则名" },
        entity: { type: "string", description: "限定作用对象（可选）" },
        filters: { type: "object", additionalProperties: true, description: "行级过滤条件" },
        limit: { type: "integer", default: 10, maximum: 100 }
      },
      required: ["rule_name"]
    }
  },
  {
    name: "ontology_apply_rules",
    description:
      "Apply ALL enabled inference rules of one ontology entity to its bound data in one call, "
      + "returning rows annotated with rule_labels (THEN conclusions). entity: 实体名；"
      + "filters: 可选行级过滤。典型用途：回答「这批数据里哪些行命中了我们的业务规则」。"
      + "规则在治理台逻辑规则页签维护。",
    inputSchema: {
      type: "object",
      properties: {
        entity: { type: "string", description: "本体实体名" },
        filters: { type: "object", additionalProperties: true, description: "行级过滤条件" },
        limit: { type: "integer", default: 50, maximum: 200 }
      },
      required: ["entity"]
    }
  },
  {
    name: "ontology_ping",
    description: "Connectivity check for the ontology-logic MCP server. Returns {\"pong\": true}.",
    inputSchema: { type: "object", properties: {} }
  }
];

const store = createMetadataStore({ database_path: dbPath });
const record = store.configResources.upsert({
  id: ID,
  workspace_id: WORKSPACE_ID,
  user_id: USER_ID,
  kind: KIND,
  name: "ontology-logic",
  description: "ontology-logic sidecar MCP (streamable-http, 127.0.0.1:8902/mcp): SPC 检测 / RCA 排名与证据沙箱工具",
  payload: {
    transport: "streamable-http",
    serverUrl: MCP_URL,
    toolManifest: TOOL_MANIFEST,
    timeoutMs: 60000
  },
  default_enabled: true,
  builtin: false,
  status: "ready"
});

console.log(JSON.stringify({
  mounted: true,
  database_path: dbPath,
  id: record.id,
  kind: record.kind,
  status: record.status,
  default_enabled: record.default_enabled === 1 || record.default_enabled === true,
  revision: record.revision,
  serverUrl: record.payload.serverUrl,
  tools: record.payload.toolManifest.map((tool) => tool.name)
}, null, 2));
