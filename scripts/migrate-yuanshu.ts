/**
 * migrate-yuanshu.ts — 元枢权威库 (ontology.db) → workbench.sqlite ont_* 一次性迁移
 *
 * 用法：
 *   npx tsx scripts/migrate-yuanshu.ts --yuanshu <ontology.db 绝对路径> --workbench <workbench.sqlite 绝对路径>
 *
 * 硬性前置（单写者纪律）：运行时 apps/api 必须停止。脚本开头自检 127.0.0.1:8787，
 * 仍在监听则报错退出并给出停止命令。
 *
 * 迁移范围（源自 2026-10-22 只读侦查，与 brief 的适配见各 SCOPE 注释）：
 *   - 本体 id 固定 cf68712c-e3fc-427d-ab80-8530261a6bc0（scenario code = semi-mfg-base）。
 *   - "14 个 SPC 对象" 实际落点 = 该本体下 tier=2 且 status='published' 的实体
 *     （本体共 41 实体：17 个 tier-2 里有 3 个 status='active'（M2mCorr/ScanRecord/WindowConfig），
 *      24 个 tier-3 MES 主数据；active/tier-3 均不在 14 之列）。
 *   - 全部 ont_* 采用 INSERT OR REPLACE，保留元枢原 id。
 *
 * 与 brief 规格的差异适配（侦查实录）：
 *   1. workbench 侧数据源表实名是 `data_sources`（非 datasources）。
 *   2. object_bindings 自带 id_column 列，直接采用；table_name 取 assets.locator JSON 的 $.table。
 *   3. skills 无 entity_ids 列 —— entity_ids 存于 skill_versions.snapshot_json（取 current_version 快照）。
 *   4. entity_attributes 无 display_name 类列 → display_name 一律取 name（brief 的"若无则 name"分支）。
 *   5. ontology_versions 无 config_snapshot_json 对应列 → 目标列置 NULL。
 *   6. relations：brief 点名 anom_wafer_chamber_events；落库取"两端均在 14 实体内"的全部关系
 *      （15 条，含 anom_wafer_chamber_events；断言 relations>=1 且点名关系必须存在）。
 *   7. functions：6 条 = ontology_id=ONT 且 entity_id IS NOT NULL（其余 4 条 m2m_rank/fuse_conclusions/
 *      auto_scan/rca_writeback_case 的 entity_id 为 NULL、entity_ids='[]'，不在 6 条之列）。
 */
import net from "node:net";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { ensureOntologyTables } from "../packages/ontology/src/schema.js";

const ONT_ID = "cf68712c-e3fc-427d-ab80-8530261a6bc0";
const ONT_NAME = "semi-mfg-base";
const DS_NAME = "SPC_MVP_SQLITE";
const SPC_DB_PATH =
  "C:/Users/shuan/Downloads/ontology-master (3)/ontology-master/local-data/spc_mvp/spc_mvp.db";
const API_HOST = "127.0.0.1";
const API_PORT = 8787;

// ---------------------------------------------------------------- CLI 解析
function parseArgs(argv: string[]): { yuanshu: string; workbench: string } {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const yuanshu = get("--yuanshu");
  const workbench = get("--workbench");
  if (!yuanshu || !workbench) {
    console.error(
      "用法: npx tsx scripts/migrate-yuanshu.ts --yuanshu <ontology.db 绝对路径> --workbench <workbench.sqlite 绝对路径>",
    );
    process.exit(1);
  }
  for (const [label, p] of [["--yuanshu", yuanshu], ["--workbench", workbench]] as const) {
    if (!p.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(p)) {
      console.error(`${label} 必须是绝对路径: ${p}`);
      process.exit(1);
    }
  }
  return { yuanshu, workbench };
}

// ------------------------------------------------- 硬性前置：apps/api 停止检查
function probeApiPort(): Promise<"closed" | "listening"> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: API_HOST, port: API_PORT });
    const finish = (v: "closed" | "listening") => {
      clearTimeout(timer);
      socket.destroy();
      resolve(v);
    };
    const timer = setTimeout(() => finish("closed"), 800); // 800ms 内连不上视为未监听
    socket.once("connect", () => finish("listening"));
    socket.once("error", () => finish("closed"));
  });
}

