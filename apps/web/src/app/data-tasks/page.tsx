"use client";

import nextDynamic from "next/dynamic";

export const dynamic = "force-dynamic";

/**
 * Production entry: keep the route module tiny so the browser can paint a shell
 * before downloading the CopilotKit-heavy workbench chunk.
 */
const DataTasksApp = nextDynamic(() => import("./data-tasks-app"), {
  ssr: false,
  loading: () => (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 text-sm text-slate-500">
      工作台加载中…
    </div>
  ),
});

export default function DataTasksPage() {
  return <DataTasksApp />;
}
