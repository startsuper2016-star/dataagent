# Phase 0 / Task 5：8/17 快照 vs main 三锚点差异清单

- 日期：2026-10-21
- 快照侧（参照）：`D:/优秀项目/本体项目/dataagent-datafoundry/dataagent-datafoundry`（datafoundry 分支 8/17 冻结版的本地解压副本，目录内无 `.git`）
- main 侧（融合基线）：`datagallery-ai/dataagent` @ `main`（活跃主线）
- 比对范围：三个锚点目录 + `semantic/types.ts` 逐字段

## 结论（先行）

**语义提供者接口：快照与 main 完全兼容（字节级一致，零差异）。**

- 三个锚点目录下共 **56 个文件**，路径集合与 git blob SHA **全部一致**（56/56），即双边字节级相同，无新增、无删除、无改名文件。
- `semantic/types.ts` **零差异**：双边 blob SHA 均为 `1f1bc885460c1e0810c0a4318b584ad2a2212b6c`（git blob SHA 由内容唯一决定，SHA 相等即字节相等）。
- 因此 **OntologySemanticProvider 按快照签名实现与按 main 签名实现是同一件事**，不存在"按哪边"的分歧点。

## Step 1：三锚点目录文件清单比对

### 1.1 文件名清单（双边一致，无增删改名）

`packages/agent-runtime/src/semantic/`（9 个文件，双边一致）：

| 文件 | main blob SHA | 快照 blob SHA | 状态 |
|---|---|---|---|
| datalink-semantic-provider.test.ts | `57a7d0aa…981b54` | 同左 | 一致 |
| datalink-semantic-provider.ts | `8d92f858…0aa67` | 同左 | 一致 |
| default-semantic-provider.test.ts | `253a6e4e…0c3191` | 同左 | 一致 |
| default-semantic-provider.ts | `47bc7b23…ca232c` | 同左 | 一致 |
| local-semantic-provider.test.ts | `f9438364…798c` | 同左 | 一致 |
| local-semantic-provider.ts | `a12b7cd8…a74a3` | 同左 | 一致 |
| semantic-provider-chain.test.ts | `69c4ac6f…44d5` | 同左 | 一致 |
| semantic-provider-chain.ts | `5ec93ae4…d70a7` | 同左 | 一致 |
| types.ts | `1f1bc885…12b6c` | 同左 | 一致 |

`packages/agent-runtime/src/protocol/protocols/`（3 个文件，双边一致）：

| 文件 | main blob SHA | 快照 blob SHA | 状态 |
|---|---|---|---|
| data-analysis.ts | `7c5946f1…215a8a` | 同左 | 一致 |
| formal-protocols.test.ts | `4bcbda85…13d82` | 同左 | 一致 |
| general-task.ts | `5a301f43…36a79` | 同左 | 一致 |

`services/datalink/src/datalink/`（44 个文件，双边一致）：

| 子目录 | 文件（全部一致） |
|---|---|
| 根 | `__init__.py`、`config.py` |
| api/ | `__init__.py`、`deps.py`、`server.py` |
| builder/ | `__init__.py`、`pipeline.py` |
| cli/ | `__init__.py`、`main.py` |
| connector/ | `__init__.py`、`base.py`、`database.py`、`file.py` |
| extractor/ | `__init__.py`、`tabular.py` |
| graph/ | `__init__.py`、`retrieval.py`、`schema.sql`、`storage.py` |
| inferrer/ | `__init__.py`、`correlated.py`、`distribution.py`、`joinable.py`、`synonym.py` |
| mapper/ | `__init__.py`、`llm_mapper.py` |
| mapper/prompts/ | `__init__.py`、`mapping_prompt.txt`、`merge_prompt.txt`、`table_comment_prompt.txt` |
| mcp/ | `__init__.py`、`server.py` |
| models/ | `__init__.py`、`datasource.py`、`edge.py`、`node.py`、`profile.py` |
| profiler/ | `__init__.py`、`tabular.py` |
| utils/ | `__init__.py`、`credential.py`、`embedding.py`、`ids.py`、`sql_ident.py` |