async function assertApiStopped(): Promise<void> {
  if ((await probeApiPort()) !== "listening") return;
  console.error(
    [
      `[BLOCK] apps/api 仍在 ${API_HOST}:${API_PORT} 监听 —— 单写者纪律：迁移期间禁止 apps/api 运行。`,
      "请先停止 apps/api 再运行本脚本：",
      "  Windows:  netstat -ano | findstr :8787   # 找到 LISTENING 的 PID",
      "            taskkill //F //PID <pid>",
      "  （web(3000) 不受影响，可保留）",
    ].join("\n"),
  );
  process.exit(1);
}

// ---------------------------------------------------------------- 小工具
function fail(msg: string): never {
  console.error(`[FAIL] ${msg}`);
  process.exit(1);
}

function requireTable(db: DatabaseSync, table: string, where: string): void {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name=?")
    .get(table) as { n: number };
  if (row.n === 0) fail(`目标库缺表 ${table}（${where}）`);
}

function requireColumns(db: DatabaseSync, table: string, cols: string[], where: string): void {
  const info = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  const have = new Set(info.map((c) => c.name));
  const missing = cols.filter((c) => !have.has(c));
  if (missing.length > 0) fail(`表 ${table} 缺列 ${missing.join(", ")}（${where}）——请先核对 schema`);
}

const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

// ---------------------------------------------------------------- 主流程
const { yuanshu, workbench } = parseArgs(process.argv.slice(2));
await assertApiStopped();

const ys = new DatabaseSync(yuanshu, { readOnly: true }); // 元枢权威库：只读连接（等价"只读 ATTACH"，且连接级只读更严格）
const wb = new DatabaseSync(workbench); // workbench：读写

// --- 结构自检（先 PRAGMA 再动手，缺列即报告并停） ---
requireTable(ys, "ontology_entities", "源库");
requireTable(ys, "entity_attributes", "源库");
requireTable(ys, "entity_relations", "源库");
requireTable(ys, "ontology_functions", "源库");
requireTable(ys, "assets", "源库");
requireTable(ys, "object_bindings", "源库");
requireTable(ys, "ontology_versions", "源库");
requireTable(ys, "ontology_version_entities", "源库");
requireTable(ys, "skills", "源库");
requireTable(ys, "skill_versions", "源库");
requireTable(wb, "data_sources", "workbench");
requireTable(wb, "users", "workbench");
requireColumns(wb, "data_sources", ["id", "user_id", "name", "type", "config_json", "status", "revision", "created_at", "updated_at"], "workbench data_sources");
requireColumns(wb, "users", ["id", "email"], "workbench users");

ensureOntologyTables(wb);

// --- admin 用户 ---
const admin = wb.prepare("SELECT id FROM users WHERE email = 'admin@fusion.local'").get() as
  | { id: string }
  | undefined;
if (!admin) fail("workbench users 中未找到 admin@fusion.local，无法归属新数据源");

// ============================ 范围查询（源） ============================
// 14 个 SPC 对象 = ONT + tier=2 + published（侦查适配，见文件头注释 6/7）
const P14 =
  "(SELECT id FROM ontology_entities WHERE ontology_id='" +
  ONT_ID +
  "' AND tier=2 AND status='published')";

type Ent = {
  id: string; name: string; name_cn: string | null; tier: number;
  status: string; description: string | null; config_json: string | null;
};
const srcEntities = ys
  .prepare(
    `SELECT id, name, name_cn, tier, status, description, config_json
     FROM ontology_entities WHERE id IN ${P14} ORDER BY name`,
  )
  .all() as unknown as Ent[];

type Attr = { id: string; entity_id: string; name: string; type: string; required: number; description: string | null };
const srcAttrs = ys
  .prepare(
    `SELECT id, entity_id, name, type, required, description
     FROM entity_attributes WHERE entity_id IN ${P14} ORDER BY entity_id, name`,
  )
  .all() as unknown as Attr[];

type Rel = {
  id: string; from_entity_id: string; to_entity_id: string; name: string;
  rel_type: string; cardinality: string; source_field: string | null;
  target_field: string | null; description: string | null;
};
const srcRels = ys
  .prepare(
    `SELECT r.id, r.from_entity_id, r.to_entity_id, r.name, r.rel_type, r.cardinality,
            r.source_field, r.target_field, r.description
     FROM entity_relations r
     WHERE r.from_entity_id IN ${P14} AND r.to_entity_id IN ${P14}
     ORDER BY r.name`,
  )
  .all() as unknown as Rel[];

