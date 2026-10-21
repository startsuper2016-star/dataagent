# deepagents_refactor_new 16 提交影响评估（Phase 0 Task 4）

- 评审日期：2026-10-21
- 评审对象：`datagallery-ai/dataagent` 分支 `deepagents_refactor_new` 相对 `main` 的全部 16 个提交
- 评审方法：
  1. `gh api repos/datagallery-ai/dataagent/compare/main...deepagents_refactor_new`（`per_page=100`，确认共 16 个提交，无分页缺失）；
  2. 逐提交 `gh api repos/.../commits/<sha>` 读取文件级 diff（merge 提交按 first-parent diff，与配对功能提交内容一致）；
  3. 以 `git/trees?recursive=1` 对 `main`、`deepagents_refactor_new`、merge-base `5cb0f044` 三方做全量 blob-SHA 树比对，交叉验证逐提交结论并识别与 main 的双向改动。
- 融合锚点（本评审判据）：
  - ① `packages/agent-runtime/src/semantic/*`（语义提供者链 / OntologySemanticProvider 挂载点）
  - ② `packages/agent-runtime/src/protocol/protocols/data-analysis.ts`（六阶段协议）
  - ③ `packages/data-gateway`（执行通道，`executeOntologySql` 委托目标）

## 一、16 提交影响评估表

结论列取值：`友好（不碰锚点）/ 相关（改锚点需跟进）/ 冲突（必须跟进）`。
锚点判定严格按路径：三列 `①/②/③` 打 ✓ 表示该提交的 diff 文件清单涉及该锚点路径。

| # | SHA | 标题 | 主要改动文件（+/-） | ① | ② | ③ | 结论 |
|---|-----|------|---------------------|---|---|---|------|
| 1 | 17c290ea | feat(agentkit): introduce plugin-driven agent runtime with TUI integration | 新增 `runtime/agentkit/**`（Python 运行时 ~150 文件，含 bootstrap/extensions/restapi/tests）；`apps/tui/src/**`（TUI v2：agui-client、v2-session-client、App 重构等）；`pyrightconfig.json`；`runtime/dataagent/dataagent/core/workspace/lock.py +6-4`、`pyproject.toml +1`、`tests/ut/workspace/test_workspace_lock.py +10-4` | ✗ | ✗ | ✗ | 友好（不碰锚点） |
| 2 | 2e145b8c | !449 merge feat/plugin-driven-agent-runtime | merge 提交，first-parent diff 与 17c290ea 完全一致 | ✗ | ✗ | ✗ | 友好（不碰锚点） |
| 3 | 55ab0c2d | 将重写 core 接进 agentkit | 新增 `runtime/agentkit/dataagent/core/**`（~60 文件：backends（filesystem/sandbox/composite/context_hub 等）、middleware、profiles、graph.py）；少量 `extensions/skills.py`、`tests/*` 调整 | ✗ | ✗ | ✗ | 友好（不碰锚点） |
| 4 | 8f18f048 | !460 merge cursor/deepagents-agentkit-core-1b9e | merge 提交，与 55ab0c2d 完全一致 | ✗ | ✗ | ✗ | 友好（不碰锚点） |
| 5 | f624ad38 | feat(agentkit): expose configured models to tools via native context | `runtime/agentkit/**`：新增 `client.py +56`、`models.py +67`、`examples/plugins/llm-utils/**`；`agent.py`、`bootstrap/*`、`restapi/*` 调整；`tests/test_tool_models.py +380` | ✗ | ✗ | ✗ | 友好（不碰锚点） |
| 6 | 79241d8f | !473 merge | merge 提交，与 f624ad38 完全一致 | ✗ | ✗ | ✗ | 友好（不碰锚点） |
| 7 | 03ccfa4d | feat(agentkit): add built-in semantic client and agent configuration | `runtime/agentkit/**`：新增 `dataagent/semantic_client/client.py +546`、`semantic_client/tls.py +22`、`errors.py +246`、`docs/semantic-client.md +110`；`agent.py +38-13`、`models.py`、`settings.py`、`restapi/app.py +132-55`；`tests/test_semantic_*.py`（+1035）。**注意：这是 Python 侧语义消费通道，不在锚点 ① 的 TS 路径内，见结论段** | ✗ | ✗ | ✗ | 友好（不碰锚点）※见备注 A |
| 8 | 7f2e2094 | !493 merge feat/agentkit-semantic-client | merge 提交，与 03ccfa4d 完全一致 | ✗ | ✗ | ✗ | 友好（不碰锚点）※见备注 A |
| 9 | 7f997944 | 为 deepagents_refactor_new 增加产品测试与出包入口 | 新增 `Makefile +72`、`scripts/run_product_tests.py +373`；`scripts/deploy/cli.mjs`、`config.mjs` 及测试；`runtime/agentkit/restapi/__main__.py +38-2`；`package.json +1` | ✗ | ✗ | ✗ | 友好（不碰锚点） |
| 10 | 0d101bd4 | !501 merge cursor/product-test-route-8342 | merge 提交，与 7f997944 完全一致 | ✗ | ✗ | ✗ | 友好（不碰锚点） |
| 11 | 87b6051a | docs(agentkit): consolidate product documentation and simplify TUI theming | `runtime/agentkit/docs/**` 重构为 architecture/extensions/guides/reference 目录（含 `extensions/semantic-service.md +80`）；`apps/tui` 主题精简（删除 `themes/*`、`THEMES.md`）；`README.md`/`README_zh.md` -10 | ✗ | ✗ | ✗ | 友好（不碰锚点） |
| 12 | b2be8f37 | !503 merge docs/agentkit-formal-docs | merge 提交，与 87b6051a 完全一致 | ✗ | ✗ | ✗ | 友好（不碰锚点） |
| 13 | e0d3c7ab | nl2sql | 新增 `runtime/agentkit/builtin-plugins/nl2sql/**`（~50 文件：perceptor/generator/selector/executor/validator/reflector 六节点 LangGraph 流水线、`security/semantic_resolver.py +98`、`security/rules.py +576`、`utils/sql_service.py +306`、prompts）；`dataagent/agent.py +26-4`、`declarations.py +45-5`、`extensions/{compiler,loading,subagents}.py`；`tests/test_nl2sql_plugin.py +266` | ✗ | ✗ | ✗ | 友好（不碰锚点）※见备注 B |
| 14 | 4b61bdd3 | !506 merge | merge 提交，与 e0d3c7ab 完全一致 | ✗ | ✗ | ✗ | 友好（不碰锚点）※见备注 B |
| 15 | 0ccee6db | feat(nl2sql): expose database context, persist results and narrow task contract | `runtime/agentkit/builtin-plugins/nl2sql/**`（subagents/nl2sql.py +115-11、config_manager、routing.md 等）；`apps/tui/src/**`（tool-result.ts +28、v2-session-client 等）；`dataagent/{agent,declarations}.py`、`extensions/{compiler,subagents}.py`；tests | ✗ | ✗ | ✗ | 友好（不碰锚点） |
| 16 | bf5b58dc | !515 merge perf/nl2sql-task-contract | merge 提交，与 0ccee6db 完全一致（分支头） | ✗ | ✗ | ✗ | 友好（不碰锚点） |

