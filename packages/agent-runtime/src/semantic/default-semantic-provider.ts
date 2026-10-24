import { DataLinkSemanticProvider } from "./datalink-semantic-provider.js";
import { LocalSemanticProvider } from "./local-semantic-provider.js";
import { OntologySemanticProvider, type OntologyContextClient } from "./ontology-semantic-provider.js";
import { SemanticProviderChain } from "./semantic-provider-chain.js";

type SemanticTool = {
  execute?: (...args: unknown[]) => unknown | Promise<unknown>;
};

/** Build the production semantic chain from the run's policy-selected capabilities. */
export const createDefaultSemanticProvider = (input: {
  tools: Record<string, SemanticTool>;
  /** apps/api 注入的本体上下文客户端；缺省时链条不含 ontology 层。 */
  ontologyContext?: OntologyContextClient;
}): SemanticProviderChain => {
  const live = new DataLinkSemanticProvider({
    callTool: async (name, args) => {
      const execute = input.tools[name]?.execute;
      if (!execute) {
        throw new Error(`MCP_TOOL_UNAVAILABLE:${name}`);
      }
      return execute(args);
    }
  });
  const local = new LocalSemanticProvider({
    inspectSchema: async (request) => request.physicalSchema
  });
  return new SemanticProviderChain({
    ...(input.ontologyContext ? { ontology: new OntologySemanticProvider(input.ontologyContext) } : {}),
    live,
    local
  });
};

export { OntologySemanticProvider, type OntologyContextClient } from "./ontology-semantic-provider.js";