type Func = {
  id: string; name: string; callable_name: string; description: string | null;
  input_schema: string | null; entity_id: string | null; entity_ids: string | null;
  status: string; tags: string | null;
};
const srcFuncs = ys
  .prepare(
    `SELECT id, name, callable_name, description, input_schema, entity_id, entity_ids, status, tags
     FROM ontology_functions
     WHERE ontology_id = '${ONT_ID}' AND entity_id IS NOT NULL
     ORDER BY callable_name`,
  )
  .all() as unknown as Func[];

type Bind = {
  id: string; object_type_id: string; id_column: string | null;
  field_mappings: string; filter_expr: string | null; locator: string;
};
const srcBinds = ys
  .prepare(
    `SELECT ob.id, ob.object_type_id, ob.id_column, ob.field_mappings, ob.filter_expr, a.locator
     FROM object_bindings ob
     JOIN assets a ON a.id = ob.asset_id
     WHERE ob.object_type_id IN ${P14}
       AND a.name LIKE 'SPC_%' AND ob.role='primary' AND ob.status='active'
     ORDER BY ob.id`,
  )
  .all() as unknown as Bind[];

// 3 个 RCA/SPC 技能：current_version 快照的 entity_ids 全部落在 14 实体内
type SkillRow = { id: string; name: string; current_version: number; snapshot_json: string };
const allSkills = ys
  .prepare(
    `SELECT s.id, s.name, s.current_version, sv.snapshot_json
     FROM skills s JOIN skill_versions sv
       ON sv.skill_id = s.id AND sv.version = s.current_version`,
  )
  .all() as unknown as SkillRow[];
const id14 = new Set(srcEntities.map((e) => e.id));
const srcSkills = allSkills.filter((s) => {
  const ids = (JSON.parse(s.snapshot_json) as { entity_ids?: unknown }).entity_ids;
  return Array.isArray(ids) && ids.length > 0 && (ids as unknown[]).every((x) => id14.has(String(x)));
});

type Ver = {
  id: string; version_number: number; name: string; description: string | null;
  status: string; created_at: string | null; submitted_at: string | null; published_at: string | null;
};
const srcVers = ys
  .prepare(
    `SELECT id, version_number, name, description, status, created_at, submitted_at, published_at
     FROM ontology_versions WHERE ontology_id = '${ONT_ID}' ORDER BY version_number`,
  )
  .all() as unknown as Ver[];
const verIds = srcVers.map((v) => `'${v.id}'`).join(",");

type VerEnt = { id: string; version_id: string; source_entity_id: string };
const srcVerEnts = ys
  .prepare(
    `SELECT id, version_id, source_entity_id FROM ontology_version_entities
     WHERE version_id IN (${verIds}) ORDER BY id`,
  )
  .all() as unknown as VerEnt[];

// 源侧期望计数（校验基准，与迁移同口径）
const srcAttrCount = ys
  .prepare(`SELECT COUNT(*) AS n FROM entity_attributes WHERE entity_id IN ${P14}`)
  .get() as { n: number };

