import {
  SemanticProviderError,
  type SemanticProvider,
  type SemanticProviderResult,
  type SemanticRequest
} from "./types.js";

/**
 * 本体语义源的最小客户端契约：给定数据源 id，返回该数据源已发布（approved 绑定）的本体
 * 业务上下文（实体/绑定/关系/函数），或 null 表示该数据源没有本体建模（正常场景，非错误）。
 * apps/api 侧实现直接读 workbench 库的 ont_* 表；agent-runtime 不依赖 sqlite。
 */
export type OntologyContextClient = {
  loadContext(datasourceId: string): Promise<unknown | null>;
};

/**
 * P3-1 — 治理审批过的本体语义层（trust=verified），优先于 DataLink 的推断语义。
 *
 * 链上语义：数据源没有本体建模（loadContext 返回 null）抛 fallbackAllowed 错误，
 * chain 落回 datalink → local；有本体建模则直接命中，不再向下。
 */
export class OntologySemanticProvider implements SemanticProvider {
  readonly id = "ontology" as const;

  constructor(private readonly client: OntologyContextClient) {}

  async resolve(request: SemanticRequest): Promise<SemanticProviderResult> {
    let value: unknown;
    try {
      value = await this.client.loadContext(request.datasourceId);
    } catch (error) {
      throw new SemanticProviderError("ONTOLOGY_CONTEXT_UNAVAILABLE", true, { cause: error });
    }
    if (value === null || value === undefined) {
      throw new SemanticProviderError("ONTOLOGY_NOT_CONFIGURED", true);
    }
    return {
      value,
      capabilities: ["ontology-context", "ontology-query", "ontology-sql", "ontology-traverse"],
      trust: "verified",
      warnings: []
    };
  }
}
