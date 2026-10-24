import { describe, expect, it } from "vitest";

import { OntologySemanticProvider } from "./ontology-semantic-provider.js";
import { SemanticProviderChain } from "./semantic-provider-chain.js";
import {
  SemanticProviderError,
  type SemanticProvider,
  type SemanticRequest
} from "./types.js";

const request: SemanticRequest = {
  userId: "user-1",
  workspaceId: "workspace-1",
  datasourceId: "datasource-1",
  datasourceRevision: "schema-v1",
  query: "PVD 机台异常归因"
};

const context = {
  bindings: [{ entity: "AnomWafer", table: "v_anom_wafer", id_column: "id" }],
  relations: [],
  functions: [{ callable_name: "spc_welch_test", description: "Welch t" }]
};

const datalink: SemanticProvider = {
  id: "datalink",
  resolve: async () => ({
    value: { nodes: ["inferred"] },
    capabilities: ["graph-explore"],
    trust: "inferred",
    warnings: []
  })
};

const local: SemanticProvider = {
  id: "local",
  resolve: async () => ({
    value: { tables: ["orders"] },
    capabilities: ["physical-schema"],
    trust: "verified",
    warnings: []
  })
};

describe("OntologySemanticProvider", () => {
  it("returns the governance context with verified trust", async () => {
    const provider = new OntologySemanticProvider({ loadContext: async () => context });

    const result = await provider.resolve(request);

    expect(result).toMatchObject({
      value: context,
      trust: "verified",
      warnings: []
    });
    expect(result.capabilities).toContain("ontology-query");
  });

  it("throws a fallback-allowed error when the datasource has no ontology", async () => {
    const provider = new OntologySemanticProvider({ loadContext: async () => null });

    await expect(provider.resolve(request)).rejects.toMatchObject({
      code: "ONTOLOGY_NOT_CONFIGURED",
      fallbackAllowed: true
    });
  });

  it("throws a fallback-allowed error when the context source fails", async () => {
    const provider = new OntologySemanticProvider({
      loadContext: async () => {
        throw new Error("db locked");
      }
    });

    await expect(provider.resolve(request)).rejects.toMatchObject({
      code: "ONTOLOGY_CONTEXT_UNAVAILABLE",
      fallbackAllowed: true
    });
  });
});

describe("SemanticProviderChain with ontology layer", () => {
  it("short-circuits on the ontology provider when configured", async () => {
    let datalinkCalls = 0;
    const chain = new SemanticProviderChain({
      ontology: new OntologySemanticProvider({ loadContext: async () => context }),
      live: {
        id: "datalink",
        resolve: async () => {
          datalinkCalls += 1;
          return datalink.resolve(request);
        }
      },
      local
    });

    const result = await chain.resolve(request);

    expect(result).toMatchObject({ provider: "ontology", mode: "live", trust: "verified" });
    expect(datalinkCalls).toBe(0);
  });

  it("falls back to datalink with a reason when the datasource has no ontology", async () => {
    const chain = new SemanticProviderChain({
      ontology: new OntologySemanticProvider({ loadContext: async () => null }),
      live: datalink,
      local
    });

    const result = await chain.resolve(request);

    expect(result).toMatchObject({
      provider: "datalink",
      mode: "live",
      fallbackReason: "ONTOLOGY_NOT_CONFIGURED"
    });
  });

  it("keeps datalink failure semantics after the ontology layer is skipped", async () => {
    const chain = new SemanticProviderChain({
      ontology: new OntologySemanticProvider({ loadContext: async () => null }),
      live: {
        id: "datalink",
        resolve: async () => {
          throw new SemanticProviderError("DATALINK_TIMEOUT", true);
        }
      },
      local,
      now: () => 5000
    });

    const result = await chain.resolve(request);

    expect(result).toMatchObject({ provider: "local", mode: "fallback" });
    expect(result.fallbackReason).toBe("DATALINK_TIMEOUT");
  });

  it("behaves as before when no ontology provider is supplied", async () => {
    const chain = new SemanticProviderChain({ live: datalink, local });

    const result = await chain.resolve(request);

    expect(result).toMatchObject({ provider: "datalink", mode: "live" });
  });
});
