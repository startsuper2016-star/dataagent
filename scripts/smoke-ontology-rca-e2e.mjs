// Slice acceptance E2E (Phase 2 Task 5): drive one RCA conversation against the
// live apps/api (8787) CopilotKit AG-UI endpoint and assert that the
// ontology-logic MCP server — mounted as a config_resource (scripts/mount-ontology-mcp.mjs)
// — is resolved, called, and its SPC/RCA chain lands in the answer.
//
// Auth: Authorization: Bearer <ONTOLOGY_SERVICE_TOKEN> (headless service identity,
// apps/api/src/server.ts resolveRequestAuth) — read from the repo root .env.
// Mount proof: the run sends NO run_config — enabledMcpServerIds comes purely from
// workspace defaults (config-driven mount).
//
// Usage: node scripts/smoke-ontology-rca-e2e.mjs [baseUrl]   (default http://127.0.0.1:8787)

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const baseUrl = (process.argv[2] ?? "http://127.0.0.1:8787").replace(/\/$/u, "");

// --- env ---------------------------------------------------------------------

const envText = readFileSync(join(repoRoot, ".env"), "utf8");
const envValue = (key) => {
  const match = envText.split(/\r?\n/).find((line) => line.startsWith(`${key}=`));
  return match ? match.slice(key.length + 1).trim() : undefined;
};
const serviceToken = envValue("ONTOLOGY_SERVICE_TOKEN");
if (!serviceToken) {
  throw new Error("ONTOLOGY_SERVICE_TOKEN missing from repo root .env");
}

// --- prompt ------------------------------------------------------------------

const PROMPT = process.env.RCA_PROMPT
  ?? "对 PVD_TI 站点 Rs_Ti 参数执行近 30 天异常根因分析。请使用 ontology_run_logic 工具按链路执行："
  + "先用 spc_detect 锚定异常，再用 rca_rank 排名候选因子，最后用 rca_evidence 给出证据评分与处置门控，"
  + "并在最终回答中给出 Top1 因子、置信度数值和 gate 建议。";

// --- AG-UI run ----------------------------------------------------------------

const threadId = randomUUID();
const runId = randomUUID();
const started = Date.now();
const response = await fetch(`${baseUrl}/api/copilotkit`, {
  method: "POST",
  headers: {
    Accept: "text/event-stream",
    "Content-Type": "application/json",
    Authorization: `Bearer ${serviceToken}`
  },
  body: JSON.stringify({
    method: "agent/run",
    params: { agentId: "dataFoundry" },
    body: {
      threadId,
      runId,
      state: {},
      messages: [{ id: `${runId}:user`, role: "user", content: PROMPT }],
      tools: [],
      context: [],
      forwardedProps: {} // no run_config on purpose: MCP mount must come from workspace defaults
    }
  }),
  signal: AbortSignal.timeout(10 * 60 * 1000)
});
if (!response.ok) {
  throw new Error(`Agent API failed (${response.status}): ${await response.text()}`);
}

const events = parseEventStream(await response.text());
const elapsedSec = ((Date.now() - started) / 1000).toFixed(1);

function parseEventStream(text) {
  return text
    .split("\n\n")
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.startsWith("data: "))
    .map((chunk) => chunk.slice("data: ".length))
    .filter((chunk) => chunk !== "[DONE]")
    .map((chunk) => {
      try {
        return JSON.parse(chunk);
      } catch {
        return { type: "UNPARSED", raw: chunk };
      }
    });
}

// --- collect evidence ----------------------------------------------------------

const answer = events
  .filter((event) => event.type === "TEXT_MESSAGE_CONTENT" && typeof event.delta === "string")
  .map((event) => event.delta)
  .join("");

const configResolved = events.find((event) => event.type === "CUSTOM" && event.name === "run.config.resolved");

const toolCalls = [];
const toolNameById = new Map();
for (const event of events) {
  if (event.type === "TOOL_CALL_START" && typeof event.toolCallId === "string") {
    toolNameById.set(event.toolCallId, event.toolCallName);
    toolCalls.push({ id: event.toolCallId, name: event.toolCallName, args: "", result: "" });
  } else if (event.type === "TOOL_CALL_ARGS" && typeof event.toolCallId === "string") {
    const call = toolCalls.find((call) => call.id === event.toolCallId);
    if (call) {
      call.args += typeof event.delta === "string" ? event.delta : "";
    }
  } else if (event.type === "TOOL_CALL_RESULT" && typeof event.toolCallId === "string") {
    const call = toolCalls.find((call) => call.id === event.toolCallId);
    const name = event.toolCallName ?? toolNameById.get(event.toolCallId);
    if (call) {
      call.result = typeof event.content === "string" ? event.content : JSON.stringify(event.content ?? "");
    } else if (name) {
      toolCalls.push({ id: event.toolCallId, name, args: "", result: typeof event.content === "string" ? event.content : JSON.stringify(event.content ?? "") });
    }
  }
}

