# Phase 0 / Task 5 执行报告：8/17 快照 vs main 差异清单

- 日期：2026-10-21
- 状态：DONE
- Commit：`18320ab`（`phase0: snapshot-vs-main diff inventory`，已推送 origin/main）
- 产出：`docs/fusion/snapshot-vs-main-diff.md`

## 执行内容

### Step 1：三锚点目录清单比对

用 `gh api contents?sha=main` 列 main 侧目录，`ls` 列快照侧（`D:/优秀项目/本体项目/dataagent-datafoundry/dataagent-datafoundry`），三方目录为：

1. `packages/agent-runtime/src/semantic` — 9 文件
2. `packages/agent-runtime/src/protocol/protocols` — 3 文件
3. `services/datalink/src/datalink` — 44 文件（递归含子目录）

文件名清单双边完全一致：**新增 0、删除 0、改名 0**。

进一步做 blob 级验证（不只文件名）：main 侧用 `git/trees/main?recursive=1` 过滤三个前缀取 56 条 `path + blob SHA`；快照侧目录无 `.git`，改用 `git hash-object` 对本地 56 个文件计算等价 blob SHA。两份清单 `diff` 结果：**56/56 全部一致（字节级相同）**。

### Step 2：semantic/types.ts 逐字段 diff

`diff /tmp/semantic-types-main.ts <快照>/packages/agent-runtime/src/semantic/types.ts` 输出为空 → **零差异**；并用 blob SHA 双边一致（均为 `1f1bc885460c1e0810c0a4318b584ad2a2212b6c`）二次确认（git blob SHA 由内容唯一决定，SHA 相等即字节相等）。

`SemanticRequest`（6 字段，含可选 `physicalSchema`）、`SemanticProviderResult`（5 字段，含可选 `snapshotId`）、`SemanticProvider`、`SemanticResolution`、`SemanticProviderError`、`SemanticTrust` 定义在双边逐一相同。

## 核心结论

**语义提供者接口兼容性：兼容（字节级一致，零差异）。** OntologySemanticProvider 按 main 签名实现与按快照签名实现是同一件事；结合 Task 4 结论（main 与 deepagents_refactor_new 三锚点 blob 一致），main、快照、deepagents_refactor_new 三方在语义接口面上互为一致。

## 疑虑（低风险备注）

1. 快照目录无 `.git`，无法从 git 元数据证实"8/17 冻结"日期；结论以内容（blob SHA）为依据，不受日期属性影响。
2. 本任务仅核验三个锚点目录；快照与其余 main 路径（`apps/`、其它 `packages/` 模块）是否一致不在范围内，融合涉及其它模块时需单独核验。