**汇总：16/16 提交均不触碰三个融合锚点路径；0 个"相关/冲突"。**

## 二、锚点完整性验证（blob-SHA 级证据）

对 `main` 与 `deepagents_refactor_new`（头 `bf5b58dc`）做全量递归树比对（main 1849 文件 / branch 2078 文件）：

| 锚点 | 分支上文件数 | main 与分支 blob-SHA 不同的文件数 |
|------|-------------|--------------------------------|
| ① `packages/agent-runtime/src/semantic/*` | 9 | **0**（`types.ts` = `1f1bc885`，`semantic-provider-chain.ts` = `5ec93ae4`，两侧一致） |
| ② `packages/agent-runtime/src/protocol/protocols/data-analysis.ts` | 1 | **0**（两侧 blob 均为 `7c5946f1`） |
| ③ `packages/data-gateway/**` | 16 | **0**（整棵子树逐文件 SHA 一致） |

分支相对 merge-base `5cb0f044` 的全部改动集中在：`apps/tui`（43）、`runtime/agentkit`（新增 248）、`Makefile`、`package.json`、`pyrightconfig.json`、`scripts/deploy/*`（4）、`scripts/run_product_tests.py`、两个 README、`docs/assets`，以及 `runtime/dataagent` 的 3 个文件（`core/workspace/lock.py`、`pyproject.toml`、`tests/ut/workspace/test_workspace_lock.py`）。`packages/**` 改动数：**0**。

## 三、结论段（三问）

**问 1：16 个提交合并后，SemanticProviderChain 接口是否会变（OntologySemanticProvider 是否需要按新接口写）？**
不会变。16 个提交无一触碰 `packages/agent-runtime/src/semantic/*`，且 `types.ts`、`semantic-provider-chain.ts` 及全部 9 个语义文件在两分支间 blob-SHA 完全一致；`packages/ontology` 的 `OntologySemanticProvider` 应按现网（main == 分支）接口实现，无需适配新接口。

**问 2：data-analysis 协议的阶段结构是否被改动（六阶段还是新阶段）？**
未被改动。`data-analysis.ts` 在两分支间 blob-SHA 相同（`7c5946f1`），六阶段协议原样保留；分支引入的 nl2sql 六节点流水线是 agentkit 内的独立插件实现，不修改该协议文件。

**问 3：data-gateway 的执行/校验路径是否被改动（影响 executeOntologySql 委托）？**
未被改动。`packages/data-gateway` 全部 16 个文件在两分支间逐文件 SHA 一致，`executeOntologySql` 的委托目标不受影响。

## 四、备注与风险（不影响上述结论，但融合需知晓）

- **备注 A（双语义通道）**：03ccfa4d/7f2e2094 在 agentkit（Python）新增 `SemanticServiceClient`（HTTP 客户端，`semantic_retrieve`、table/column 高级检索等方法，见 `docs/extensions/semantic-service.md`），经 `ModelContext.semantic_client` 注入工具。这是与 TS `SemanticProviderChain` 并行的第二条语义消费通道。融合时 `packages/ontology` 挂载 TS 链不受影响，但需在架构上说明本体与该 Python 客户端的关系（是否同源、是否复用 `services/datalink` 契约）。
- **备注 B（nl2sql 插件）**：e0d3c7ab/4b61bdd3 的 nl2sql 插件自带 `security/semantic_resolver.py`，在插件内部做语义解析，同样不改 TS 锚点；本体注入后应评估该解析器是否切到本体查询。
- **合并冲突风险（非锚点）**：upstream `main` 在 merge-base 之后已前进，`runtime/dataagent` 有大量 main 侧新改动（77 改/48 删/12 增，分支为旧版）；其中 3 个文件双方都改过——`dataagent/core/workspace/lock.py`、`pyproject.toml`、`tests/ut/workspace/test_workspace_lock.py`——把 `deepagents_refactor_new` 合回 main 时需手工解冲突并回归 workspace lock 行为。
- 本评审未执行合并动作，仅做影响评估；锚点接口的运行时验证属 Phase 0 DTC/后续任务范围。
