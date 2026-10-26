"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { ontologyFetch } from "../../../../lib/ontology-client";

/**
 * 数据本体 · 本体构建工作台
 *
 * 交互骨架参照 agent-bi-flow/docs/prototype-design/ontology-blueprint-workbench-prototype-v2.html：
 * 面板形态嵌入工作台主区（onBack 返回会话流）；也可经 /ontology 独立路由全屏使用。
 * 三个页签 —— 本体管理（对象树 + 详情子页签）/ 建模画布（关系图 + 资源托盘 + 路径检索）/ 校验与版本
 * （阻塞检查 + 版本时间线）；视觉使用 DataFoundry 工作台设计 token（globals.css），不引入原型的纸感主题。
 *
 * 后端能力映射：对象=ont_entities(+attributes)、映射=ont_bindings（编辑/审批门）、
 * 关系=ont_relations、逻辑=ont_functions（只读）、版本=ont_versions（check/submit/publish）、
 * 路径检索=/traverse。原型中的业务域/规则/动作/探针/RDF 导出后端暂无对应表，未纳入本版。
 */

type Attribute = {
  id: string;
  name: string;
  display_name: string | null;
  type: string;
  required: number;
};

type BindingInfo = {
  id: string;
  table_name: string;
  id_column: string;
  field_mappings_json: string;
  filter_expr: string | null;
  status: string;
};

type EntityRow = {
  id: string;
  name: string;
  name_cn: string | null;
  status: string;
  tier: number;
  attributes: Attribute[];
  binding: BindingInfo | null;
};

type RelationRow = {
  id: string;
  name: string;
  from_entity: string;
  to_entity: string;
  cardinality: string;
  source_field: string | null;
  target_field: string | null;
};

type FunctionRow = {
  callable_name: string;
  description: string | null;
  input_schema: unknown;
};

type RuleRow = {
  id: string;
  entity: string;
  name: string;
  rule_type: string;
  carrier: string | null;
  conditions_json: string | null;
  conclusion: string | null;
  enabled: number;
  description: string | null;
  expr?: string;
};

type ActionRow = {
  id: string;
  entity: string;
  code: string;
  name: string;
  executor: string;
  config_json: string | null;
  risk: string;
  discovery: string;
  intent: string | null;
  params_json: string | null;
  enabled: number;
  description: string | null;
};

type VersionRow = {
  id: string;
  version_number: number;
  status: string;
  name: string | null;
  description: string | null;
  created_at: string | null;
  submitted_at: string | null;
  published_at: string | null;
  entity_count: number;
};

type CheckRow = { entity: string; ok: boolean; reason?: string };

type DsTable = { name: string; kind: string; columns: Array<{ name: string; type: string }> };

type TabKey = "manage" | "canvas" | "validation";
type DetailTab = "detail" | "relations" | "mapping" | "rules" | "actions" | "logic";
type TrayTab = "resource" | "path";

const emptyAttrDraft = (): AttrDraft => ({ name: "", displayName: "", type: "string", required: false });
type AttrDraft = { name: string; displayName: string; type: string; required: boolean };

const STATUS_STYLE: Record<string, string> = {
  approved: "border-emerald-200 bg-emerald-50 text-emerald-700",
  draft: "border-amber-200 bg-amber-50 text-amber-700",
  published: "border-sky-200 bg-sky-50 text-sky-700",
  submitted: "border-sky-200 bg-sky-50 text-sky-700",
};

