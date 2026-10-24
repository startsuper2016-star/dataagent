# Phase 0 Task 4 报告：deepagents_refactor_new 16 提交评审

- 状态：DONE_WITH_CONCERNS
- 提交：`cbef5ec`（`phase0: deepagents refactor impact assessment`，已推送 origin/main）
- 产物：
  - `docs/fusion/deepagents-16-commits.txt`（16 提交清单，compare API `per_page=100` 确认无缺页）
  - `docs/fusion/deepagents-impact-assessment.md`（16 行影响评估表 + 锚点 SHA 验证 + 三问结论段）

## 做了什么

1. compare API 拉取 `main...deepagents_refactor_new` 全部 16 提交（8 个功能提交 + 8 个 merge 提交，merge 与配对功能提交 first-parent diff 完全一致）。
2. 逐提交调 `commits/<sha>` 取文件级 diff（+/-），对三锚点逐路径判定。
3. 用 `git/trees?recursive=1` 对 main / 分支头 / merge-base `5cb0f044` 做全量 blob-SHA 三方树比对交叉验证：
   - 锚点 ①（semantic/*，9 文件）、②（data-analysis.ts，blob `7c5946f1`）、③（data-gateway，16 文件）在两分支间**逐文件 SHA 完全一致**，分支 diff 中 `packages/**` 改动数为 0。
   - 16 提交（相对 merge-base）实际只改：`apps/tui`（43）、新增 `runtime/agentkit`（248 文件）、Makefile/package.json/pyrightconfig、`scripts/deploy`、`scripts/run_product_tests.py`、README、及 `runtime/dataagent` 3 个文件（workspace lock 相关小修）。
4. 评估表 16/16 结论均为 `友好（不碰锚点）`，0 个相关/冲突。

## 三问结论

1. SemanticProviderChain 接口**不会变**——两分支 semantic 目录 9 个文件 SHA 全同，OntologySemanticProvider 按现网接口写即可。
2. data-analysis 协议**未被改动**——`data-analysis.ts` 两分支 blob 同为 `7c5946f1`，六阶段结构原样；分支的 nl2sql 六节点是 agentkit 独立插件，不碰该文件。
3. data-gateway 执行/校验路径**未被改动**——整包 16 文件 SHA 一致，`executeOntologySql` 委托目标不受影响。

## 疑虑（DONE_WITH_CONCERNS 原因）

1. **双语义通道**：03ccfa4d 在 agentkit（Python）新增 `SemanticServiceClient`（HTTP 语义客户端，经 `ModelContext.semantic_client` 注入工具，指向 `services/datalink` 契约），与 TS SemanticProviderChain 并存。不碰锚点、不影响接口结论，但融合架构需说明本体与该 Python 客户端的关系（同源/复用契约或各自独立）。
2. **合并冲突风险（非锚点）**：upstream main 已越过 merge-base 前进，`runtime/dataagent` 有 main 侧大量新改动（77 改/48 删/12 增，分支侧为旧版）；其中 3 个文件**双方都改过**（`core/workspace/lock.py`、`pyproject.toml`、`tests/ut/workspace/test_workspace_lock.py`），后续把 deepagents_refactor_new 合回 main 时需手工解冲突并回归 workspace lock。
3. nl2sql 插件自带 `security/semantic_resolver.py` 做插件内语义解析，本体注入后建议评估是否切换到本体查询（记录在评估文档备注 B）。
