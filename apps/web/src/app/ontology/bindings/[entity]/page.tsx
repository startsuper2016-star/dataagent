"use client";

import { useParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import { ontologyFetch } from "../../../../lib/ontology-client";

type Attribute = {
  id: string;
  name: string;
  display_name: string | null;
  type: string;
  required: number;
};

type Binding = {
  id: string;
  table_name: string;
  id_column: string;
  field_mappings_json: string;
  filter_expr: string | null;
  status: string;
};

type EntityPayload = {
  entities: Array<{
    id: string;
    name: string;
    name_cn: string | null;
    status: string;
    attributes: Attribute[];
    binding: Binding | null;
  }>;
};

type Column = { name: string; type: string };

/** 解析 field_mappings_json 的两种历史形态（数组 / Record），统一进 mappings 状态。 */
const parseMappings = (raw: string | null | undefined): Record<string, string> => {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    const result: Record<string, string> = {};
    if (Array.isArray(parsed)) {
      for (const item of parsed as Array<{ attribute_id?: string; source_column?: string }>) {
        if (item.attribute_id && item.source_column) result[item.attribute_id] = item.source_column;
      }
    } else if (parsed && typeof parsed === "object") {
      // Record 形态键为属性名（历史数据）：保存时按 id 归一化为数组形态
      for (const [k, v] of Object.entries(parsed as Record<string, string>)) {
        result[`name:${k}`] = v;
      }
    }
    return result;
  } catch {
    return {};
  }
};