// ============================ 写入（单事务） ============================
wb.exec("BEGIN");
try {
  wb.prepare("INSERT OR REPLACE INTO ont_ontologies (id, name, code, description) VALUES (?, ?, ?, ?)")
    .run(ONT_ID, ONT_NAME, ONT_NAME, "元枢 semi-mfg-base 本体（SPC-RCA MVP，14 对象）——由 scripts/migrate-yuanshu.ts 迁移");

  const insEnt = wb.prepare(
    "INSERT OR REPLACE INTO ont_entities (id, ontology_id, name, name_cn, tier, status, description, config_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );
  for (const e of srcEntities)
    insEnt.run(e.id, ONT_ID, e.name, e.name_cn, e.tier, e.status, e.description, e.config_json);

  const insAttr = wb.prepare(
    "INSERT OR REPLACE INTO ont_attributes (id, entity_id, name, display_name, type, required, description, sort) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );
  for (const a of srcAttrs) insAttr.run(a.id, a.entity_id, a.name, a.name, a.type, a.required, a.description, 0);

  const insRel = wb.prepare(
    "INSERT OR REPLACE INTO ont_relations (id, from_entity_id, to_entity_id, name, rel_type, cardinality, source_field, target_field, description) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  for (const r of srcRels)
    insRel.run(r.id, r.from_entity_id, r.to_entity_id, r.name, r.rel_type, r.cardinality, r.source_field, r.target_field, r.description);

  // --- datasources：不存在则建（放在事务内，绑定行要引用其 id） ---
  const existingDs = wb.prepare("SELECT id FROM data_sources WHERE name = ?").get(DS_NAME) as
    | { id: string }
    | undefined;
  let dsId: string;
  if (existingDs) {
    dsId = existingDs.id;
    console.log(`[ds] data_sources 已存在 name=${DS_NAME}，复用 id=${dsId}`);
  } else {
    dsId = randomUUID();
    const now = new Date().toISOString();
    wb.prepare(
      "INSERT INTO data_sources (id, user_id, name, type, config_json, credential_ref, description, status, last_test_at, revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, NULL, ?, 'ready', NULL, 1, ?, ?)",
    ).run(dsId, admin.id, DS_NAME, "sqlite", JSON.stringify({ path: SPC_DB_PATH }), "SPC MVP sqlite 库（元枢迁移，phase1 task7）", now, now);
    console.log(`[ds] 新增 data_sources name=${DS_NAME} id=${dsId} config=${SPC_DB_PATH}`);
  }

  const insBind = wb.prepare(
    "INSERT OR REPLACE INTO ont_bindings (id, entity_id, datasource_id, table_name, id_column, filter_expr, source_sql, field_mappings_json, status) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, 'approved')",
  );
  for (const b of srcBinds) {
    let table: unknown;
    try {
      table = (JSON.parse(b.locator) as { table?: unknown }).table;
    } catch {
      fail(`binding ${b.id} 的 asset locator 不是合法 JSON`);
    }
    if (typeof table !== "string" || table.length === 0)
      fail(`binding ${b.id} 的 asset locator 缺 table 字段`);
    insBind.run(b.id, b.object_type_id, dsId, table, b.id_column, b.filter_expr, b.field_mappings);
  }

  const insFunc = wb.prepare(
    "INSERT OR REPLACE INTO ont_functions (id, name, callable_name, description, input_schema_json, entity_id, entity_ids_json, runtime, status, tags_json) VALUES (?, ?, ?, ?, ?, ?, ?, 'ontology-logic', ?, ?)",
  );
  for (const f of srcFuncs)
    insFunc.run(f.id, f.name, f.callable_name, f.description, f.input_schema, f.entity_id, f.entity_ids, f.status, f.tags);

  const insSkill = wb.prepare(
    "INSERT OR REPLACE INTO ont_skill_bindings (id, skill_id, version, skill_name, entity_ids_json) VALUES (?, ?, ?, ?, ?)",
  );
  for (const s of srcSkills) {
    const entityIds = (JSON.parse(s.snapshot_json) as { entity_ids?: unknown }).entity_ids;
    insSkill.run(s.id, s.id, s.current_version, s.name, JSON.stringify(entityIds));
  }

  const insVer = wb.prepare(
    "INSERT OR REPLACE INTO ont_versions (id, ontology_id, version_number, status, name, description, config_snapshot_json, created_at, submitted_at, published_at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)",
  );
  for (const v of srcVers)
    insVer.run(v.id, ONT_ID, v.version_number, v.status, v.name, v.description, v.created_at, v.submitted_at, v.published_at);

  const insVerEnt = wb.prepare(
    "INSERT OR REPLACE INTO ont_version_entities (version_id, version_entity_id, source_entity_id) VALUES (?, ?, ?)",
  );
  for (const ve of srcVerEnts) insVerEnt.run(ve.version_id, ve.id, ve.source_entity_id);

  wb.exec("COMMIT");
} catch (err) {
  wb.exec("ROLLBACK");
  console.error("[FAIL] 迁移事务失败，已回滚：", err);
  process.exit(1);
}

// ============================ 校验断言（提交后读目标库） ============================
const tCount = (sql: string): number => (wb.prepare(sql).get() as { n: number }).n;

const tgtEntities = tCount("SELECT COUNT(*) AS n FROM ont_entities");
const tgtAttrs = tCount("SELECT COUNT(*) AS n FROM ont_attributes");
const tgtRels = tCount("SELECT COUNT(*) AS n FROM ont_relations");
const tgtFuncs = tCount("SELECT COUNT(*) AS n FROM ont_functions");
const tgtBinds = tCount("SELECT COUNT(*) AS n FROM ont_bindings");
const tgtSkills = tCount("SELECT COUNT(*) AS n FROM ont_skill_bindings");
const tgtVers = tCount("SELECT COUNT(*) AS n FROM ont_versions");
const tgtVerEnts = tCount("SELECT COUNT(*) AS n FROM ont_version_entities");

type Check = { table: string; actual: number; expected: number; op: "==" | ">=" };
const expectations: Check[] = [
  { table: "ont_entities", actual: tgtEntities, expected: 14, op: "==" },
  { table: "ont_attributes", actual: tgtAttrs, expected: srcAttrCount.n, op: "==" },
  { table: "ont_relations", actual: tgtRels, expected: 1, op: ">=" },
  { table: "ont_functions", actual: tgtFuncs, expected: 6, op: "==" },
  { table: "ont_bindings", actual: tgtBinds, expected: 14, op: "==" },
  { table: "ont_skill_bindings", actual: tgtSkills, expected: 3, op: "==" },
  { table: "ont_versions", actual: tgtVers, expected: 1, op: ">=" },
  { table: "ont_version_entities", actual: tgtVerEnts, expected: srcVerEnts.length, op: "==" },
];
let ok = true;
for (const c of expectations) {
  const pass = c.op === "==" ? c.actual === c.expected : c.actual >= c.expected;
  ok = ok && pass;
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${c.table} = ${c.actual}（期望 ${c.op}${c.expected}）`);
}

// 点名关系必须存在
const anom = wb.prepare("SELECT COUNT(*) AS n FROM ont_relations WHERE name = 'anom_wafer_chamber_events'").get() as { n: number };
console.log(`  ${anom.n === 1 ? "PASS" : "FAIL"}  ont_relations 含 anom_wafer_chamber_events（${anom.n}）`);
ok = ok && anom.n === 1;

// 抽样：WaferFact 绑定 field_mappings_json 与源 assets/binding 链路逐字段一致
const srcWafer = ys
  .prepare(
    `SELECT ob.id_column, ob.field_mappings, json_extract(a.locator, '$.table') AS tbl
     FROM object_bindings ob
     JOIN assets a ON a.id = ob.asset_id
     JOIN ontology_entities e ON e.id = ob.object_type_id
     WHERE e.name='WaferFact' AND e.id IN ${P14} AND a.name LIKE 'SPC_%' AND ob.role='primary' AND ob.status='active'`,
  )
  .get() as { id_column: string | null; field_mappings: string; tbl: string } | undefined;
const tgtWafer = wb
  .prepare(
    `SELECT b.table_name, b.id_column, b.field_mappings_json
     FROM ont_bindings b JOIN ont_entities e ON e.id = b.entity_id
     WHERE e.name='WaferFact'`,
  )
  .get() as { table_name: string | null; id_column: string | null; field_mappings_json: string } | undefined;

if (!srcWafer || !tgtWafer) {
  console.log("  FAIL  WaferFact 绑定抽样：源或目标行缺失");
  ok = false;
} else {
  const srcParsed: unknown = JSON.parse(srcWafer.field_mappings);
  const tgtParsed: unknown = JSON.parse(tgtWafer.field_mappings_json);
  const pass =
    sameJson(srcParsed, tgtParsed) && srcWafer.tbl === tgtWafer.table_name && srcWafer.id_column === tgtWafer.id_column;
  console.log(
    `  ${pass ? "PASS" : "FAIL"}  WaferFact 抽样：table(${tgtWafer.table_name}) id_column(${tgtWafer.id_column}) field_mappings ${Array.isArray(srcParsed) ? (srcParsed as unknown[]).length : "?"} 项逐字段一致`,
  );
  ok = ok && pass;
}

console.log("\n=== 迁移结果 ===");
console.log(`  ont_ontologies        = ${tCount("SELECT COUNT(*) AS n FROM ont_ontologies")}（1）`);
for (const [table, actual] of [
  ["ont_entities", tgtEntities],
  ["ont_attributes", tgtAttrs],
  ["ont_relations", tgtRels],
  ["ont_functions", tgtFuncs],
  ["ont_bindings", tgtBinds],
  ["ont_skill_bindings", tgtSkills],
  ["ont_versions", tgtVers],
  ["ont_version_entities", tgtVerEnts],
] as const)
  console.log(`  ${table.padEnd(22)}= ${actual}`);
console.log(`  data_sources.${DS_NAME} = ${wb.prepare("SELECT id FROM data_sources WHERE name=?").get(DS_NAME) ? "present" : "MISSING"}`);

if (!ok) {
  console.error("\n[FAIL] 校验断言未全部通过，exit 1");
  process.exit(1);
}
console.log("\n[OK] 元枢迁移完成，全部断言通过。");
ys.close();
wb.close();