### 1.2 全量 blob 级验证

不只比文件名，而是对 56 个文件逐一比对「路径 + git blob SHA」：

- main 侧：`gh api repos/datagallery-ai/dataagent/git/trees/main?recursive=1` 过滤三个前缀，得 56 条 `path sha`。
- 快照侧：`git hash-object` 对本地 56 个文件计算等价 blob SHA（快照无 `.git`，此法给出与 git 索引一致的 SHA）。
- `diff` 两份清单：**完全相同，0 差异**。新增 0、删除 0、改名 0。

## Step 2：semantic/types.ts 字段级记录

双边逐字节 `diff` 输出为空 → **零差异**，并用 blob SHA 双边一致再次确认。

main 与快照一致的接口全文（即 OntologySemanticProvider 依赖的唯一定义，双边唯一签名）：

```ts
export type SemanticTrust = "authoritative" | "verified" | "inferred" | "unknown";

export type SemanticRequest = {
  userId: string;
  workspaceId: string;
  datasourceId: string;
  datasourceRevision: string;
  query: string;
  physicalSchema?: unknown;   // 可选
};

export type SemanticProviderResult = {
  value: unknown;
  capabilities: string[];
  trust: SemanticTrust;
  warnings: string[];
  snapshotId?: string;        // 可选
};

export interface SemanticProvider {
  id: "datalink" | "local";
  resolve(request: SemanticRequest): Promise<SemanticProviderResult>;
}

export type SemanticResolution = SemanticProviderResult & {
  provider: "datalink" | "local" | "none";
  mode: "live" | "cached" | "fallback" | "unavailable";
  datasourceRevision: string;
  fallbackReason?: string;
};

export class SemanticProviderError extends Error {
  constructor(
    readonly code: string,
    readonly fallbackAllowed: boolean,
    options?: ErrorOptions
  ) { super(code, options); this.name = "SemanticProviderError"; }
}
```

字段级差异明细：**无**。`SemanticRequest` 6 个字段、`SemanticProviderResult` 5 个字段（含 2 个可选）、`SemanticProvider` 接口、`SemanticResolution` 交叉类型、`SemanticProviderError` 构造签名在双边逐一相同。

## 复现方法

```bash
# 目录清单
gh api "repos/datagallery-ai/dataagent/contents/packages/agent-runtime/src/semantic?sha=main" --jq '.[].name'
gh api "repos/datagallery-ai/dataagent/contents/packages/agent-runtime/src/protocol/protocols?sha=main" --jq '.[].name'
gh api "repos/datagallery-ai/dataagent/contents/services/datalink/src/datalink?sha=main" --jq '.[].name'

# types.ts 逐字节 diff
gh api "repos/datagallery-ai/dataagent/contents/packages/agent-runtime/src/semantic/types.ts?sha=main" \
  -H "Accept: application/vnd.github.raw" > /tmp/semantic-types-main.ts
diff /tmp/semantic-types-main.ts "$SNAPSHOT/packages/agent-runtime/src/semantic/types.ts"

# blob 级全量验证（快照无 .git 时用 git hash-object 等价计算）
git hash-object <本地文件...>
gh api "repos/datagallery-ai/dataagent/git/trees/main?recursive=1" --jq '...'
```

## 备注 / 边界

1. 快照目录内无 `.git`，无法从 git 元数据直接证实"8/17 冻结"的日期；本清单以**内容**为判定依据（blob SHA），日期属性不影响本结论。
2. 本任务仅比对三个锚点目录；快照与其余 main 路径（如 `apps/`、`packages/` 其它模块）是否一致不在本清单范围内，融合时如需引用其它模块仍需单独核验。
3. 与 Task 4 结论（main 与 deepagents_refactor_new 之间三锚点 blob 一致）合并看：**main、快照、deepagents_refactor_new 三方在三锚点接口面上互为一致**，语义提供者接口不存在任何版本分歧。
