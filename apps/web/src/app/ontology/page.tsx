"use client";

import { useEffect, useState } from "react";

type Binding = {
  entity: string;
  table: string;
  id_column: string;
  field_mappings: string;
  status: string;
};

type Relation = {
  name: string;
  from_entity: string;
  to_entity: string;
  cardinality: string;
  source_field: string;
  target_field: string;
};

type LogicFunction = {
  callable_name: string;
  description: string;
  input_schema: Array<{ name: string; type: string; required: boolean }>;
};

type OntologyContext = {
  bindings: Binding[];
  relations: Relation[];
  functions: LogicFunction[];
};

export default function OntologyPage() {
  const [context, setContext] = useState<OntologyContext | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/v1/ontology/context", { credentials: "same-origin" })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((d) => setContext(d.data ?? d))
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, []);

  if (loading)
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50 text-sm text-slate-500">
        Loading ontology…
      </div>
    );
  if (error)
    return (
      <div className="flex min-h-screen items-center justify-center bg-red-50 text-sm text-red-600">
        {error}
      </div>
    );
  if (!context)
    return (
      <div className="flex min-h-screen items-center justify-center text-sm text-slate-500">
        No data.
      </div>
    );

  return (
    <div className="min-h-screen bg-slate-50 p-6">
      <header className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">本体治理</h1>
          <p className="mt-1 text-sm text-slate-500">
            SPC RCA 本体 · {context.bindings.length} 绑定 ·{" "}
            {context.relations.length} 关系 · {context.functions.length} 函数
          </p>
        </div>
        <div className="flex gap-3">
          <a
            href="/ontology/versions"
            className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
          >
            版本发布
          </a>
          <a
            href="/data-tasks"
            className="rounded-md border border-slate-300 px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100"
          >
            返回工作台
          </a>
        </div>
      </header>

      <Section title="绑定（Entity → Datasource）">
        <Table
          headers={["实体", "数据表", "ID 列", "状态", "操作"]}
          rows={context.bindings.map((b) => [
            b.entity,
            b.table,
            b.id_column,
            <StatusPill key={b.entity} status={b.status} />,
            <a
              key={b.entity}
              href={`/ontology/bindings/${encodeURIComponent(b.entity)}`}
              className="text-blue-600 hover:underline"
            >
              编辑
            </a>,
          ])}
        />
      </Section>

      <Section title="关系">
        <Table
          headers={["名称", "起点", "终点", "基数", "源字段", "目标字段"]}
          rows={context.relations.map((r) => [
            r.name,
            r.from_entity,
            r.to_entity,
            r.cardinality,
            r.source_field,
            r.target_field,
          ])}
        />
      </Section>

      <Section title="逻辑函数">
        <Table
          headers={["函数名", "描述"]}
          rows={context.functions.map((f) => [f.callable_name, f.description])}
        />
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-6 rounded-lg border border-slate-200 bg-white shadow-sm">
      <h2 className="border-b border-slate-200 px-4 py-3 text-sm font-medium text-slate-700">
        {title}
      </h2>
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