export default function BindingEditorPage() {
  const params = useParams<{ entity: string }>();
  const entityName = decodeURIComponent(params.entity);

  const [entity, setEntity] = useState<EntityPayload["entities"][number] | null>(null);
  const [tables, setTables] = useState<Array<{ name: string; columns: Column[] }>>([]);
  const [table, setTable] = useState("");
  const [idColumn, setIdColumn] = useState("");
  const [mappings, setMappings] = useState<Record<string, string>>({});
  const [status, setStatus] = useState("");
  const [message, setMessage] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      fetch("/api/v1/ontology/entities", { credentials: "same-origin" }).then((r) => r.json()),
      fetch("/api/v1/ontology/datasource/tables", { credentials: "same-origin" }).then((r) => r.json())
    ])
      .then(([entityRes, tablesRes]) => {
        const found = (entityRes.data as EntityPayload).entities.find((e) => e.name === entityName) ?? null;
        setEntity(found);
        setTables((tablesRes.data as { tables: Array<{ name: string; columns: Column[] }> }).tables);
        if (found?.binding) {
          setTable(found.binding.table_name);
          setIdColumn(found.binding.id_column);
          setMappings(parseMappings(found.binding.field_mappings_json));
          setStatus(found.binding.status);
        }
      })
      .catch((e) => setMessage({ kind: "err", text: String(e) }))
      .finally(() => setLoading(false));
  }, [entityName]);

  const columns = useMemo(
    () => tables.find((t) => t.name === table)?.columns ?? [],
    [tables, table]
  );

  const columnOptions = useMemo(() => {
    const used = new Set(Object.values(mappings));
    return columns.map((c) => ({ ...c, usedElsewhere: used.has(c.name) }));
  }, [columns, mappings]);

  const mappedCount = Object.values(mappings).filter(Boolean).length;

  const save = async () => {
    setMessage(null);
    const body = {
      table,
      idColumn,
      fieldMappings: (entity?.attributes ?? [])
        .filter((a) => mappings[a.id])
        .map((a) => ({ attribute_id: a.id, source_column: mappings[a.id] }))
    };
    const res = await ontologyFetch(`/api/v1/ontology/bindings/${encodeURIComponent(entityName)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    const json = await res.json();
    if (!res.ok) {
      setMessage({ kind: "err", text: json.error?.message ?? `HTTP ${res.status}` });
      return;
    }
    setStatus(json.data.status);
    setMessage({ kind: "ok", text: "已保存（状态打回 draft，需重新审批）" });
  };

  const approve = async () => {
    setMessage(null);
    const res = await ontologyFetch(
      `/api/v1/ontology/bindings/${encodeURIComponent(entityName)}/approve`,
      { method: "POST" }
    );
    const json = await res.json();
    if (!res.ok) {
      setMessage({ kind: "err", text: json.error?.message ?? `HTTP ${res.status}` });
      return;
    }
    setStatus(json.data.status);
    setMessage({ kind: "ok", text: "审批通过，绑定已生效" });
  };

  if (loading)
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50 text-sm text-slate-500">
        Loading binding editor…
      </div>
    );
  if (!entity)
    return (
      <div className="flex min-h-screen items-center justify-center bg-red-50 text-sm text-red-600">
        实体不存在: {entityName}
      </div>
    );

  return (
    <div className="min-h-screen bg-slate-50 p-6">
      <header className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">
            绑定编辑 · {entity.name}
            {entity.name_cn ? <span className="ml-2 text-sm text-slate-500">{entity.name_cn}</span> : null}
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            状态 <StatusPill status={status} /> · 映射 {mappedCount}/{entity.attributes.length}
            {entity.attributes.length > 0 && mappedCount * 2 < entity.attributes.length ? (
              <span className="ml-2 text-red-500">覆盖率不足 50%，无法审批</span>
            ) : null}
          </p>
        </div>
        <a
          href="/ontology"
          className="rounded-md border border-slate-300 px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100"
        >
          返回本体
        </a>
      </header>

      {message ? (
        <div
          className={`mb-4 rounded-md border px-4 py-3 text-sm ${
            message.kind === "ok"
              ? "border-green-200 bg-green-50 text-green-700"
              : "border-red-200 bg-red-50 text-red-600"
          }`}
        >
          {message.text}
        </div>
      ) : null}

      <div className="mb-6 grid grid-cols-2 gap-4 rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
        <label className="text-sm">
          <span className="mb-1 block font-medium text-slate-700">数据表</span>
          <select
            className="w-full rounded-md border border-slate-300 px-3 py-2"
            value={table}
            onChange={(e) => {
              setTable(e.target.value);
              setIdColumn("");
            }}
          >
            <option value="">— 选择表 —</option>
            {tables.map((t) => (
              <option key={t.name} value={t.name}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          <span className="mb-1 block font-medium text-slate-700">ID 列</span>
          <select
            className="w-full rounded-md border border-slate-300 px-3 py-2"
            value={idColumn}
            onChange={(e) => setIdColumn(e.target.value)}
          >
            <option value="">— 选择列 —</option>
            {columns.map((c) => (
              <option key={c.name} value={c.name}>
                {c.name} ({c.type || "any"})
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="rounded-lg border border-slate-200 bg-white shadow-sm">
        <h2 className="border-b border-slate-200 px-4 py-3 text-sm font-medium text-slate-700">
          字段映射（属性 → 物理列）
        </h2>
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-xs uppercase text-slate-500">
              <th className="px-3 py-2 font-medium">属性</th>
              <th className="px-3 py-2 font-medium">类型</th>
              <th className="px-3 py-2 font-medium">物理列</th>
            </tr>
          </thead>
          <tbody>
            {entity.attributes.map((a) => {
              const boundNameOnly = mappings[`name:${a.name}`];
              const value = mappings[a.id] ?? boundNameOnly ?? "";
              return (
                <tr key={a.id} className="border-b border-slate-100">
                  <td className="px-3 py-2 text-slate-700">
                    {a.display_name || a.name}
                    {a.required ? <span className="ml-1 text-red-500">*</span> : null}
                  </td>
                  <td className="px-3 py-2 text-slate-500">{a.type}</td>
                  <td className="px-3 py-2">
                    <select
                      className="w-64 rounded-md border border-slate-300 px-2 py-1"
                      value={value}
                      onChange={(e) =>
                        setMappings((prev) => ({ ...prev, [a.id]: e.target.value }))
                      }
                    >
                      <option value="">— 未映射 —</option>
                      {columnOptions.map((c) => (
                        <option key={c.name} value={c.name}>
                          {c.name}
                          {c.usedElsewhere && c.name !== value ? "（已被其他属性占用）" : ""}
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

      <div className="mt-6 flex gap-3">
        <button
          type="button"
          onClick={save}
          disabled={!table || !idColumn}
          className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-40"
        >
          保存
        </button>
        <button
          type="button"
          onClick={approve}
          disabled={!table || !idColumn}
          className="rounded-md bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-40"
        >
          保存并审批
        </button>
      </div>
    </div>
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
      {status || "未绑定"}
    </span>
  );
}
