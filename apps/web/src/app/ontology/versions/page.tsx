"use client";

import { useEffect, useState } from "react";

import { ontologyFetch } from "../../../lib/ontology-client";

type VersionRow = {
  id: string;
  version_number: number;
  status: string;
  name: string;
  description: string | null;
  created_at: string | null;
  submitted_at: string | null;
  published_at: string | null;
  entity_count: number;
};

type EntityRow = {
  id: string;
  name: string;
  name_cn: string | null;
  status: string;
  binding: { status: string } | null;
};

type Check = { entity: string; ok: boolean; reason?: string };

export default function VersionsPage() {
  const [versions, setVersions] = useState<VersionRow[]>([]);
  const [entities, setEntities] = useState<EntityRow[]>([]);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [checksByVersion, setChecksByVersion] = useState<Record<string, Check[]>>({});
  const [message, setMessage] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [loading, setLoading] = useState(true);

  const load = () =>
    Promise.all([
      fetch("/api/v1/ontology/versions", { credentials: "same-origin" }).then((r) => r.json()),
      fetch("/api/v1/ontology/entities", { credentials: "same-origin" }).then((r) => r.json())
    ])
      .then(([v, e]) => {
        setVersions((v.data as { versions: VersionRow[] }).versions);
        setEntities((e.data as { entities: EntityRow[] }).entities);
      })
      .catch((err) => setMessage({ kind: "err", text: String(err) }));

  useEffect(() => {
    load().finally(() => setLoading(false));
  }, []);

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const create = async () => {
    setMessage(null);
    const res = await ontologyFetch("/api/v1/ontology/versions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, entityIds: [...selected] })
    });
    const json = await res.json();
    if (!res.ok) {
      setMessage({ kind: "err", text: json.error?.message ?? `HTTP ${res.status}` });
      return;
    }
    setCreating(false);
    setName("");
    setSelected(new Set());
    setMessage({ kind: "ok", text: "版本草稿已创建" });
    await load();
  };

  const runCheck = async (id: string) => {
    const res = await fetch(`/api/v1/ontology/versions/${id}/check`, { credentials: "same-origin" });
    const json = await res.json();
    if (!res.ok) {
      setMessage({ kind: "err", text: json.error?.message ?? `HTTP ${res.status}` });
      return;
    }
    setChecksByVersion((prev) => ({ ...prev, [id]: (json.data as { checks: Check[] }).checks }));
  };

  const submit = async (id: string) => {
    setMessage(null);
    const res = await ontologyFetch(`/api/v1/ontology/versions/${id}/submit`, {
      method: "POST"
    });
    const json = await res.json();
    if (!res.ok) {
      setMessage({ kind: "err", text: json.error?.message ?? `HTTP ${res.status}` });
      await runCheck(id);
      return;
    }
    setMessage({ kind: "ok", text: "一致性检查通过，组件已快照" });
    await load();
  };

  const publish = async (id: string) => {
    setMessage(null);
    const res = await ontologyFetch(`/api/v1/ontology/versions/${id}/publish`, {
      method: "POST"
    });
    const json = await res.json();
    if (!res.ok) {
      setMessage({ kind: "err", text: json.error?.message ?? `HTTP ${res.status}` });
      return;
    }
    setMessage({ kind: "ok", text: "版本已发布" });
    await load();
  };

  if (loading)
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50 text-sm text-slate-500">
        Loading versions…
      </div>
    );

  return (
    <div className="min-h-screen bg-slate-50 p-6">
      <header className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">版本发布</h1>
          <p className="mt-1 text-sm text-slate-500">
            发布四步：创建草稿 → 一致性检查（绑定 approved + id_column + 覆盖率≥50%）→ 提交快照 → 发布
          </p>
        </div>
        <div className="flex gap-3">
          <button
            type="button"
            onClick={() => setCreating((v) => !v)}
            className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
          >
            {creating ? "取消" : "新建版本"}
          </button>
          <a
            href="/ontology"
            className="rounded-md border border-slate-300 px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100"
          >
            返回本体
          </a>
        </div>
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

      {creating ? (
        <div className="mb-6 rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
          <label className="mb-3 block text-sm">
            <span className="mb-1 block font-medium text-slate-700">版本名称</span>
            <input
              className="w-80 rounded-md border border-slate-300 px-3 py-2"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例如 v1.0-spc-rca"
            />
          </label>
          <p className="mb-2 text-sm font-medium text-slate-700">选择实体（{selected.size} 项）</p>
          <div className="mb-4 grid grid-cols-3 gap-2">
            {entities.map((e) => (
              <label key={e.id} className="flex items-center gap-2 text-sm text-slate-700">
                <input type="checkbox" checked={selected.has(e.id)} onChange={() => toggle(e.id)} />
                {e.name}
                <BindingHint status={e.binding?.status ?? null} />
              </label>
            ))}
          </div>
          <button
            type="button"
            onClick={create}
            disabled={!name.trim() || selected.size === 0}
            className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-40"
          >
            创建草稿
          </button>
        </div>
      ) : null}

      <div className="rounded-lg border border-slate-200 bg-white shadow-sm">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-xs uppercase text-slate-500">
              <th className="px-3 py-2 font-medium">版本</th>
              <th className="px-3 py-2 font-medium">名称</th>
              <th className="px-3 py-2 font-medium">实体数</th>
              <th className="px-3 py-2 font-medium">状态</th>
              <th className="px-3 py-2 font-medium">操作</th>
            </tr>
          </thead>
          <tbody>
            {versions.map((v) => (
              <VersionRowView
                key={v.id}
                version={v}
                checks={checksByVersion[v.id]}
                onCheck={() => runCheck(v.id)}
                onSubmit={() => submit(v.id)}
                onPublish={() => publish(v.id)}
              />
            ))}
            {versions.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-3 py-6 text-center text-slate-400">
                  暂无版本，点击「新建版本」开始发布流程
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function VersionRowView({
  version: v,
  checks,
  onCheck,
  onSubmit,
  onPublish
}: {
  version: VersionRow;
  checks?: Check[];
  onCheck: () => void;
  onSubmit: () => void;
  onPublish: () => void;
}) {
  return (
    <>
      <tr className="border-b border-slate-100 hover:bg-slate-50">
        <td className="px-3 py-2 text-slate-700">v{v.version_number}</td>
        <td className="px-3 py-2 text-slate-700">
          {v.name}
          {v.description ? <span className="ml-2 text-xs text-slate-400">{v.description}</span> : null}
        </td>
        <td className="px-3 py-2 text-slate-500">{v.entity_count}</td>
        <td className="px-3 py-2">
          <StatusPill status={v.status} />
        </td>
        <td className="px-3 py-2">
          <div className="flex gap-2">
            {v.status === "draft" ? (
              <>
                <ActionLink label="检查" onClick={onCheck} />
                <ActionLink label="提交" onClick={onSubmit} />
              </>
            ) : null}
            {v.status === "submitted" ? <ActionLink label="发布" onClick={onPublish} /> : null}
            {v.status === "published" ? (
              <span className="text-xs text-slate-400">
                发布于 {v.published_at ? new Date(v.published_at).toLocaleString() : "—"}
              </span>
            ) : null}
          </div>
        </td>
      </tr>
      {checks ? (
        <tr className="border-b border-slate-100 bg-slate-50/60">
          <td colSpan={5} className="px-6 py-2">
            <ul className="text-xs">
              {checks.map((c) => (
                <li key={c.entity} className={c.ok ? "text-green-700" : "text-red-600"}>
                  {c.ok ? "✓" : "✗"} {c.entity}
                  {c.reason ? `：${c.reason}` : ""}
                </li>
              ))}
            </ul>
          </td>
        </tr>
      ) : null}
    </>
  );
}

function BindingHint({ status }: { status: string | null }) {
  if (status === "approved")
    return <span className="text-xs text-green-600">已审批</span>;
  if (status === "draft")
    return <span className="text-xs text-yellow-600">draft</span>;
  return <span className="text-xs text-red-500">无绑定</span>;
}

function ActionLink({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded border border-slate-300 px-2 py-1 text-xs font-medium text-slate-600 hover:bg-slate-100"
    >
      {label}
    </button>
  );
}

function StatusPill({ status }: { status: string }) {
  const styles: Record<string, string> = {
    approved: "bg-green-100 text-green-700",
    draft: "bg-yellow-100 text-yellow-700",
    submitted: "bg-orange-100 text-orange-700",
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
