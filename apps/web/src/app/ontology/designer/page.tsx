"use client";

import { useCallback, useEffect, useState } from "react";

import { ontologyFetch } from "../../../lib/ontology-client";

type Attribute = {
  id: string;
  name: string;
  display_name: string | null;
  type: string;
  required: number;
};

type EntityRow = {
  id: string;
  name: string;
  name_cn: string | null;
  status: string;
  attributes: Attribute[];
  binding: { status: string } | null;
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

type AttrDraft = { name: string; displayName: string; type: string; required: boolean };

const TYPE_OPTIONS = ["string", "number", "boolean"];
const CARDINALITY_OPTIONS = ["1:1", "1:N", "N:1", "N:N"];

const emptyAttr = (): AttrDraft => ({ name: "", displayName: "", type: "string", required: false });

export default function OntologyDesignerPage() {
  const [entities, setEntities] = useState<EntityRow[]>([]);
  const [relations, setRelations] = useState<RelationRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  // 实体表单：editing=null → 新建；否则为被编辑实体名
  const [editing, setEditing] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [name, setName] = useState("");
  const [nameCn, setNameCn] = useState("");
  const [description, setDescription] = useState("");
  const [attrs, setAttrs] = useState<AttrDraft[]>([emptyAttr()]);

  // 关系表单
  const [relOpen, setRelOpen] = useState(false);
  const [relName, setRelName] = useState("");
  const [relFrom, setRelFrom] = useState("");
  const [relTo, setRelTo] = useState("");
  const [relCardinality, setRelCardinality] = useState("1:N");
  const [relSourceField, setRelSourceField] = useState("");
  const [relTargetField, setRelTargetField] = useState("");

  const reload = useCallback(async () => {
    const [entityRes, contextRes] = await Promise.all([
      fetch("/api/v1/ontology/entities", { credentials: "same-origin" }).then((r) => r.json()),
      fetch("/api/v1/ontology/context", { credentials: "same-origin" }).then((r) => r.json())
    ]);
    setEntities((entityRes.data as { entities: EntityRow[] }).entities);
    setRelations((contextRes.data as { relations: RelationRow[] }).relations);
  }, []);

  useEffect(() => {
    reload()
      .catch((e) => setMessage({ kind: "err", text: String(e) }))
      .finally(() => setLoading(false));
  }, [reload]);

  const openCreate = () => {
    setEditing(null);
    setName("");
    setNameCn("");
    setDescription("");
    setAttrs([emptyAttr()]);
    setFormOpen(true);
    setMessage(null);
  };

  const openEdit = (entity: EntityRow) => {
    setEditing(entity.name);
    setName(entity.name);
    setNameCn(entity.name_cn ?? "");
    setDescription("");
    setAttrs(
      entity.attributes.length > 0
        ? entity.attributes.map((a) => ({
            name: a.name,
            displayName: a.display_name ?? "",
            type: a.type,
            required: a.required === 1
          }))
        : [emptyAttr()]
    );
    setFormOpen(true);
    setMessage(null);
  };

  const typeOptions = useCallback(() => {
    const used = new Set(attrs.map((a) => a.type));
    return [...new Set([...TYPE_OPTIONS, ...used])];
  }, [attrs]);

  const saveEntity = async () => {
    setMessage(null);
    setSaving(true);
    try {
      const body = {
        ...(editing ? {} : { name }),
        nameCn: nameCn || undefined,
        description: description || undefined,
        attributes: attrs
          .filter((a) => a.name.trim())
          .map((a) => ({
            name: a.name.trim(),
            displayName: a.displayName || undefined,
            type: a.type,
            required: a.required
          }))
      };
      const res = await ontologyFetch(
        editing ? `/api/v1/ontology/entities/${encodeURIComponent(editing)}` : "/api/v1/ontology/entities",
        {
          method: editing ? "PUT" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body)
        }
      );
      const json = await res.json();
      if (!res.ok) {
        setMessage({ kind: "err", text: json.error?.message ?? `HTTP ${res.status}` });
        return;
      }
      setFormOpen(false);
      await reload();
      setMessage({
        kind: "ok",
        text: editing
          ? `✅ 实体 ${editing} 已更新`
          : `✅ 实体 ${name} 已创建（draft）— 下一步到绑定编辑器关联物理表`
      });
    } catch (error) {
      setMessage({ kind: "err", text: String(error) });
    } finally {
      setSaving(false);
    }
  };

  const deleteEntity = async (entityName: string) => {
    if (!window.confirm(`删除实体 ${entityName}？其属性、draft 绑定与相关关系将一并删除。`)) return;
    setMessage(null);
    setSaving(true);
    try {
      const res = await ontologyFetch(`/api/v1/ontology/entities/${encodeURIComponent(entityName)}`, {
        method: "DELETE"
      });
      const json = await res.json();
      if (!res.ok) {
        setMessage({ kind: "err", text: json.error?.message ?? `HTTP ${res.status}` });
        return;
      }
      await reload();
      setMessage({ kind: "ok", text: `✅ 实体 ${entityName} 已删除` });
    } catch (error) {
      setMessage({ kind: "err", text: String(error) });
    } finally {
      setSaving(false);
    }
  };

  const saveRelation = async () => {
    setMessage(null);
    setSaving(true);
    try {
      const res = await ontologyFetch("/api/v1/ontology/relations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: relName,
          fromEntity: relFrom,
          toEntity: relTo,
          cardinality: relCardinality,
          sourceField: relSourceField || undefined,
          targetField: relTargetField || undefined
        })
      });
      const json = await res.json();
      if (!res.ok) {
        setMessage({ kind: "err", text: json.error?.message ?? `HTTP ${res.status}` });
        return;
      }
      setRelOpen(false);
      setRelName("");
      setRelSourceField("");
      setRelTargetField("");
      await reload();
      setMessage({ kind: "ok", text: `✅ 关系 ${relName} 已创建` });
    } catch (error) {
      setMessage({ kind: "err", text: String(error) });
    } finally {
      setSaving(false);
    }
  };

  const deleteRelation = async (relation: RelationRow) => {
    if (!window.confirm(`删除关系 ${relation.from_entity} -${relation.name}-> ${relation.to_entity}？`)) return;
    setMessage(null);
    setSaving(true);
    try {
      const res = await ontologyFetch(`/api/v1/ontology/relations/${encodeURIComponent(relation.id)}`, {
        method: "DELETE"
      });
      const json = await res.json();
      if (!res.ok) {
        setMessage({ kind: "err", text: json.error?.message ?? `HTTP ${res.status}` });
        return;
      }
      await reload();
      setMessage({ kind: "ok", text: `✅ 关系 ${relation.name} 已删除` });
    } catch (error) {
      setMessage({ kind: "err", text: String(error) });
    } finally {
      setSaving(false);
    }
  };

  if (loading)
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50 text-sm text-slate-500">
        Loading designer…
      </div>
    );

  return (
    <div className="min-h-screen bg-slate-50 p-6">
      <header className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">本体设计器</h1>
          <p className="mt-1 text-sm text-slate-500">
            实体/属性/关系建模 · {entities.length} 实体 · {relations.length} 关系 · 保存后到版本发布生效
          </p>
        </div>
        <div className="flex gap-3">
          <a
            href="/ontology"
            className="rounded-md border border-slate-300 px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100"
          >
            返回治理
          </a>
        </div>
      </header>

      {message ? (
        <div
          className={`mb-4 rounded-md border px-4 py-2 text-sm ${
            message.kind === "ok"
              ? "border-green-200 bg-green-50 text-green-700"
              : "border-red-200 bg-red-50 text-red-600"
          }`}
        >
          {message.text}
        </div>
      ) : null}

      <Section title="实体">
        <div className="mb-3">
          <button
            type="button"
            onClick={() => (formOpen && !editing ? setFormOpen(false) : openCreate())}
            className="rounded border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-100"
          >
            新建实体
          </button>
        </div>
        {formOpen ? (
          <div className="mb-4 rounded-md border border-slate-200 bg-slate-50 p-3">
            <div className="grid grid-cols-3 gap-3">
              <label className="text-xs text-slate-500">
                实体名（字母/数字/下划线/中文，创建后不可改）
                <input
                  className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5 text-sm disabled:bg-slate-100"
                  value={name}
                  disabled={Boolean(editing)}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Chamber"
                />
              </label>
              <label className="text-xs text-slate-500">
                中文名
                <input
                  className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5 text-sm"
                  value={nameCn}
                  onChange={(e) => setNameCn(e.target.value)}
                  placeholder="腔体"
                />
              </label>
              <label className="text-xs text-slate-500">
                描述（仅新建时可填）
                <input
                  className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5 text-sm disabled:bg-slate-100"
                  value={description}
                  disabled={Boolean(editing)}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="可选"
                />
              </label>
            </div>
            <div className="mt-3">
              <div className="mb-1 flex items-center justify-between text-xs text-slate-500">
                <span>属性（name 会作为查询结果列名，需过标识符白名单）</span>
                <button
                  type="button"
                  onClick={() => setAttrs((rows) => [...rows, emptyAttr()])}
                  className="rounded border border-slate-300 px-2 py-0.5 text-slate-600 hover:bg-slate-100"
                >
                  + 添加属性
                </button>
              </div>
              <div className="space-y-2">
                {attrs.map((attr, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <input
                      className="w-48 rounded border border-slate-300 px-2 py-1.5 text-sm"
                      value={attr.name}
                      onChange={(e) =>
                        setAttrs((rows) => rows.map((r, j) => (j === i ? { ...r, name: e.target.value } : r)))
                      }
                      placeholder="属性名（如 chamber_id）"
                    />
                    <input
                      className="w-40 rounded border border-slate-300 px-2 py-1.5 text-sm"
                      value={attr.displayName}
                      onChange={(e) =>
                        setAttrs((rows) => rows.map((r, j) => (j === i ? { ...r, displayName: e.target.value } : r)))
                      }
                      placeholder="显示名（可选）"
                    />
                    <select
                      className="rounded border border-slate-300 px-2 py-1.5 text-sm"
                      value={attr.type}
                      onChange={(e) =>
                        setAttrs((rows) => rows.map((r, j) => (j === i ? { ...r, type: e.target.value } : r)))
                      }
                    >
                      {typeOptions().map((t) => (
                        <option key={t} value={t}>
                          {t}
                        </option>
                      ))}
                    </select>
                    <label className="flex items-center gap-1 text-xs text-slate-600">
                      <input
                        type="checkbox"
                        checked={attr.required}
                        onChange={(e) =>
                          setAttrs((rows) => rows.map((r, j) => (j === i ? { ...r, required: e.target.checked } : r)))
                        }
                      />
                      必填
                    </label>
                    <button
                      type="button"
                      onClick={() => setAttrs((rows) => rows.filter((_, j) => j !== i))}
                      className="text-xs text-red-500 hover:underline"
                    >
                      移除
                    </button>
                  </div>
                ))}
              </div>
            </div>
            <div className="mt-3 flex items-center gap-3">
              <button
                type="button"
                onClick={saveEntity}
                disabled={saving || (editing ? false : !name.trim())}
                className="rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
              >
                {saving ? "保存中…" : editing ? `保存 ${editing}` : "创建实体（draft）"}
              </button>
              <button
                type="button"
                onClick={() => setFormOpen(false)}
                className="text-sm text-slate-500 hover:underline"
              >
                取消
              </button>
              {editing ? (
                <span className="text-xs text-slate-400">
                  编辑按属性名同步：已有属性保留 id（绑定映射不断链），表单里移除的属性会被删除
                </span>
              ) : null}
            </div>
          </div>
        ) : null}
        <Table
          headers={["实体", "中文名", "状态", "属性", "绑定", "操作"]}
          rows={entities.map((e) => [
            <span key="name" className="font-medium text-slate-800">
              {e.name}
            </span>,
            e.name_cn ?? "—",
            <StatusPill key="status" status={e.status} />,
            e.attributes.map((a) => a.name).join("、") || "—",
            e.binding ? <StatusPill key="binding" status={e.binding.status} /> : <span className="text-xs text-slate-400">未绑定</span>,
            <div key="actions" className="flex gap-3">
              <button type="button" onClick={() => openEdit(e)} className="text-blue-600 hover:underline">
                编辑
              </button>
              {e.status === "draft" ? (
                <button type="button" onClick={() => deleteEntity(e.name)} className="text-red-500 hover:underline">
                  删除
                </button>
              ) : null}
            </div>
          ])}
        />
      </Section>

      <Section title="关系">
        <div className="mb-3">
          <button
            type="button"
            onClick={() => setRelOpen((v) => !v)}
            className="rounded border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-100"
          >
            {relOpen ? "收起" : "新建关系"}
          </button>
        </div>
        {relOpen ? (
          <div className="mb-4 rounded-md border border-slate-200 bg-slate-50 p-3">
            <div className="flex flex-wrap items-end gap-3">
              <label className="text-xs text-slate-500">
                名称
                <input
                  className="mt-1 w-44 rounded border border-slate-300 px-2 py-1.5 text-sm"
                  value={relName}
                  onChange={(e) => setRelName(e.target.value)}
                  placeholder="has_events"
                />
              </label>
              <label className="text-xs text-slate-500">
                起点
                <select
                  className="mt-1 w-40 rounded border border-slate-300 px-2 py-1.5 text-sm"
                  value={relFrom}
                  onChange={(e) => setRelFrom(e.target.value)}
                >
                  <option value="">选择实体</option>
                  {entities.map((e) => (
                    <option key={e.id} value={e.name}>
                      {e.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-xs text-slate-500">
                终点
                <select
                  className="mt-1 w-40 rounded border border-slate-300 px-2 py-1.5 text-sm"
                  value={relTo}
                  onChange={(e) => setRelTo(e.target.value)}
                >
                  <option value="">选择实体</option>
                  {entities.map((e) => (
                    <option key={e.id} value={e.name}>
                      {e.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-xs text-slate-500">
                基数
                <select
                  className="mt-1 w-24 rounded border border-slate-300 px-2 py-1.5 text-sm"
                  value={relCardinality}
                  onChange={(e) => setRelCardinality(e.target.value)}
                >
                  {CARDINALITY_OPTIONS.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-xs text-slate-500">
                源字段
                <input
                  className="mt-1 w-36 rounded border border-slate-300 px-2 py-1.5 text-sm"
                  value={relSourceField}
                  onChange={(e) => setRelSourceField(e.target.value)}
                  placeholder="chamber_id"
                />
              </label>
              <label className="text-xs text-slate-500">
                目标字段
                <input
                  className="mt-1 w-36 rounded border border-slate-300 px-2 py-1.5 text-sm"
                  value={relTargetField}
                  onChange={(e) => setRelTargetField(e.target.value)}
                  placeholder="chamber_id"
                />
              </label>
              <button
                type="button"
                onClick={saveRelation}
                disabled={saving || !relName.trim() || !relFrom || !relTo}
                className="rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
              >
                {saving ? "创建中…" : "创建关系"}
              </button>
            </div>
            <p className="mt-2 text-xs text-slate-400">
              源/目标字段填两端的<b>属性名</b>（traverse 编译 JOIN 时经绑定映射翻译为物理列，填未映射的列名会报"关系字段未映射"）；
              两端实体绑定审批后，关系即可被遍历查询使用。
            </p>
          </div>
        ) : null}
        <Table
          headers={["名称", "起点", "终点", "基数", "源字段", "目标字段", "操作"]}
          rows={relations.map((r) => [
            r.name,
            r.from_entity,
            r.to_entity,
            r.cardinality,
            r.source_field ?? "—",
            r.target_field ?? "—",
            <button
              key="del"
              type="button"
              onClick={() => deleteRelation(r)}
              className="text-red-500 hover:underline"
            >
              删除
            </button>
          ])}
        />
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-6 rounded-lg border border-slate-200 bg-white shadow-sm">
      <h2 className="border-b border-slate-200 px-4 py-3 text-sm font-medium text-slate-700">{title}</h2>
      <div className="p-4">{children}</div>
    </section>
  );
}

function Table({ headers, rows }: { headers: string[]; rows: React.ReactNode[][] }) {
  return (
    <table className="w-full text-left text-sm">
      <thead>
        <tr className="border-b border-slate-200 text-xs text-slate-500 uppercase">
          {headers.map((h) => (
            <th key={h} className="px-3 py-2 font-medium">
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, i) => (
          <tr key={i} className="border-b border-slate-100 hover:bg-slate-50">
            {row.map((cell, j) => (
              <td key={j} className="px-3 py-2 text-slate-700">
                {cell}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function StatusPill({ status }: { status: string }) {
  const styles: Record<string, string> = {
    approved: "bg-green-100 text-green-700",
    draft: "bg-yellow-100 text-yellow-700",
    published: "bg-blue-100 text-blue-700",
  };
  return (
    <span
      className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${styles[status] ?? "bg-slate-100 text-slate-600"}`}
    >
      {status}
    </span>
  );
}