function StatusPill({ status }: { status: string }) {
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold leading-none ${
        STATUS_STYLE[status] ?? "border-border bg-surface-subtle text-muted"
      }`}
    >
      {status}
    </span>
  );
}

const cardClass = "rounded-xl border border-border bg-surface shadow-[var(--shadow-card)]";
const btnGhost =
  "inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-border bg-surface px-3 py-1.5 text-xs font-medium text-muted transition-colors duration-200 hover:border-muted-light hover:bg-surface-subtle hover:text-foreground";
const btnPrimary =
  "inline-flex cursor-pointer items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-white transition-colors duration-200 hover:bg-primary-light disabled:cursor-not-allowed disabled:opacity-40";
const inputClass =
  "h-9 w-full rounded-lg border border-border bg-surface px-3 text-sm text-foreground outline-none transition-colors duration-200 placeholder:text-muted-light focus:border-muted-light focus:bg-surface-subtle";

export function OntologyPanel({ onBack }: { onBack: () => void }) {
  const [tab, setTab] = useState<TabKey>("manage");
  const [entities, setEntities] = useState<EntityRow[]>([]);
  const [relations, setRelations] = useState<RelationRow[]>([]);
  const [functions, setFunctions] = useState<FunctionRow[]>([]);
  const [versions, setVersions] = useState<VersionRow[]>([]);
  const [dsTables, setDsTables] = useState<DsTable[]>([]);
  const [rules, setRules] = useState<RuleRow[]>([]);
  const [actions, setActions] = useState<ActionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const notify = useCallback((kind: "ok" | "err", text: string) => {
    setMessage({ kind, text });
    window.setTimeout(() => setMessage(null), 6000);
  }, []);

  const reload = useCallback(
    async (reportErrors = false) => {
      // 每个端点独立容错：某一路失败不拖垮其余数据，也不让 undefined 掀翻渲染
      const unwrap = async (r: Response) => {
        const json = await r.json();
        if (!r.ok) {
          throw new Error(json.error?.message ?? `HTTP ${r.status}`);
        }
        return json.data;
      };
      const results = await Promise.allSettled([
        ontologyFetch("/api/v1/ontology/entities").then(unwrap),
        ontologyFetch("/api/v1/ontology/context").then(unwrap),
        ontologyFetch("/api/v1/ontology/versions").then(unwrap),
        ontologyFetch("/api/v1/ontology/datasource/tables").then(unwrap),
        ontologyFetch("/api/v1/ontology/rules").then(unwrap),
        ontologyFetch("/api/v1/ontology/actions").then(unwrap),
      ]);
      const [ent, ctx, ver, ds, rules, actions] = results;
      if (ent.status === "fulfilled") {
        setEntities((ent.value as { entities: EntityRow[] }).entities);
      }
      if (ctx.status === "fulfilled") {
        const data = ctx.value as { relations: RelationRow[]; functions: FunctionRow[] };
        setRelations(data.relations);
        setFunctions(data.functions);
      }
      if (ver.status === "fulfilled") {
        setVersions((ver.value as { versions: VersionRow[] }).versions);
      }
      if (ds.status === "fulfilled") {
        setDsTables((ds.value as { tables: DsTable[] }).tables);
      }
      if (rules.status === "fulfilled") {
        setRules((rules.value as { rules: RuleRow[] }).rules);
      }
      if (actions.status === "fulfilled") {
        setActions((actions.value as { actions: ActionRow[] }).actions);
      }
      if (reportErrors) {
        for (const r of results) {
          if (r.status === "rejected") {
            notify("err", `加载失败：${r.reason instanceof Error ? r.reason.message : String(r.reason)}`);
          }
        }
      }
    },
    [notify],
  );

  useEffect(() => {
    reload(true)
      .catch((e) => notify("err", String(e)))
      .finally(() => setLoading(false));
  }, [reload, notify]);

  const approvedBindingCount = entities.filter((e) => e.binding?.status === "approved").length;
  const draftVersion = versions.find((v) => v.status === "draft");

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center bg-surface-subtle text-sm text-muted-light">
        正在加载本体工作台…
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-surface-subtle">
      {message ? (
        <div
          className={`fixed left-1/2 top-4 z-50 -translate-x-1/2 rounded-lg border px-4 py-2 text-sm shadow-[var(--shadow-card)] ${
            message.kind === "ok"
              ? "border-emerald-200 bg-emerald-50 text-emerald-700"
              : "border-rose-200 bg-rose-50 text-rose-600"
          }`}
        >
          {message.text}
        </div>
      ) : null}

      {/* 顶栏：面包屑 + 状态 pills + 操作 */}
      <header className="sticky top-0 z-30 flex min-h-16 flex-wrap items-center gap-3 border-b border-border bg-surface/90 px-6 py-3 backdrop-blur">
        <button
          type="button"
          onClick={onBack}
          title="返回工作台"
          aria-label="返回工作台"
          className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg text-muted-light transition-colors duration-200 hover:bg-surface-subtle hover:text-foreground"
        >
          <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
            <path d="m15 18-6-6 6-6" />
          </svg>
        </button>
        <div className="flex items-center gap-2 text-xs text-muted-light">
          <span>数据本体</span>
          <span>/</span>
          <b className="text-sm font-semibold text-foreground">SPC 本体</b>
        </div>
        <div className="ml-2 flex flex-wrap items-center gap-2">
          <Pill label={`${entities.length} 对象`} />
          <Pill label={`${approvedBindingCount}/${entities.length} 绑定已批`} tone={approvedBindingCount === entities.length && entities.length > 0 ? "moss" : "amber"} />
          <Pill label={`${relations.length} 关系`} />
          <Pill
            label={draftVersion ? `草稿 v${draftVersion.version_number}` : "无草稿"}
            tone={draftVersion ? "amber" : undefined}
          />
        </div>
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            className={btnPrimary}
            onClick={() => {
              setTab("validation");
            }}
          >
            校验与发布
          </button>
        </div>
      </header>

      {/* 页签 */}
      <div className="border-b border-border bg-surface px-6">
        <div className="flex gap-6">
          {(
            [
              ["manage", "本体管理"],
              ["canvas", "建模画布"],
              ["validation", "校验与版本"],
            ] as Array<[TabKey, string]>
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setTab(key)}
              className={`relative h-10 cursor-pointer text-[13px] font-semibold transition-colors ${
                tab === key ? "text-foreground" : "text-muted-light hover:text-muted"
              }`}
            >
              {label}
              {tab === key ? (
                <span className="absolute inset-x-0 bottom-0 h-0.5 rounded-t bg-primary" />
              ) : null}
            </button>
          ))}
        </div>
      </div>

      <main className="min-h-0 flex-1 overflow-y-auto p-5">
        {tab === "manage" ? (
          <ManageView
            entities={entities}
            relations={relations}
            functions={functions}
            dsTables={dsTables}
            rules={rules}
            actions={actions}
            reload={reload}
            notify={notify}
          />
        ) : null}
        {tab === "canvas" ? (
          <CanvasView entities={entities} relations={relations} notify={notify} reload={reload} />
        ) : null}
        {tab === "validation" ? (
          <ValidationView
            entities={entities}
            versions={versions}
            reload={reload}
            notify={notify}
          />
        ) : null}
      </main>
    </div>
  );
}

function Pill({ label, tone }: { label: string; tone?: "moss" | "amber" }) {
  const toneClass =
    tone === "moss"
      ? "border-emerald-200 bg-emerald-50 text-emerald-700"
      : tone === "amber"
        ? "border-amber-200 bg-amber-50 text-amber-700"
        : "border-border bg-surface text-muted";
  return (
    <span className={`inline-flex h-6 items-center rounded-full border px-2.5 text-[11px] font-semibold ${toneClass}`}>
      {label}
    </span>
  );
}

/* ============================== 本体管理 ============================== */

function ManageView({
  entities,
  relations,
  functions,
  dsTables,
  rules,
  actions,
  reload,
  notify,
}: {
  entities: EntityRow[];
  relations: RelationRow[];
  functions: FunctionRow[];
  dsTables: DsTable[];
  rules: RuleRow[];
  actions: ActionRow[];
  reload: () => Promise<void>;
  notify: (kind: "ok" | "err", text: string) => void;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [detailTab, setDetailTab] = useState<DetailTab>("detail");
  const [search, setSearch] = useState("");
  const [createOpen, setCreateOpen] = useState(false);

  const filtered = entities.filter(
    (e) =>
      !search.trim() ||
      e.name.toLowerCase().includes(search.trim().toLowerCase()) ||
      (e.name_cn ?? "").includes(search.trim()),
  );
  const current = entities.find((e) => e.name === selected) ?? null;
  const entityRelations = current
    ? relations.filter((r) => r.from_entity === current.name || r.to_entity === current.name)
    : [];
  const entityRuleCount = current ? rules.filter((r) => r.entity === current.name).length : 0;
  const entityActionCount = current ? actions.filter((a) => a.entity === current.name).length : 0;

  const select = (name: string) => {
    setSelected(name);
    setDetailTab("detail");
  };

  return (
    <div className="grid h-full grid-cols-[300px_minmax(0,1fr)] gap-4">
      {/* 左侧对象树 */}
      <aside className={`${cardClass} flex min-h-0 flex-col`}>
        <div className="flex items-center justify-between border-b border-border px-3 py-2.5">
          <h2 className="text-sm font-semibold text-foreground">本体对象</h2>
          <button type="button" className={btnPrimary} onClick={() => setCreateOpen(true)}>
            新建对象
          </button>
        </div>
        <div className="border-b border-border p-2">
          <input
            className={inputClass}
            placeholder="搜索名称 / 标识"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {filtered.length === 0 ? (
            <p className="px-2 py-6 text-center text-xs text-muted-light">没有匹配的对象</p>
          ) : null}
          <div className="flex flex-col gap-0.5">
            {filtered.map((e) => (
              <button
                key={e.id}
                type="button"
                onClick={() => select(e.name)}
                className={`flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors duration-200 ${
                  selected === e.name ? "bg-surface-subtle ring-1 ring-border" : "hover:bg-surface-subtle"
                }`}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-semibold text-foreground">{e.name}</span>
                  <span className="block truncate text-[11px] text-muted-light">
                    {e.name_cn ?? "—"} · {e.attributes.length} 属性
                  </span>
                </span>
                {e.binding ? <StatusPill status={e.binding.status} /> : <span className="text-[10px] text-muted-light">未绑定</span>}
              </button>
            ))}
          </div>
        </div>
      </aside>

      {/* 右侧详情 */}
      <section className={`${cardClass} min-h-0 overflow-y-auto`}>
        {!current ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-light">
            左侧选择一个本体对象查看详情
          </div>
        ) : (
          <div className="flex min-h-full flex-col">
            <div className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <h2 className="text-base font-semibold text-foreground">{current.name}</h2>
                  {current.name_cn ? <span className="text-sm text-muted">{current.name_cn}</span> : null}
                  <StatusPill status={current.status} />
                </div>
                <p className="mt-0.5 text-xs text-muted-light">
                  {current.attributes.length} 属性 ·{" "}
                  {current.binding ? `绑定 ${current.binding.table_name}（${current.binding.status}）` : "未绑定物理表"}
                </p>
              </div>
              <div className="ml-auto flex gap-2">
                {current.status === "draft" ? (
                  <DeleteEntityButton entity={current} reload={reload} notify={notify} onDeleted={() => setSelected(null)} />
                ) : null}
              </div>
            </div>

            <div className="flex gap-5 border-b border-border px-4">
              {(
                [
                  ["detail", "本体详情"],
                  ["relations", `本体关系${entityRelations.length ? ` (${entityRelations.length})` : ""}`],
                  ["mapping", "本体映射"],
                  ["rules", `逻辑规则${entityRuleCount ? ` (${entityRuleCount})` : ""}`],
                  ["actions", `行为${entityActionCount ? ` (${entityActionCount})` : ""}`],
                  ["logic", "函数"],
                ] as Array<[DetailTab, string]>
              ).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setDetailTab(key)}
                  className={`relative h-9 cursor-pointer text-xs font-semibold transition-colors ${
                    detailTab === key ? "text-foreground" : "text-muted-light hover:text-muted"
                  }`}
                >
                  {label}
                  {detailTab === key ? <span className="absolute inset-x-0 bottom-0 h-0.5 rounded-t bg-primary" /> : null}
                </button>
              ))}
            </div>

            <div className="min-h-0 flex-1 p-4">
              {detailTab === "detail" ? (
                <EntityDetail key={current.id} entity={current} reload={reload} notify={notify} />
              ) : null}
              {detailTab === "relations" ? (
                <EntityRelations
                  key={current.id}
                  entity={current}
                  entities={entities}
                  relations={entityRelations}
                  reload={reload}
                  notify={notify}
                />
              ) : null}
              {detailTab === "mapping" ? (
                <EntityMapping key={current.id} entity={current} dsTables={dsTables} reload={reload} notify={notify} />
              ) : null}
              {detailTab === "rules" ? (
                <EntityRules
                  key={current.id}
                  entity={current}
                  rules={rules.filter((r) => r.entity === current.name)}
                  reload={reload}
                  notify={notify}
                />
              ) : null}
              {detailTab === "actions" ? (
                <EntityActions
                  key={current.id}
                  entity={current}
                  actions={actions.filter((a) => a.entity === current.name)}
                  reload={reload}
                  notify={notify}
                />
              ) : null}
              {detailTab === "logic" ? <EntityLogic functions={functions} /> : null}
            </div>
          </div>
        )}
      </section>

      {createOpen ? (
        <EntityCreateSheet
          entities={entities}
          reload={reload}
          notify={notify}
          onClose={() => setCreateOpen(false)}
          onCreated={(name) => {
            setCreateOpen(false);
            setSelected(name);
          }}
        />
      ) : null}
    </div>
  );
}

function EntityDetail({
  entity,
  reload,
  notify,
}: {
  entity: EntityRow;
  reload: () => Promise<void>;
  notify: (kind: "ok" | "err", text: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [nameCn, setNameCn] = useState(entity.name_cn ?? "");
  const [attrs, setAttrs] = useState<AttrDraft[]>([]);
  const [saving, setSaving] = useState(false);

  const startEdit = () => {
    setNameCn(entity.name_cn ?? "");
    setAttrs(
      entity.attributes.length > 0
        ? entity.attributes.map((a) => ({
            name: a.name,
            displayName: a.display_name ?? "",
            type: a.type,
            required: a.required === 1,
          }))
        : [emptyAttrDraft()],
    );
    setEditing(true);
  };

  const save = async () => {
    setSaving(true);
    try {
      const res = await ontologyFetch(`/api/v1/ontology/entities/${encodeURIComponent(entity.name)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          nameCn: nameCn || undefined,
          attributes: attrs
            .filter((a) => a.name.trim())
            .map((a) => ({
              name: a.name.trim(),
              displayName: a.displayName || undefined,
              type: a.type,
              required: a.required,
            })),
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        notify("err", json.error?.message ?? `HTTP ${res.status}`);
        return;
      }
      setEditing(false);
      await reload();
      notify("ok", `实体 ${entity.name} 已更新`);
    } catch (error) {
      notify("err", String(error));
    } finally {
      setSaving(false);
    }
  };

  if (!editing) {
    return (
      <div className="flex flex-col gap-4">
        <div className="flex justify-end">
          <button type="button" className={btnGhost} onClick={startEdit}>
            编辑属性
          </button>
        </div>
        <div className="overflow-hidden rounded-lg border border-border">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-border bg-surface-subtle text-[11px] uppercase text-muted-light">
                <th className="px-3 py-2 font-medium">属性</th>
                <th className="px-3 py-2 font-medium">显示名</th>
                <th className="px-3 py-2 font-medium">类型</th>
                <th className="px-3 py-2 font-medium">必填</th>
              </tr>
            </thead>
            <tbody>
              {entity.attributes.map((a) => (
                <tr key={a.id} className="border-b border-border last:border-b-0">
                  <td className="px-3 py-2 font-medium text-foreground">{a.name}</td>
                  <td className="px-3 py-2 text-muted">{a.display_name ?? "—"}</td>
                  <td className="px-3 py-2 text-muted">{a.type}</td>
                  <td className="px-3 py-2 text-muted">{a.required === 1 ? "是" : "否"}</td>
                </tr>
              ))}
              {entity.attributes.length === 0 ? (
                <tr>
                  <td colSpan={4} className="px-3 py-6 text-center text-muted-light">
                    暂无属性
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-[240px_minmax(0,1fr)] items-end gap-3">
        <label className="text-xs text-muted-light">
          中文名
          <input className={`mt-1 ${inputClass}`} value={nameCn} onChange={(e) => setNameCn(e.target.value)} />
        </label>
        <p className="pb-2 text-xs text-muted-light">
          编辑按属性名同步：已有属性保留 id（绑定映射不断链）；表单里移除的属性会被删除，被绑定引用的属性将拒绝删除。
        </p>
      </div>
      <div className="space-y-2">
        {attrs.map((attr, i) => (
          <div key={i} className="flex items-center gap-2">
            <input
              className={`w-52 ${inputClass}`}
              value={attr.name}
              disabled={entity.attributes.some((a) => a.name === attr.name)}
              onChange={(e) => setAttrs((rows) => rows.map((r, j) => (j === i ? { ...r, name: e.target.value } : r)))}
              placeholder="属性名"
            />
            <input
              className={`w-44 ${inputClass}`}
              value={attr.displayName}
              onChange={(e) => setAttrs((rows) => rows.map((r, j) => (j === i ? { ...r, displayName: e.target.value } : r)))}
              placeholder="显示名"
            />
            <select
              className={`w-32 ${inputClass}`}
              value={attr.type}
              onChange={(e) => setAttrs((rows) => rows.map((r, j) => (j === i ? { ...r, type: e.target.value } : r)))}
            >
              {["string", "number", "boolean"].map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
            <label className="flex items-center gap-1 text-xs text-muted">
              <input
                type="checkbox"
                checked={attr.required}
                onChange={(e) => setAttrs((rows) => rows.map((r, j) => (j === i ? { ...r, required: e.target.checked } : r)))}
              />
              必填
            </label>
            <button
              type="button"
              className="text-xs text-rose-500 hover:underline"
              onClick={() => setAttrs((rows) => rows.filter((_, j) => j !== i))}
            >
              移除
            </button>
          </div>
        ))}
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          className="rounded-lg border border-border px-2.5 py-1 text-xs text-muted hover:bg-surface-subtle"
          onClick={() => setAttrs((rows) => [...rows, emptyAttrDraft()])}
        >
          + 添加属性
        </button>
        <span className="flex-1" />
        <button type="button" className={btnGhost} onClick={() => setEditing(false)}>
          取消
        </button>
        <button type="button" className={btnPrimary} disabled={saving} onClick={save}>
          {saving ? "保存中…" : "保存"}
        </button>
      </div>
    </div>
  );
}

function DeleteEntityButton({
  entity,
  reload,
  notify,
  onDeleted,
}: {
  entity: EntityRow;
  reload: () => Promise<void>;
  notify: (kind: "ok" | "err", text: string) => void;
  onDeleted: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const remove = async () => {
    if (!window.confirm(`删除实体 ${entity.name}？其属性、draft 绑定与相关关系将一并删除。`)) return;
    setBusy(true);
    try {
      const res = await ontologyFetch(`/api/v1/ontology/entities/${encodeURIComponent(entity.name)}`, {
        method: "DELETE",
      });
      const json = await res.json();
      if (!res.ok) {
        notify("err", json.error?.message ?? `HTTP ${res.status}`);
        return;
      }
      onDeleted();
      await reload();
      notify("ok", `实体 ${entity.name} 已删除`);
    } catch (error) {
      notify("err", String(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <button type="button" className={btnGhost} disabled={busy} onClick={remove}>
      删除实体
    </button>
  );
}

function EntityRelations({
  entity,
  entities,
  relations,
  reload,
  notify,
}: {
  entity: EntityRow;
  entities: EntityRow[];
  relations: RelationRow[];
  reload: () => Promise<void>;
  notify: (kind: "ok" | "err", text: string) => void;
}) {
  const [editingRel, setEditingRel] = useState<RelationRow | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [fromName, setFromName] = useState(entity.name);
  const [toName, setToName] = useState("");
  const [cardinality, setCardinality] = useState("1:N");
  const [sourceField, setSourceField] = useState("");
  const [targetField, setTargetField] = useState("");
  const [saving, setSaving] = useState(false);

  const attrsOf = (entityName: string) => entities.find((e) => e.name === entityName)?.attributes ?? [];
  const formOpen = creating || Boolean(editingRel);
  // 编辑时方向锁定为原关系两端；新建时起点=当前对象
  const lockDirection = Boolean(editingRel);

  const openCreate = () => {
    setEditingRel(null);
    setCreating(true);
    setName("");
    setFromName(entity.name);
    setToName("");
    setCardinality("1:N");
    setSourceField("");
    setTargetField("");
  };

  const openEdit = (rel: RelationRow) => {
    setCreating(false);
    setEditingRel(rel);
    setName(rel.name);
    setFromName(rel.from_entity);
    setToName(rel.to_entity);
    setCardinality(rel.cardinality);
    setSourceField(rel.source_field ?? "");
    setTargetField(rel.target_field ?? "");
  };

  const closeForm = () => {
    setCreating(false);
    setEditingRel(null);
  };

  const recommend = () => {
    if (!fromName || !toName || fromName === toName) return;
    const a = attrsOf(fromName).map((x) => x.name);
    const b = new Set(attrsOf(toName).map((x) => x.name));
    const common = a.filter((x) => b.has(x));
    if (common.length === 1) {
      setSourceField(common[0]);
      setTargetField(common[0]);
      notify("ok", `已自动推荐连接键：${common[0]}`);
    } else if (common.length === 0) {
      notify("err", "两端没有同名属性，请人工选择连接键");
    } else {
      notify("err", `存在多个共同属性，请手动选择：${common.join("、")}`);
    }
  };

  const save = async () => {
    setSaving(true);
    try {
      const body = {
        name,
        cardinality,
        sourceField: sourceField || undefined,
        targetField: targetField || undefined,
      };
      const res = editingRel
        ? await ontologyFetch(`/api/v1/ontology/relations/${encodeURIComponent(editingRel.id)}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          })
        : await ontologyFetch("/api/v1/ontology/relations", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ...body, fromEntity: fromName, toEntity: toName }),
          });
      const json = await res.json();
      if (!res.ok) {
        notify("err", json.error?.message ?? `HTTP ${res.status}`);
        return;
      }
      closeForm();
      await reload();
      notify("ok", editingRel ? `关系 ${name} 已更新` : `关系 ${name} 已创建`);
    } catch (error) {
      notify("err", String(error));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (rel: RelationRow) => {
    if (!window.confirm(`删除关系 ${rel.from_entity} -${rel.name}-> ${rel.to_entity}？`)) return;
    try {
      const res = await ontologyFetch(`/api/v1/ontology/relations/${encodeURIComponent(rel.id)}`, {
        method: "DELETE",
      });
      const json = await res.json();
      if (!res.ok) {
        notify("err", json.error?.message ?? `HTTP ${res.status}`);
        return;
      }
      await reload();
      notify("ok", `关系 ${rel.name} 已删除`);
    } catch (error) {
      notify("err", String(error));
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="overflow-hidden rounded-lg border border-border">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-border bg-surface-subtle text-[11px] uppercase text-muted-light">
              <th className="px-3 py-2 font-medium">名称</th>
              <th className="px-3 py-2 font-medium">方向</th>
              <th className="px-3 py-2 font-medium">基数</th>
              <th className="px-3 py-2 font-medium">连接键</th>
              <th className="px-3 py-2 font-medium" />
            </tr>
          </thead>
          <tbody>
            {relations.map((r) => {
              const hasKeys = Boolean(r.source_field && r.target_field);
              return (
                <tr key={r.id} className="border-b border-border last:border-b-0">
                  <td className="px-3 py-2 font-medium text-foreground">{r.name}</td>
                  <td className="px-3 py-2 text-muted">
                    {r.from_entity} → {r.to_entity}
                  </td>
                  <td className="px-3 py-2 text-muted">{r.cardinality}</td>
                  <td className="px-3 py-2">
                    {hasKeys ? (
                      <span className="font-mono text-xs text-foreground">
                        {r.source_field} = {r.target_field}
                      </span>
                    ) : (
                      <span className="text-xs text-amber-600">未登记连接键（路径检索不可用）</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <button type="button" className="mr-3 text-xs text-blue-600 hover:underline" onClick={() => openEdit(r)}>
                      编辑
                    </button>
                    <button type="button" className="text-xs text-rose-500 hover:underline" onClick={() => remove(r)}>
                      删除
                    </button>
                  </td>
                </tr>
              );
            })}
            {relations.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-3 py-6 text-center text-muted-light">
                  暂无关系
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      {formOpen ? (
        <div className="rounded-lg border border-border bg-surface-subtle p-3">
          <h3 className="mb-2 text-xs font-semibold text-foreground">
            {editingRel ? `编辑关系 ${editingRel.name}` : "新建关系"}
            {editingRel ? <span className="ml-2 font-normal text-muted-light">（两端实体不可改）</span> : null}
          </h3>
          <div className="flex flex-wrap items-end gap-2">
            {!lockDirection ? (
              <label className="text-[11px] text-muted-light">
                起点对象
                <select className={`mt-1 w-40 ${inputClass}`} value={fromName} onChange={(e) => { setFromName(e.target.value); setSourceField(""); }}>
                  <option value="">选择对象</option>
                  {entities
                    .filter((e) => e.name !== toName)
                    .map((e) => (
                      <option key={e.id} value={e.name}>
                        {e.name}
                      </option>
                    ))}
                </select>
              </label>
            ) : (
              <span className="self-center rounded-lg border border-border bg-surface px-2 py-1.5 text-xs text-muted">
                {fromName} → {toName}
              </span>
            )}
            {!lockDirection ? (
              <label className="text-[11px] text-muted-light">
                终点对象
                <select className={`mt-1 w-40 ${inputClass}`} value={toName} onChange={(e) => { setToName(e.target.value); setTargetField(""); }}>
                  <option value="">选择对象</option>
                  {entities
                    .filter((e) => e.name !== fromName)
                    .map((e) => (
                      <option key={e.id} value={e.name}>
                        {e.name}
                      </option>
                    ))}
                </select>
              </label>
            ) : null}
            <label className="text-[11px] text-muted-light">
              名称
              <input className={`mt-1 w-40 ${inputClass}`} value={name} onChange={(e) => setName(e.target.value)} placeholder="has_events" />
            </label>
            <label className="text-[11px] text-muted-light">
              基数
              <select className={`mt-1 w-24 ${inputClass}`} value={cardinality} onChange={(e) => setCardinality(e.target.value)}>
                {["1:1", "1:N", "N:1", "N:N"].map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-[11px] text-muted-light">
              源属性
              <select className={`mt-1 w-36 ${inputClass}`} value={sourceField} onChange={(e) => setSourceField(e.target.value)}>
                <option value="">选择属性</option>
                {attrsOf(fromName).map((a) => (
                  <option key={a.id} value={a.name}>
                    {a.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-[11px] text-muted-light">
              目标属性
              <select className={`mt-1 w-36 ${inputClass}`} value={targetField} onChange={(e) => setTargetField(e.target.value)}>
                <option value="">选择属性</option>
                {attrsOf(toName).map((a) => (
                  <option key={a.id} value={a.name}>
                    {a.name}
                  </option>
                ))}
              </select>
            </label>
            <button type="button" className={btnGhost} onClick={recommend} disabled={!fromName || !toName}>
              自动推荐
            </button>
            <button type="button" className={btnPrimary} disabled={saving || !name.trim() || (!lockDirection && !toName)} onClick={save}>
              {saving ? "保存中…" : editingRel ? "保存修改" : "创建关系"}
            </button>
          </div>
          <p className="mt-2 text-[11px] text-muted-light">
            连接键填两端的属性名（traverse 编译 JOIN 时经绑定映射翻译为物理列）；两端同时登记或同时为空。
          </p>
        </div>
      ) : null}
    </div>
  );
}

function EntityMapping({
  entity,
  dsTables,
  reload,
  notify,
}: {
  entity: EntityRow;
  dsTables: DsTable[];
  reload: () => Promise<void>;
  notify: (kind: "ok" | "err", text: string) => void;
}) {
  const [table, setTable] = useState(entity.binding?.table_name ?? "");
  const [idColumn, setIdColumn] = useState(entity.binding?.id_column ?? "");
  const [mappings, setMappings] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setTable(entity.binding?.table_name ?? "");
    setIdColumn(entity.binding?.id_column ?? "");
    try {
      const parsed: unknown = entity.binding ? JSON.parse(entity.binding.field_mappings_json) : null;
      const result: Record<string, string> = {};
      if (Array.isArray(parsed)) {
        for (const item of parsed as Array<{ attribute_id?: string; source_column?: string }>) {
          if (item.attribute_id && item.source_column) result[item.attribute_id] = item.source_column;
        }
      } else if (parsed && typeof parsed === "object") {
        // Record 形态（键=属性名）：解析为 attribute_id，保存才能写回数组形态
        const byName = new Map(entity.attributes.map((a) => [a.name, a.id]));
        for (const [k, v] of Object.entries(parsed as Record<string, string>)) {
          const id = byName.get(k);
          if (id) result[id] = v;
          else result[`name:${k}`] = v;
        }
      }
      setMappings(result);
    } catch {
      setMappings({});
    }
  }, [entity]);

  const columns = dsTables.find((t) => t.name === table)?.columns ?? [];
  const mappedCount = entity.attributes.filter((a) => mappings[a.id] || mappings[`name:${a.name}`]).length;

  const persist = async (): Promise<boolean> => {
    setSaving(true);
    try {
      const res = await ontologyFetch(`/api/v1/ontology/bindings/${encodeURIComponent(entity.name)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          table,
          idColumn,
          fieldMappings: entity.attributes
            .filter((a) => mappings[a.id])
            .map((a) => ({ attribute_id: a.id, source_column: mappings[a.id] })),
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        notify("err", json.error?.message ?? `HTTP ${res.status}`);
        return false;
      }
      await reload();
      return true;
    } catch (error) {
      notify("err", String(error));
      return false;
    } finally {
      setSaving(false);
    }
  };

  const save = async () => {
    if (await persist()) {
      notify("ok", "绑定已保存（状态打回 draft，需重新审批）");
    }
  };

  const saveAndApprove = async () => {
    if (!(await persist())) return;
    setSaving(true);
    try {
      const res = await ontologyFetch(`/api/v1/ontology/bindings/${encodeURIComponent(entity.name)}/approve`, {
        method: "POST",
      });
      const json = await res.json();
      if (!res.ok) {
        notify("err", json.error?.message ?? `HTTP ${res.status}`);
        return;
      }
      await reload();
      notify("ok", "保存并审批通过，绑定已生效");
    } catch (error) {
      notify("err", String(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <StatusPill status={entity.binding?.status ?? "draft"} />
        <span className="text-xs text-muted-light">
          映射 {mappedCount}/{entity.attributes.length}
          {entity.attributes.length > 0 && mappedCount * 2 < entity.attributes.length ? (
            <span className="ml-2 text-rose-500">覆盖率不足 50%，无法审批</span>
          ) : null}
        </span>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <label className="text-xs text-muted-light">
          数据表
          <select className={`mt-1 ${inputClass}`} value={table} onChange={(e) => { setTable(e.target.value); setIdColumn(""); }}>
            <option value="">— 选择表 —</option>
            {dsTables.map((t) => (
              <option key={t.name} value={t.name}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs text-muted-light">
          实例身份列（ID 列）
          <select className={`mt-1 ${inputClass}`} value={idColumn} onChange={(e) => setIdColumn(e.target.value)}>
            <option value="">— 选择列 —</option>
            {columns.map((c) => (
              <option key={c.name} value={c.name}>
                {c.name}（{c.type || "any"}）
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="overflow-hidden rounded-lg border border-border">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-border bg-surface-subtle text-[11px] uppercase text-muted-light">
              <th className="px-3 py-2 font-medium">属性</th>
              <th className="px-3 py-2 font-medium">类型</th>
              <th className="px-3 py-2 font-medium">物理列</th>
            </tr>
          </thead>
          <tbody>
            {entity.attributes.map((a) => {
              const value = mappings[a.id] ?? mappings[`name:${a.name}`] ?? "";
              return (
                <tr key={a.id} className="border-b border-border last:border-b-0">
                  <td className="px-3 py-2 font-medium text-foreground">
                    {a.display_name || a.name}
                    {a.required === 1 ? <span className="ml-1 text-rose-500">*</span> : null}
                  </td>
                  <td className="px-3 py-2 text-muted">{a.type}</td>
                  <td className="px-3 py-2">
                    <select
                      className="w-64 rounded-md border border-border bg-surface px-2 py-1 text-sm"
                      value={value}
                      onChange={(e) => setMappings((prev) => ({ ...prev, [a.id]: e.target.value }))}
                    >
                      <option value="">— 未映射 —</option>
                      {columns.map((c) => (
                        <option key={c.name} value={c.name}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="flex gap-2">
        <button type="button" className={btnGhost} disabled={saving || !table || !idColumn} onClick={save}>
          保存
        </button>
        <button
          type="button"
          className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-40"
          disabled={saving || !table || !idColumn}
          onClick={saveAndApprove}
        >
          保存并审批
        </button>
      </div>
    </div>
  );
}

type ConditionDraft = { field: string; op: string; value: string };

function EntityRules({
  entity,
  rules,
  reload,
  notify,
}: {
  entity: EntityRow;
  rules: RuleRow[];
  reload: () => Promise<void>;
  notify: (kind: "ok" | "err", text: string) => void;
}) {
  const [editing, setEditing] = useState<RuleRow | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [ruleType, setRuleType] = useState("inference");
  const [carrier, setCarrier] = useState("expression");
  const [conditions, setConditions] = useState<ConditionDraft[]>([]);
  const [thenText, setThenText] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [saving, setSaving] = useState(false);

  const openCreate = () => {
    setEditing(null);
    setName("");
    setRuleType("inference");
    setCarrier("expression");
    setConditions([]);
    setThenText("");
    setEnabled(true);
    setCreating(true);
  };

  const openEdit = (rule: RuleRow) => {
    setCreating(true);
    setEditing(rule);
    setName(rule.name);
    setRuleType(rule.rule_type);
    setCarrier(rule.carrier ?? "expression");
    let parsed: ConditionDraft[] = [];
    try {
      const raw: unknown = JSON.parse(rule.conditions_json ?? "[]");
      if (Array.isArray(raw)) {
        parsed = (raw as Array<[string, string, string]>).map(([field, op, value]) => ({ field, op, value }));
      }
    } catch {
      parsed = [];
    }
    setConditions(parsed);
    setThenText(rule.conclusion ?? "");
    setEnabled(rule.enabled === 1);
  };

  const save = async () => {
    setSaving(true);
    try {
      const body = {
        entity: entity.name,
        name,
        ruleType,
        ...(ruleType === "logic" ? { carrier } : {}),
        conditions: conditions.filter((c) => c.field.trim()),
        then: thenText || undefined,
        enabled,
      };
      const res = await ontologyFetch(
        editing ? `/api/v1/ontology/rules/${encodeURIComponent(editing.id)}` : "/api/v1/ontology/rules",
        {
          method: editing ? "PUT" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      const json = await res.json();
      if (!res.ok) {
        notify("err", json.error?.message ?? `HTTP ${res.status}`);
        return;
      }
      setCreating(false);
      setEditing(null);
      await reload();
      notify("ok", editing ? `规则 ${name} 已更新` : `规则 ${name} 已创建`);
    } catch (error) {
      notify("err", String(error));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (rule: RuleRow) => {
    if (!window.confirm(`删除规则 ${rule.name}？`)) return;
    try {
      const res = await ontologyFetch(`/api/v1/ontology/rules/${encodeURIComponent(rule.id)}`, { method: "DELETE" });
      const json = await res.json();
      if (!res.ok) {
        notify("err", json.error?.message ?? `HTTP ${res.status}`);
        return;
      }
      await reload();
      notify("ok", `规则 ${rule.name} 已删除`);
    } catch (error) {
      notify("err", String(error));
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-light">
          业务判断沉淀为推理（WHEN/THEN）、校验或计算逻辑，问答与校验按声明执行而非模型临场发挥。
        </p>
        <button
          type="button"
          className={btnGhost}
          onClick={() => (creating && !editing ? setCreating(false) : openCreate())}
        >
          {creating && !editing ? "收起表单" : "新建规则"}
        </button>
      </div>

      {creating ? (
        <div className="rounded-lg border border-border bg-surface-subtle p-3">
          <div className="grid grid-cols-[1fr_180px] gap-3">
            <label className="text-[11px] text-muted-light">
              规则名（英文标识）*
              <input className={`mt-1 ${inputClass}`} value={name} onChange={(e) => setName(e.target.value)} placeholder="如 vip_customer" />
            </label>
            <label className="text-[11px] text-muted-light">
              规则分支
              <select className={`mt-1 ${inputClass}`} value={ruleType} onChange={(e) => setRuleType(e.target.value)}>
                <option value="inference">推理</option>
                <option value="validation">校验</option>
                <option value="logic">计算逻辑</option>
              </select>
            </label>
          </div>

          {ruleType === "logic" ? (
            <div className="mt-3 grid grid-cols-[160px_minmax(0,1fr)] gap-3">
              <label className="text-[11px] text-muted-light">
                逻辑载体 *
                <select className={`mt-1 ${inputClass}`} value={carrier} onChange={(e) => setCarrier(e.target.value)}>
                  <option value="expression">表达式</option>
                  <option value="sql">SQL</option>
                  <option value="python">Python</option>
                </select>
              </label>
              <label className="text-[11px] text-muted-light">
                载体正文 *
                <textarea
                  className="mt-1 h-20 w-full rounded-lg border border-border bg-surface p-2 font-mono text-xs"
                  value={thenText}
                  onChange={(e) => setThenText(e.target.value)}
                  placeholder="表达式 / SQL / Python"
                />
              </label>
            </div>
          ) : (
            <>
              <div className="mt-3">
                <div className="mb-1 flex items-center justify-between text-[11px] text-muted-light">
                  <span>WHEN 条件（多行按 AND 连接，字段来自作用对象属性）</span>
                  <button
                    type="button"
                    className="rounded border border-border px-2 py-0.5 hover:bg-surface"
                    onClick={() => setConditions((rows) => [...rows, { field: "", op: "=", value: "" }])}
                  >
                    且条件（AND）
                  </button>
                </div>
                <div className="space-y-2">
                  {conditions.map((c, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <select
                        className={`w-52 ${inputClass}`}
                        value={c.field}
                        onChange={(e) => setConditions((rows) => rows.map((r, j) => (j === i ? { ...r, field: e.target.value } : r)))}
                      >
                        <option value="">选择属性</option>
                        {entity.attributes.map((a) => (
                          <option key={a.id} value={a.name}>
                            {a.name}
                          </option>
                        ))}
                      </select>
                      <select
                        className={`w-32 ${inputClass}`}
                        value={c.op}
                        onChange={(e) => setConditions((rows) => rows.map((r, j) => (j === i ? { ...r, op: e.target.value } : r)))}
                      >
                        {["=", "!=", ">", ">=", "<", "<=", "contains", "starts_with", "ends_with", "in"].map((op) => (
                          <option key={op} value={op}>
                            {op}
                          </option>
                        ))}
                      </select>
                      <input
                        className={`flex-1 ${inputClass}`}
                        value={c.value}
                        onChange={(e) => setConditions((rows) => rows.map((r, j) => (j === i ? { ...r, value: e.target.value } : r)))}
                        placeholder="值"
                      />
                      <button
                        type="button"
                        className="text-xs text-rose-500 hover:underline"
                        onClick={() => setConditions((rows) => rows.filter((_, j) => j !== i))}
                      >
                        移除
                      </button>
                    </div>
                  ))}
                </div>
              </div>
              <label className="mt-3 block text-[11px] text-muted-light">
                THEN 结论 *
                <input className={`mt-1 ${inputClass}`} value={thenText} onChange={(e) => setThenText(e.target.value)} placeholder="如 标记为 VIP 客户 / 判定订单金额异常" />
              </label>
            </>
          )}

          <div className="mt-3 flex items-center gap-3">
            <label className="flex items-center gap-1 text-xs text-muted">
              <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
              启用规则
            </label>
            <span className="flex-1" />
            <button type="button" className={btnGhost} onClick={() => { setCreating(false); setEditing(null); }}>
              取消
            </button>
            <button type="button" className={btnPrimary} disabled={saving || !name.trim()} onClick={save}>
              {saving ? "保存中…" : editing ? "保存修改" : "创建规则"}
            </button>
          </div>
        </div>
      ) : null}

      <div className="overflow-hidden rounded-lg border border-border">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-border bg-surface-subtle text-[11px] uppercase text-muted-light">
              <th className="px-3 py-2 font-medium">规则名</th>
              <th className="px-3 py-2 font-medium">分支</th>
              <th className="px-3 py-2 font-medium">表达式</th>
              <th className="px-3 py-2 font-medium">启用</th>
              <th className="px-3 py-2 font-medium" />
            </tr>
          </thead>
          <tbody>
            {rules.map((r) => (
              <tr key={r.id} className="border-b border-border last:border-b-0">
                <td className="px-3 py-2 font-mono text-[13px] font-medium text-foreground">{r.name}</td>
                <td className="px-3 py-2 text-muted">
                  {{ inference: "推理", validation: "校验", logic: "计算逻辑" }[r.rule_type] ?? r.rule_type}
                </td>
                <td className="max-w-md truncate px-3 py-2 font-mono text-xs text-muted">{r.expr ?? "—"}</td>
                <td className="px-3 py-2">{r.enabled === 1 ? <span className="text-emerald-600">✓</span> : <span className="text-muted-light">停用</span>}</td>
                <td className="px-3 py-2 text-right">
                  <button type="button" className="mr-3 text-xs text-blue-600 hover:underline" onClick={() => openEdit(r)}>
                    编辑
                  </button>
                  <button type="button" className="text-xs text-rose-500 hover:underline" onClick={() => remove(r)}>
                    删除
                  </button>
                </td>
              </tr>
            ))}
            {rules.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-3 py-6 text-center text-muted-light">
                  暂无规则
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function EntityActions({
  entity,
  actions,
  reload,
  notify,
}: {
  entity: EntityRow;
  actions: ActionRow[];
  reload: () => Promise<void>;
  notify: (kind: "ok" | "err", text: string) => void;
}) {
  const [editing, setEditing] = useState<ActionRow | null>(null);
  const [creating, setCreating] = useState(false);
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [executor, setExecutor] = useState("sql");
  const [sql, setSql] = useState("");
  const [method, setMethod] = useState("POST");
  const [apiPath, setApiPath] = useState("");
  const [hosts, setHosts] = useState("");
  const [subject, setSubject] = useState("");
  const [risk, setRisk] = useState("LOW");
  const [discovery, setDiscovery] = useState("confirm");
  const [intent, setIntent] = useState("");
  const [params, setParams] = useState<Array<{ name: string; type: string; required: boolean }>>([]);
  const [description, setDescription] = useState("");
  const [actionEnabled, setActionEnabled] = useState(true);
  const [saving, setSaving] = useState(false);

  const openCreate = () => {
    setEditing(null);
    setCode("");
    setName("");
    setExecutor("sql");
    setSql("");
    setMethod("POST");
    setApiPath("");
    setHosts("");
    setSubject("");
    setRisk("LOW");
    setDiscovery("confirm");
    setIntent("");
    setParams([]);
    setDescription("");
    setActionEnabled(true);
    setCreating(true);
  };

  const openEdit = (action: ActionRow) => {
    setCreating(true);
    setEditing(action);
    setCode(action.code);
    setName(action.name);
    setExecutor(action.executor);
    let config: Record<string, string> = {};
    try {
      config = JSON.parse(action.config_json ?? "{}") as Record<string, string>;
    } catch {
      config = {};
    }
    setSql(config.sql ?? "");
    setMethod(config.method ?? "POST");
    setApiPath(config.path ?? "");
    setHosts(config.hosts ?? "");
    setSubject(config.subject ?? "");
    setRisk(action.risk);
    setDiscovery(action.discovery);
    setIntent(action.intent ?? "");
    let parsedParams: Array<{ name: string; type: string; required: boolean }> = [];
    try {
      const raw: unknown = JSON.parse(action.params_json ?? "[]");
      if (Array.isArray(raw)) parsedParams = raw as Array<{ name: string; type: string; required: boolean }>;
    } catch {
      parsedParams = [];
    }
    setParams(parsedParams);
    setDescription(action.description ?? "");
    setActionEnabled(action.enabled === 1);
  };

  const save = async () => {
    setSaving(true);
    try {
      const config =
        executor === "sql"
          ? { sql }
          : executor === "api"
            ? { method, path: apiPath, hosts }
            : { subject, body: "" };
      const res = await ontologyFetch(
        editing ? `/api/v1/ontology/actions/${encodeURIComponent(editing.id)}` : "/api/v1/ontology/actions",
        {
          method: editing ? "PUT" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            entity: entity.name,
            code,
            name,
            executor,
            config,
            risk,
            discovery,
            intent: intent || undefined,
            params: params.filter((p) => p.name.trim()),
            description: description || undefined,
            enabled: actionEnabled,
          }),
        },
      );
      const json = await res.json();
      if (!res.ok) {
        notify("err", json.error?.message ?? `HTTP ${res.status}`);
        return;
      }
      setCreating(false);
      setEditing(null);
      await reload();
      notify("ok", editing ? `行为 ${code} 已更新` : `行为 ${code} 已创建`);
    } catch (error) {
      notify("err", String(error));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (action: ActionRow) => {
    if (!window.confirm(`删除行为 ${action.code}？`)) return;
    try {
      const res = await ontologyFetch(`/api/v1/ontology/actions/${encodeURIComponent(action.id)}`, { method: "DELETE" });
      const json = await res.json();
      if (!res.ok) {
        notify("err", json.error?.message ?? `HTTP ${res.status}`);
        return;
      }
      await reload();
      notify("ok", `行为 ${action.code} 已删除`);
    } catch (error) {
      notify("err", String(error));
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-light">
          行为是智能体可调用的原子工具契约；写操作外置到业务系统（api 执行器必须 https + 白名单域）。
        </p>
        <button
          type="button"
          className={btnGhost}
          onClick={() => (creating && !editing ? setCreating(false) : openCreate())}
        >
          {creating && !editing ? "收起表单" : "新建行为"}
        </button>
      </div>

      {creating ? (
        <div className="rounded-lg border border-border bg-surface-subtle p-3">
          <div className="grid grid-cols-3 gap-3">
            <label className="text-[11px] text-muted-light">
              名称（英文标识）*
              <input className={`mt-1 ${inputClass}`} value={code} onChange={(e) => setCode(e.target.value)} placeholder="freeze_customer" />
            </label>
            <label className="text-[11px] text-muted-light">
              中文名 *
              <input className={`mt-1 ${inputClass}`} value={name} onChange={(e) => setName(e.target.value)} placeholder="冻结客户" />
            </label>
            <label className="text-[11px] text-muted-light">
              执行器
              <select className={`mt-1 ${inputClass}`} value={executor} onChange={(e) => setExecutor(e.target.value)}>
                <option value="sql">只读查询</option>
                <option value="api">外置写</option>
                <option value="notify">通知邮件</option>
              </select>
            </label>
          </div>

          {executor === "sql" ? (
            <label className="mt-3 block text-[11px] text-muted-light">
              SQL（只读 SELECT）*
              <textarea
                className="mt-1 h-20 w-full rounded-lg border border-border bg-surface p-2 font-mono text-xs"
                value={sql}
                onChange={(e) => setSql(e.target.value)}
                placeholder="SELECT * FROM table WHERE col = {param}"
              />
            </label>
          ) : null}
          {executor === "api" ? (
            <div className="mt-3 grid grid-cols-3 gap-3">
              <label className="text-[11px] text-muted-light">
                请求方法
                <select className={`mt-1 ${inputClass}`} value={method} onChange={(e) => setMethod(e.target.value)}>
                  {["GET", "POST", "PUT", "DELETE"].map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-[11px] text-muted-light">
                请求地址（https）*
                <input className={`mt-1 ${inputClass}`} value={apiPath} onChange={(e) => setApiPath(e.target.value)} placeholder="https://..." />
              </label>
              <label className="text-[11px] text-muted-light">
                地址白名单 *
                <input className={`mt-1 ${inputClass}`} value={hosts} onChange={(e) => setHosts(e.target.value)} placeholder="crm.example.com" />
              </label>
            </div>
          ) : null}
          {executor === "notify" ? (
            <label className="mt-3 block text-[11px] text-muted-light">
              主题模板 *
              <input className={`mt-1 ${inputClass}`} value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="商品质量告警：{product_id}" />
            </label>
          ) : null}

          <div className="mt-3 grid grid-cols-4 items-end gap-3">
            <label className="text-[11px] text-muted-light">
              风险等级
              <select className={`mt-1 ${inputClass}`} value={risk} onChange={(e) => setRisk(e.target.value)}>
                {["LOW", "MEDIUM", "HIGH"].map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-[11px] text-muted-light">
              发现模式
              <select className={`mt-1 ${inputClass}`} value={discovery} onChange={(e) => setDiscovery(e.target.value)}>
                <option value="auto">可自动执行</option>
                <option value="confirm">需人工确认</option>
              </select>
            </label>
            <label className="col-span-2 text-[11px] text-muted-light">
              意图标签（逗号分隔，供 Agent 匹配发现）
              <input className={`mt-1 ${inputClass}`} value={intent} onChange={(e) => setIntent(e.target.value)} placeholder="查询订单,订单明细" />
            </label>
          </div>

          <div className="mt-3">
            <div className="mb-1 flex items-center justify-between text-[11px] text-muted-light">
              <span>参数契约</span>
              <button
                type="button"
                className="rounded border border-border px-2 py-0.5 hover:bg-surface"
                onClick={() => setParams((rows) => [...rows, { name: "", type: "string", required: true }])}
              >
                添加参数
              </button>
            </div>
            <div className="space-y-2">
              {params.map((p, i) => (
                <div key={i} className="flex items-center gap-2">
                  <input
                    className={`w-48 ${inputClass}`}
                    value={p.name}
                    onChange={(e) => setParams((rows) => rows.map((r, j) => (j === i ? { ...r, name: e.target.value } : r)))}
                    placeholder="参数名"
                  />
                  <select
                    className={`w-28 ${inputClass}`}
                    value={p.type}
                    onChange={(e) => setParams((rows) => rows.map((r, j) => (j === i ? { ...r, type: e.target.value } : r)))}
                  >
                    {["string", "number", "boolean"].map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </select>
                  <label className="flex items-center gap-1 text-xs text-muted">
                    <input
                      type="checkbox"
                      checked={p.required}
                      onChange={(e) => setParams((rows) => rows.map((r, j) => (j === i ? { ...r, required: e.target.checked } : r)))}
                    />
                    必填
                  </label>
                  <button
                    type="button"
                    className="text-xs text-rose-500 hover:underline"
                    onClick={() => setParams((rows) => rows.filter((_, j) => j !== i))}
                  >
                    移除
                  </button>
                </div>
              ))}
            </div>
          </div>

          <div className="mt-3 flex items-center gap-4">
            <label className="block text-[11px] text-muted-light">
              描述
              <input className={`mt-1 ${inputClass}`} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="可选" />
            </label>
            <label className="flex items-center gap-1 text-xs text-muted">
              <input type="checkbox" checked={actionEnabled} onChange={(e) => setActionEnabled(e.target.checked)} />
              启用行为
            </label>
          </div>

          <div className="mt-3 flex justify-end gap-2">
            <button type="button" className={btnGhost} onClick={() => { setCreating(false); setEditing(null); }}>
              取消
            </button>
            <button type="button" className={btnPrimary} disabled={saving || !code.trim() || !name.trim()} onClick={save}>
              {saving ? "保存中…" : editing ? "保存修改" : "创建行为"}
            </button>
          </div>
        </div>
      ) : null}

      <div className="overflow-hidden rounded-lg border border-border">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-border bg-surface-subtle text-[11px] uppercase text-muted-light">
              <th className="px-3 py-2 font-medium">标识</th>
              <th className="px-3 py-2 font-medium">中文名</th>
              <th className="px-3 py-2 font-medium">执行器</th>
              <th className="px-3 py-2 font-medium">风险</th>
              <th className="px-3 py-2 font-medium">发现</th>
              <th className="px-3 py-2 font-medium">意图</th>
              <th className="px-3 py-2 font-medium" />
            </tr>
          </thead>
          <tbody>
            {actions.map((a) => (
              <tr key={a.id} className="border-b border-border last:border-b-0">
                <td className="px-3 py-2 font-mono text-[13px] font-medium text-foreground">{a.code}</td>
                <td className="px-3 py-2 text-foreground">{a.name}</td>
                <td className="px-3 py-2 text-muted">{{ sql: "只读查询", api: "外置写", notify: "通知" }[a.executor] ?? a.executor}</td>
                <td className="px-3 py-2">
                  <span
                    className={`rounded-full border px-1.5 py-0.5 text-[10px] font-semibold ${
                      a.risk === "HIGH"
                        ? "border-rose-200 bg-rose-50 text-rose-600"
                        : a.risk === "MEDIUM"
                          ? "border-amber-200 bg-amber-50 text-amber-700"
                          : "border-emerald-200 bg-emerald-50 text-emerald-700"
                    }`}
                  >
                    {a.risk}
                  </span>
                </td>
                <td className="px-3 py-2 text-muted">{a.discovery === "auto" ? "自动" : "人工确认"}</td>
                <td className="px-3 py-2 text-muted">{a.intent ?? "—"}</td>
                <td className="px-3 py-2 text-right">
                  <button type="button" className="mr-3 text-xs text-blue-600 hover:underline" onClick={() => openEdit(a)}>
                    编辑
                  </button>
                  <button type="button" className="text-xs text-rose-500 hover:underline" onClick={() => remove(a)}>
                    删除
                  </button>
                </td>
              </tr>
            ))}
            {actions.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-3 py-6 text-center text-muted-light">
                  暂无行为
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function EntityLogic({ functions }: { functions: FunctionRow[] }) {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs text-muted-light">
        当前本体登记的逻辑函数（注册在 ontology-logic 服务，随 /context 下发；函数与对象的作用域绑定暂未在 API 中暴露）。
      </p>
      {functions.map((f) => (
        <div key={f.callable_name} className="rounded-lg border border-border p-3">
          <div className="flex items-center gap-2">
            <span className="font-mono text-[13px] font-semibold text-foreground">{f.callable_name}</span>
          </div>
          <p className="mt-1 text-xs text-muted">{f.description ?? "—"}</p>
        </div>
      ))}
      {functions.length === 0 ? <p className="py-6 text-center text-sm text-muted-light">暂无登记函数</p> : null}
    </div>
  );
}

/* ============================== 建模画布 ============================== */

function CanvasView({
  entities,
  relations,
  notify,
  reload,
}: {
  entities: EntityRow[];
  relations: RelationRow[];
  notify: (kind: "ok" | "err", text: string) => void;
  reload: () => Promise<void>;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [zoom, setZoom] = useState(1);
  const [trayTab, setTrayTab] = useState<TrayTab>("resource");
  const [resourceType, setResourceType] = useState<"entity" | "relation">("entity");
  const [pathFrom, setPathFrom] = useState("");
  const [pathTo, setPathTo] = useState("");
  const [pathRows, setPathRows] = useState<{ columns: string[]; rows: unknown[][] } | null>(null);
  const [pathBusy, setPathBusy] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);

  // 环形布局：节点均匀分布在画布圆周上
  const layout = useMemo(() => {
    const n = Math.max(entities.length, 1);
    const cx = 460;
    const cy = 330;
    const rx = 350;
    const ry = 250;
    const map = new Map<string, { x: number; y: number }>();
    entities.forEach((e, i) => {
      const angle = (2 * Math.PI * i) / n - Math.PI / 2;
      map.set(e.name, { x: cx + rx * Math.cos(angle), y: cy + ry * Math.sin(angle) });
    });
    return map;
  }, [entities]);

  const matches = useCallback(
    (name: string) => !search.trim() || name.toLowerCase().includes(search.trim().toLowerCase()),
    [search],
  );

  const runPath = async () => {
    setPathBusy(true);
    setPathRows(null);
    try {
      const res = await ontologyFetch("/api/v1/ontology/traverse", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fromEntity: pathFrom, toEntity: pathTo, limit: 50 }),
      });
      const json = await res.json();
      if (!res.ok) {
        notify("err", json.error?.message ?? `HTTP ${res.status}`);
        return;
      }
      const data = json.data as { columns: string[]; rows: unknown[][]; rowCount?: number };
      setPathRows(data);
      notify("ok", `路径检索完成：${data.rowCount ?? data.rows.length} 行`);
    } catch (error) {
      notify("err", String(error));
    } finally {
      setPathBusy(false);
    }
  };

  const selectedEntity = entities.find((e) => e.name === selected) ?? null;
  const selectedRelations = selected
    ? relations.filter((r) => r.from_entity === selected || r.to_entity === selected)
    : [];

  return (
    <div className="grid h-full grid-cols-[minmax(0,1fr)_300px] gap-4">
      {/* 画布 */}
      <div className={`${cardClass} relative min-h-0 overflow-hidden`}>
        <div className="absolute inset-x-3 top-3 z-10 flex flex-wrap items-center gap-2">
          <input
            className="h-8 w-56 rounded-lg border border-border bg-surface px-2.5 text-xs outline-none focus:border-muted-light"
            placeholder="搜索对象并定位"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <span className="flex-1" />
          <button type="button" className={btnGhost} onClick={() => setZoom(1)}>
            适应视图
          </button>
          <div className="flex items-center gap-1 rounded-lg border border-border bg-surface px-1.5 py-0.5 text-xs text-muted">
            <button type="button" className="px-1 hover:text-foreground" onClick={() => setZoom((z) => Math.min(2, +(z + 0.1).toFixed(2)))}>
              +
            </button>
            <span className="w-10 text-center tabular">{Math.round(zoom * 100)}%</span>
            <button type="button" className="px-1 hover:text-foreground" onClick={() => setZoom((z) => Math.max(0.4, +(z - 0.1).toFixed(2)))}>
              −
            </button>
          </div>
        </div>

        <svg viewBox="0 0 920 660" className="h-full w-full" aria-label="本体关系图">
          <defs>
            <marker id="onto-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
              <path d="M0 0 10 5 0 10Z" fill="currentColor" className="text-muted-light" />
            </marker>
          </defs>
          <g transform={`translate(460 330) scale(${zoom}) translate(-460 -330)`}>
            {relations.map((r) => {
              const a = layout.get(r.from_entity);
              const b = layout.get(r.to_entity);
              if (!a || !b || r.from_entity === r.to_entity) return null;
              const mx = (a.x + b.x) / 2;
              const my = (a.y + b.y) / 2;
              const dim = selected && r.from_entity !== selected && r.to_entity !== selected;
              return (
                <g key={r.id} opacity={dim ? 0.25 : 1}>
                  <line
                    x1={a.x}
                    y1={a.y}
                    x2={b.x}
                    y2={b.y}
                    stroke="currentColor"
                    className={selected && !dim ? "text-primary" : "text-muted-light"}
                    strokeWidth={selected && !dim ? 1.8 : 1.2}
                    strokeDasharray={r.source_field && r.target_field ? undefined : "4 3"}
                    markerEnd="url(#onto-arrow)"
                  >
                    <title>
                      {r.source_field && r.target_field
                        ? `${r.source_field} = ${r.target_field}`
                        : "未登记连接键——在「本体管理 → 本体关系」编辑后路径检索可用"}
                    </title>
                  </line>
                  <text x={mx} y={my - 4} textAnchor="middle" className="fill-muted-light text-[9px]">
                    {r.name} · {r.cardinality}
                  </text>
                </g>
              );
            })}
            {entities.map((e) => {
              const p = layout.get(e.name);
              if (!p) return null;
              const isMatch = matches(e.name);
              const isSelected = selected === e.name;
              return (
                <g
                  key={e.id}
                  transform={`translate(${p.x} ${p.y})`}
                  opacity={isMatch ? 1 : 0.25}
                  className="cursor-pointer"
                  onClick={() => setSelected(e.name)}
                >
                  <rect
                    x={-58}
                    y={-20}
                    width={116}
                    height={40}
                    rx={10}
                    className={isSelected ? "fill-surface stroke-primary" : "fill-surface stroke-border"}
                    strokeWidth={isSelected ? 2 : 1.2}
                  />
                  <text textAnchor="middle" y={-2} className="fill-foreground text-[11px] font-semibold">
                    {e.name}
                  </text>
                  <text textAnchor="middle" y={12} className="fill-muted-light text-[9px]">
                    {e.name_cn ?? `${e.attributes.length} 属性`}
                  </text>
                </g>
              );
            })}
          </g>
        </svg>
        <p className="absolute bottom-2 left-3 text-[11px] text-muted-light">
          点选对象查看上下文；关系编辑在「本体管理 → 本体关系」页签。
        </p>
      </div>

      {/* 右侧托盘 */}
      <aside className={`${cardClass} flex min-h-0 flex-col`}>
        <div className="flex gap-4 border-b border-border px-3">
          {(
            [
              ["resource", "资源"],
              ["path", "路径"],
            ] as Array<[TrayTab, string]>
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setTrayTab(key)}
              className={`relative h-9 cursor-pointer text-xs font-semibold transition-colors ${
                trayTab === key ? "text-foreground" : "text-muted-light hover:text-muted"
              }`}
            >
              {label}
              {trayTab === key ? <span className="absolute inset-x-0 bottom-0 h-0.5 rounded-t bg-primary" /> : null}
            </button>
          ))}
        </div>

        {trayTab === "resource" ? (
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex gap-2 px-3 pt-2">
              {(
                [
                  ["entity", `对象 ${entities.length}`],
                  ["relation", `关系 ${relations.length}`],
                ] as Array<["entity" | "relation", string]>
              ).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setResourceType(key)}
                  className={`rounded-lg px-2 py-1 text-[11px] font-semibold transition-colors ${
                    resourceType === key ? "bg-surface-subtle text-foreground" : "text-muted-light hover:text-muted"
                  }`}
                >
                  {label}
                </button>
              ))}
              <span className="flex-1" />
              <button type="button" className={btnGhost} onClick={() => setCreateOpen(true)}>
                新建对象
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-3">
              {resourceType === "entity"
                ? entities.map((e) => (
                    <button
                      key={e.id}
                      type="button"
                      onClick={() => setSelected(e.name)}
                      className={`mb-1 flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors ${
                        selected === e.name ? "bg-surface-subtle ring-1 ring-border" : "hover:bg-surface-subtle"
                      }`}
                    >
                      <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground">{e.name}</span>
                      {e.binding ? <StatusPill status={e.binding.status} /> : null}
                    </button>
                  ))
                : relations.map((r) => (
                    <div key={r.id} className="mb-1 rounded-lg px-2 py-1.5 hover:bg-surface-subtle">
                      <div className="text-[13px] font-medium text-foreground">{r.name}</div>
                      <div className="text-[11px] text-muted-light">
                        {r.from_entity} → {r.to_entity} · {r.cardinality}
                      </div>
                    </div>
                  ))}
            </div>
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col gap-2 p-3">
            <label className="text-[11px] text-muted-light">
              起点对象 *
              <select className={`mt-1 ${inputClass}`} value={pathFrom} onChange={(e) => setPathFrom(e.target.value)}>
                <option value="">选择对象</option>
                {entities.map((e) => (
                  <option key={e.id} value={e.name}>
                    {e.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-[11px] text-muted-light">
              终点对象 *
              <select className={`mt-1 ${inputClass}`} value={pathTo} onChange={(e) => setPathTo(e.target.value)}>
                <option value="">选择对象</option>
                {entities.map((e) => (
                  <option key={e.id} value={e.name}>
                    {e.name}
                  </option>
                ))}
              </select>
            </label>
            <button type="button" className={btnPrimary} disabled={!pathFrom || !pathTo || pathBusy} onClick={runPath}>
              {pathBusy ? "检索中…" : "检索路径"}
            </button>
            <p className="text-[11px] text-muted-light">按已登记关系编译 JOIN（两端实体需已审批绑定）。</p>
            <div className="min-h-0 flex-1 overflow-auto">
              {pathRows ? (
                <PathResultTable columns={pathRows.columns} rows={pathRows.rows} />
              ) : (
                <p className="pt-4 text-center text-xs text-muted-light">尚无检索结果</p>
              )}
            </div>
          </div>
        )}

        {/* 选中对象上下文 */}
        {selectedEntity ? (
          <div className="border-t border-border p-3">
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-semibold text-foreground">{selectedEntity.name}</h3>
              <StatusPill status={selectedEntity.status} />
              <span className="flex-1" />
              <button type="button" className="text-xs text-muted-light hover:text-foreground" onClick={() => setSelected(null)}>
                关闭
              </button>
            </div>
            <p className="mt-1 text-[11px] text-muted-light">
              {selectedEntity.name_cn ?? "—"} · {selectedEntity.attributes.length} 属性 ·{" "}
              {selectedEntity.binding ? `绑定 ${selectedEntity.binding.table_name}（${selectedEntity.binding.status}）` : "未绑定"}
            </p>
            <div className="mt-2 space-y-1">
              {selectedRelations.map((r) => (
                <div key={r.id} className="text-[11px] text-muted">
                  {r.from_entity === selectedEntity.name ? "→ " : "← "}
                  {r.name}（{r.from_entity === selectedEntity.name ? r.to_entity : r.from_entity}）
                </div>
              ))}
              {selectedRelations.length === 0 ? <div className="text-[11px] text-muted-light">无关系</div> : null}
            </div>
          </div>
        ) : null}
      </aside>

      {createOpen ? (
        <EntityCreateSheet
          entities={entities}
          reload={reload}
          notify={notify}
          onClose={() => setCreateOpen(false)}
          onCreated={(name) => {
            setCreateOpen(false);
            setSelected(name);
          }}
        />
      ) : null}
    </div>
  );
}

function PathResultTable({ columns, rows }: { columns: string[]; rows: unknown[][] }) {
  return (
    <table className="w-full text-left text-[11px]">
      <thead>
        <tr className="border-b border-border text-muted-light">
          {columns.map((c) => (
            <th key={c} className="px-2 py-1 font-medium">
              {c}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, i) => (
          <tr key={i} className="border-b border-border last:border-b-0">
            {row.map((cell, j) => (
              <td key={j} className="px-2 py-1 text-foreground">
                {String(cell)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/* ============================== 校验与版本 ============================== */

function ValidationView({
  entities,
  versions,
  reload,
  notify,
}: {
  entities: EntityRow[];
  versions: VersionRow[];
  reload: () => Promise<void>;
  notify: (kind: "ok" | "err", text: string) => void;
}) {
  const [selectedVersion, setSelectedVersion] = useState<string | null>(versions[0]?.id ?? null);
  const [checks, setChecks] = useState<CheckRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [promoteOpen, setPromoteOpen] = useState(false);
  const [promoteJson, setPromoteJson] = useState("");
  const [promoting, setPromoting] = useState(false);

  const runCheck = async (versionId: string) => {
    setBusy(true);
    try {
      const res = await ontologyFetch(`/api/v1/ontology/versions/${versionId}/check`);
      const json = await res.json();
      if (!res.ok) {
        notify("err", json.error?.message ?? `HTTP ${res.status}`);
        return;
      }
      setChecks((json.data as { checks: CheckRow[] }).checks);
    } catch (error) {
      notify("err", String(error));
    } finally {
      setBusy(false);
    }
  };

  const versionAction = async (versionId: string, action: "submit" | "publish" | "delete") => {
    if (action === "delete" && !window.confirm("删除该草稿版本？")) return;
    setBusy(true);
    try {
      const res = await ontologyFetch(
        action === "delete" ? `/api/v1/ontology/versions/${versionId}` : `/api/v1/ontology/versions/${versionId}/${action}`,
        { method: action === "delete" ? "DELETE" : "POST" },
      );
      const json = await res.json();
      if (!res.ok) {
        notify("err", json.error?.message ?? `HTTP ${res.status}`);
        return;
      }
      await reload();
      notify("ok", action === "submit" ? "一致性检查通过，组件已快照" : action === "publish" ? "版本已发布" : "草稿版本已删除");
    } catch (error) {
      notify("err", String(error));
    } finally {
      setBusy(false);
    }
  };

  const promote = async () => {
    if (promoting) return;
    let body: unknown;
    try {
      body = JSON.parse(promoteJson);
    } catch {
      notify("err", "不是合法 JSON");
      return;
    }
    setPromoting(true);
    try {
      const res = await ontologyFetch("/api/v1/ontology/promote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok) {
        notify("err", json.error?.message ?? `HTTP ${res.status}`);
        return;
      }
      setPromoteJson("");
      await reload();
      notify("ok", "候选已晋升为 draft，到「本体管理」逐个审批绑定");
    } catch (error) {
      notify("err", String(error));
    } finally {
      setPromoting(false);
    }
  };

  const blockers = checks ? checks.filter((c) => !c.ok) : null;

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <div>
          <h2 className="text-lg font-semibold text-foreground">校验与版本</h2>
          <p className="mt-0.5 text-xs text-muted-light">
            发布前检查结构完整性；版本快照不可变，草稿可删除。当前 {entities.length} 对象、
            {entities.filter((e) => e.binding?.status === "approved").length} 个绑定已批。
          </p>
        </div>
        <span className="flex-1" />
        <button type="button" className={btnGhost} onClick={() => setPromoteOpen((v) => !v)}>
          从 DataLink 晋升候选
        </button>
        <button type="button" className={btnPrimary} onClick={() => setCreateOpen(true)}>
          新建版本
        </button>
      </div>

      {promoteOpen ? (
        <div className={`${cardClass} p-3`}>
          <textarea
            className="h-36 w-full rounded-lg border border-border p-2 font-mono text-xs"
            placeholder={'{"entities":[{"name":"Lot","nameCn":"批次","table":"v_anom_wafer","idColumn":"id","attributes":[{"name":"lot","sourceColumn":"lot"}]}]}'}
            value={promoteJson}
            onChange={(e) => setPromoteJson(e.target.value)}
          />
          <div className="mt-2 flex items-center gap-3">
            <button type="button" className={btnPrimary} disabled={promoting} onClick={promote}>
              {promoting ? "晋升中…" : "晋升为 draft"}
            </button>
            <span className="text-xs text-muted-light">推断候选转正为 draft 实体/绑定，人工审批后生效（不做自动晋升）</span>
          </div>
        </div>
      ) : null}

      {/* 结构检查 */}
      <div className={`${cardClass} p-4`}>
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-semibold text-foreground">结构检查</h3>
          <select
            className={`ml-auto w-56 ${inputClass}`}
            value={selectedVersion ?? ""}
            onChange={(e) => {
              setSelectedVersion(e.target.value || null);
              setChecks(null);
            }}
          >
            <option value="">选择版本…</option>
            {versions.map((v) => (
              <option key={v.id} value={v.id}>
                v{v.version_number} · {v.name ?? "(未命名)"}（{v.status}）
              </option>
            ))}
          </select>
          <button type="button" className={btnGhost} disabled={!selectedVersion || busy} onClick={() => selectedVersion && runCheck(selectedVersion)}>
            运行检查
          </button>
        </div>
        {checks ? (
          <div className="flex flex-col gap-1">
            <div
              className={`mb-1 rounded-lg border p-2.5 text-xs ${
                blockers && blockers.length > 0
                  ? "border-rose-200 bg-rose-50 text-rose-600"
                  : "border-emerald-200 bg-emerald-50 text-emerald-700"
              }`}
            >
              {blockers && blockers.length > 0
                ? `还有 ${blockers.length} 项阻塞：${blockers.map((b) => `${b.entity}（${b.reason}）`).join("；")}`
                : "全部通过，可以提交并发布。"}
            </div>
            {checks.map((c) => (
              <div key={c.entity} className="flex items-center gap-2 rounded-lg px-2 py-1 text-xs hover:bg-surface-subtle">
                <span className={c.ok ? "text-emerald-600" : "text-rose-500"}>{c.ok ? "✓" : "✕"}</span>
                <span className="font-medium text-foreground">{c.entity}</span>
                <span className="text-muted-light">{c.ok ? "通过" : c.reason}</span>
              </div>
            ))}
          </div>
        ) : (
          <p className="py-4 text-center text-xs text-muted-light">选择一个版本并运行检查，查看逐对象一致性结果。</p>
        )}
      </div>

      {/* 版本时间线 */}
      <div className={`${cardClass} p-4`}>
        <h3 className="mb-1 text-sm font-semibold text-foreground">版本记录</h3>
        <p className="mb-3 text-xs text-muted-light">发布生成不可变版本快照；草稿可删除，删除不影响已发布记录。</p>
        <div className="flex flex-col gap-2">
          {versions.map((v) => (
            <div key={v.id} className="flex flex-wrap items-center gap-3 rounded-lg border border-border p-2.5">
              <span className="font-mono text-sm font-semibold text-foreground">v{v.version_number}</span>
              <StatusPill status={v.status} />
              <span className="text-sm text-foreground">{v.name ?? "(未命名)"}</span>
              <span className="text-xs text-muted-light">{v.entity_count} 实体</span>
              <span className="text-xs text-muted-light">
                {v.published_at ? `发布于 ${new Date(v.published_at).toLocaleString("zh-CN")}` : v.created_at ? `创建于 ${new Date(v.created_at).toLocaleString("zh-CN")}` : ""}
              </span>
              <span className="flex-1" />
              <button type="button" className={btnGhost} onClick={() => { setSelectedVersion(v.id); setChecks(null); runCheck(v.id); }}>
                检查
              </button>
              {v.status === "draft" ? (
                <>
                  <button type="button" className={btnGhost} disabled={busy} onClick={() => versionAction(v.id, "submit")}>
                    提交
                  </button>
                  <button type="button" className={btnGhost} disabled={busy} onClick={() => versionAction(v.id, "delete")}>
                    删除
                  </button>
                </>
              ) : null}
              {v.status === "submitted" ? (
                <button type="button" className={btnPrimary} disabled={busy} onClick={() => versionAction(v.id, "publish")}>
                  发布
                </button>
              ) : null}
            </div>
          ))}
          {versions.length === 0 ? <p className="py-6 text-center text-xs text-muted-light">还没有版本，先「新建版本」圈定实体范围。</p> : null}
        </div>
      </div>

      {createOpen ? (
        <VersionCreateSheet
          entities={entities}
          reload={reload}
          notify={notify}
          onClose={() => setCreateOpen(false)}
        />
      ) : null}
    </div>
  );
}

function VersionCreateSheet({
  entities,
  reload,
  notify,
  onClose,
}: {
  entities: EntityRow[];
  reload: () => Promise<void>;
  notify: (kind: "ok" | "err", text: string) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const create = async () => {
    setSaving(true);
    try {
      const res = await ontologyFetch("/api/v1/ontology/versions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, entityIds: [...selected] }),
      });
      const json = await res.json();
      if (!res.ok) {
        notify("err", json.error?.message ?? `HTTP ${res.status}`);
        return;
      }
      await reload();
      notify("ok", "版本草稿已创建");
      onClose();
    } catch (error) {
      notify("err", String(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Sheet title="新建版本" subtitle="圈定进入本版本的实体范围；提交时逐对象做一致性检查。" onClose={onClose}>
      <label className="text-xs text-muted-light">
        版本名称 *
        <input className={`mt-1 ${inputClass}`} value={name} onChange={(e) => setName(e.target.value)} placeholder="如 v1-spc-baseline" />
      </label>
      <div className="mt-3 max-h-72 overflow-y-auto rounded-lg border border-border">
        {entities.map((e) => (
          <label key={e.id} className="flex cursor-pointer items-center gap-2 border-b border-border px-3 py-2 text-sm last:border-b-0 hover:bg-surface-subtle">
            <input type="checkbox" checked={selected.has(e.id)} onChange={() => toggle(e.id)} />
            <span className="font-medium text-foreground">{e.name}</span>
            <span className="text-xs text-muted-light">{e.name_cn ?? ""}</span>
            <span className="ml-auto">
              {e.binding ? <StatusPill status={e.binding.status} /> : <span className="text-[10px] text-muted-light">未绑定</span>}
            </span>
          </label>
        ))}
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" className={btnGhost} onClick={onClose}>
          取消
        </button>
        <button type="button" className={btnPrimary} disabled={!name.trim() || selected.size === 0 || saving} onClick={create}>
          {saving ? "创建中…" : "创建草稿版本"}
        </button>
      </div>
    </Sheet>
  );
}

/* ============================== 通用表单弹层 ============================== */

function Sheet({
  title,
  subtitle,
  children,
  onClose,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-6" onClick={onClose}>
      <section
        className={`${cardClass} max-h-[88vh] w-full max-w-xl overflow-y-auto p-5`}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="mb-4">
          <h2 className="text-base font-semibold text-foreground">{title}</h2>
          {subtitle ? <p className="mt-1 text-xs text-muted">{subtitle}</p> : null}
        </div>
        {children}
      </section>
    </div>
  );
}

function EntityCreateSheet({
  entities,
  reload,
  notify,
  onClose,
  onCreated,
}: {
  entities: EntityRow[];
  reload: () => Promise<void>;
  notify: (kind: "ok" | "err", text: string) => void;
  onClose: () => void;
  onCreated: (name: string) => void;
}) {
  const [name, setName] = useState("");
  const [nameCn, setNameCn] = useState("");
  const [description, setDescription] = useState("");
  const [attrs, setAttrs] = useState<AttrDraft[]>([emptyAttrDraft()]);
  const [saving, setSaving] = useState(false);

  const create = async () => {
    setSaving(true);
    try {
      const res = await ontologyFetch("/api/v1/ontology/entities", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          nameCn: nameCn || undefined,
          description: description || undefined,
          attributes: attrs
            .filter((a) => a.name.trim())
            .map((a) => ({
              name: a.name.trim(),
              displayName: a.displayName || undefined,
              type: a.type,
              required: a.required,
            })),
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        notify("err", json.error?.message ?? `HTTP ${res.status}`);
        return;
      }
      await reload();
      notify("ok", `实体 ${name} 已创建（draft）— 下一步到「本体映射」关联物理表`);
      onCreated(name);
    } catch (error) {
      notify("err", String(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Sheet title="新建对象" subtitle="对象是业务世界的可查询事物，发布后供智能体引用。" onClose={onClose}>
      <div className="grid grid-cols-2 gap-3">
        <label className="text-xs text-muted-light">
          名称（英文标识）*
          <input className={`mt-1 ${inputClass}`} value={name} onChange={(e) => setName(e.target.value)} placeholder="如 SalesOrder" />
        </label>
        <label className="text-xs text-muted-light">
          中文名
          <input className={`mt-1 ${inputClass}`} value={nameCn} onChange={(e) => setNameCn(e.target.value)} placeholder="如 销售订单" />
        </label>
      </div>
      <label className="mt-3 block text-xs text-muted-light">
        描述
        <input className={`mt-1 ${inputClass}`} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="可选" />
      </label>
      <div className="mt-3">
        <div className="mb-1 flex items-center justify-between">
          <span className="text-xs font-semibold text-foreground">属性</span>
          <button
            type="button"
            className="rounded-lg border border-border px-2 py-0.5 text-xs text-muted hover:bg-surface-subtle"
            onClick={() => setAttrs((rows) => [...rows, emptyAttrDraft()])}
          >
            + 添加属性
          </button>
        </div>
        <div className="space-y-2">
          {attrs.map((attr, i) => (
            <div key={i} className="flex items-center gap-2">
              <input
                className={`w-44 ${inputClass}`}
                value={attr.name}
                onChange={(e) => setAttrs((rows) => rows.map((r, j) => (j === i ? { ...r, name: e.target.value } : r)))}
                placeholder="属性名"
              />
              <input
                className={`w-36 ${inputClass}`}
                value={attr.displayName}
                onChange={(e) => setAttrs((rows) => rows.map((r, j) => (j === i ? { ...r, displayName: e.target.value } : r)))}
                placeholder="显示名"
              />
              <select
                className={`w-28 ${inputClass}`}
                value={attr.type}
                onChange={(e) => setAttrs((rows) => rows.map((r, j) => (j === i ? { ...r, type: e.target.value } : r)))}
              >
                {["string", "number", "boolean"].map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
              <label className="flex items-center gap-1 text-xs text-muted">
                <input
                  type="checkbox"
                  checked={attr.required}
                  onChange={(e) => setAttrs((rows) => rows.map((r, j) => (j === i ? { ...r, required: e.target.checked } : r)))}
                />
                必填
              </label>
              <button
                type="button"
                className="text-xs text-rose-500 hover:underline"
                onClick={() => setAttrs((rows) => rows.filter((_, j) => j !== i))}
              >
                移除
              </button>
            </div>
          ))}
        </div>
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" className={btnGhost} onClick={onClose}>
          取消
        </button>
        <button type="button" className={btnPrimary} disabled={!name.trim() || saving} onClick={create}>
          {saving ? "创建中…" : "创建（draft）"}
        </button>
      </div>
      <p className="mt-2 text-[11px] text-muted-light">已存在 {entities.length} 个对象；重名将返回 409。</p>
    </Sheet>
  );
}