const runError = events.findLast?.((event) => event.type === "RUN_ERROR")
  ?? [...events].reverse().find((event) => event.type === "RUN_ERROR");
const runFinished = [...events].reverse().find((event) => event.type === "RUN_FINISHED");

console.log("=== run identity ===");
console.log(JSON.stringify({ threadId, runId, elapsedSec, events: events.length }));
console.log("=== run.config.resolved ===");
console.log(JSON.stringify(configResolved?.value?.payload ?? configResolved?.value ?? null, null, 2));
console.log("=== tool calls ===");
for (const call of toolCalls) {
  console.log(`-- ${call.name} args=${call.args.slice(0, 300)}`);
  console.log(`   result=${call.result.slice(0, 500)}`);
}
console.log("=== run terminal ===");
console.log(JSON.stringify({ runError: runError?.message ?? null, runFinished: runFinished ? true : false }));
console.log("=== answer ===");
console.log(answer);

// --- assertions -----------------------------------------------------------------

const ontologyConfig = configResolved?.value?.payload?.enabled_mcp_server_ids
  ?? configResolved?.value?.enabled_mcp_server_ids;
assert.ok(
  Array.isArray(ontologyConfig) && ontologyConfig.includes("ontology-logic"),
  `MCP mount not resolved into run config: ${JSON.stringify(ontologyConfig)}`
);
assert.ok(!runError, `RUN_ERROR: ${runError?.message}`);
assert.ok(runFinished, "missing RUN_FINISHED");

const logicCalls = toolCalls.filter((call) => call.name === "ontology_run_logic");
assert.ok(logicCalls.length >= 1, `expected >=1 ontology_run_logic call, got ${toolCalls.map((call) => call.name)}`);

// Top1 factor: CH_B must appear in a rca_rank result (and ideally the answer).
const rankResults = logicCalls
  .filter((call) => call.args.includes("rca_rank"))
  .map((call) => call.result);
const rankText = rankResults.join("\n") || JSON.stringify(logicCalls.map((call) => call.result));
assert.ok(/CH_B|CH_B 前后偏移/u.test(rankText), `rca_rank result missing CH_B top1: ${rankText.slice(0, 400)}`);

// Confidence ~0.87/0.875 and gate auto_ticket from rca_evidence.
const evidenceResults = logicCalls
  .filter((call) => call.args.includes("rca_evidence"))
  .map((call) => call.result);
const evidenceText = evidenceResults.join("\n") || rankText;
let confidence = null;
let gate = null;
for (const result of evidenceResults) {
  // ontology_run_logic returns CallToolResult content JSON, surfaced by the
  // runtime as {"tool_name","content":"<json string>"} — unwrap before parsing.
  const candidates = [];
  try {
    const parsed = JSON.parse(result);
    candidates.push(parsed);
    if (typeof parsed?.content === "string") {
      try {
        candidates.push(JSON.parse(parsed.content));
      } catch {
        // content is not JSON
      }
    }
  } catch {
    // tool result may be wrapped differently; fall back to the answer assertions below
  }
  for (const parsed of candidates) {
    if (Number.isFinite(parsed?.confidence)) {
      confidence = parsed.confidence;
    }
    if (typeof parsed?.gate === "string") {
      gate = parsed.gate;
    }
  }
}
const confidenceSource = confidence !== null ? "tool-result" : "answer";
const confidenceValue = confidence ?? Number(answer.match(/0\.8[0-9]{1,2}/u)?.[0]);
assert.ok(
  Number.isFinite(confidenceValue) && confidenceValue >= 0.85 && confidenceValue <= 0.9,
  `confidence not in 0.85..0.9 band: ${confidenceValue} (source=${confidenceSource}); answer=${answer.slice(0, 400)}`
);
const gateValue = gate ?? (answer.match(/auto_ticket|自动开单/u)?.[0] ?? null);
assert.ok(gateValue, `gate suggestion missing (expected auto_ticket/自动开单); answer=${answer.slice(0, 400)}`);
assert.ok(
  /CH_B/u.test(answer),
  "final answer does not mention Top1 factor CH_B"
);

console.log("=== assertions ===");
console.log(JSON.stringify({
  mcp_mount_resolved: ontologyConfig,
  ontology_run_logic_calls: logicCalls.length,
  top1_CH_B: true,
  confidence: confidenceValue,
  confidence_source: confidenceSource,
  gate: gateValue
}, null, 2));
console.log(`RCA E2E OK (${elapsedSec}s): mcp=ontology-logic mounted+called, top1=CH_B, confidence=${confidenceValue}, gate=${gateValue}`);
