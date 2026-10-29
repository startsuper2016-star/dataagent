"use client";

import nextDynamic from "next/dynamic";

import { createTranslator } from "../../i18n/translate";

export const dynamic = "force-dynamic";

// The loading fallback renders before providers, so useT() is unavailable —
// use the default-locale translator directly (zh-CN).
const tWorkbench = createTranslator("zh-CN");

/**
 * Production entry: keep the route module tiny so the browser can paint a shell
 * before downloading the CopilotKit-heavy workbench chunk.
 */
const DataTasksApp = nextDynamic(() => import("./data-tasks-app"), {
  ssr: false,
  loading: () => (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 text-sm text-slate-500">
      {tWorkbench("workbench.loading")}
    </div>
  ),
});

export default function DataTasksPage() {
  return <DataTasksApp />;
}
