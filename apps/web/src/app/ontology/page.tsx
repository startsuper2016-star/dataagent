"use client";

import { useRouter } from "next/navigation";

import { OntologyPanel } from "../data-tasks/components/ontology/OntologyPanel";

/** 独立路由形态：全屏渲染本体构建面板；返回即回工作台。 */
export default function OntologyWorkbenchPage() {
  const router = useRouter();
  return (
    <div className="h-screen overflow-hidden">
      <OntologyPanel onBack={() => router.replace("/data-tasks")} />
    </div>
  );
}
