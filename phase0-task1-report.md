# Phase 0 Task 1 执行报告：Fork、锁基线、修 CI 门控、许可证署名

日期：2026-10-21
仓库：`startsuper2016-star/dataagent`（fork of `datagallery-ai/dataagent`，Apache-2.0）
本地：`C:\Users\shuan\Documents\GitHub\datafoundry`，分支 `main`
**BASE_COMMIT = `4f7c81dd830706b67bd24ac73642d6ca6740747a`**（上游 main @ `4f7c81d !516 merge dev_ir_updates_1020 into main`）

## Step 1: Fork 并克隆

```
gh repo fork datagallery-ai/dataagent --clone=false
→ https://github.com/startsuper2016-star/dataagent
git clone git@github.com:startsuper2016-star/dataagent.git "C:/Users/shuan/Documents/GitHub/datafoundry"
→ 克隆成功（SSH，875 files）
```

- 上游分支确认：`main` 存在（上游默认分支为 `datafoundry`，已冻结，未使用）。
- **问题 1（已解决）：`git checkout main` 因 Git LFS 失败**。Fork 不继承上游 LFS 对象，`docs/assets/readme/gui-demo.gif`（object fb27dba…）在 LFS 存储端 404，smudge filter 失败导致 checkout 中止并留下混合工作树。
- 解决：`export GIT_LFS_SKIP_SMUDGE=1` + `git reset --hard` + `git checkout -f main`。媒体资产（gif/mp4/sqlite）以 LFS pointer 文件形式存在，对融合无影响。结果：`Switched to branch 'main'`，HEAD=`4f7c81d…`，工作树干净（status 0 条）。

## Step 2: 锁定并记录基线 commit

```
BASE_COMMIT=4f7c81dd830706b67bd24ac73642d6ca6740747a
fork_base: 4f7c81dd830706b67bd24ac73642d6ca6740747a (main @ 2026-10-21)
git commit -m "phase0: record fusion base commit" → ed16114
```

- 按接口要求在 FUSION_BASE.md 首行写入 `BASE_COMMIT=<40位sha>`（Step 命令只输出裸 sha，已补充接口要求的 `BASE_COMMIT=` 前缀形式），第二行为 `fork_base:` 行。

## Step 3: 修 CI 门控

`grep` 定位：6 处 `if: github.repository == 'datagallery-lab/datafoundry'`（ci.yml 行 24/57/124/156，docs.yml 行 20/49）。

```
sed -i "s|github.repository == 'datagallery-lab/datafoundry'|github.repository == 'startsuper2016-star/dataagent'|g" .github/workflows/ci.yml .github/workflows/docs.yml
→ 6/6 处替换成功；grep "datagallery-lab" .github/workflows/ 无残留（exit=1）
git diff --stat: ci.yml 4 处、docs.yml 2 处
git commit -m "phase0: repoint CI repository gates to fork" → 9128391
```

## Step 4: .nvmrc 与 README 署名

```
echo "22" > .nvmrc        → 内容为 "22"
sed -i '1i > Fork of [datagallery-ai/dataagent](...) (Apache-2.0) — fused with Yuanshu ontology platform. Base commit see FUSION_BASE.md.' README.md
→ sed 原生成功，无需等价方案；README 第一行已确认为署名行
git commit -m "phase0: pin node 22, attribute upstream" → 466ccfb
```

## Step 5: 推送并验证 CI 触发

```
git push origin main → 4f7c81d..466ccfb main -> main
```

**问题 2（已解决）：push 后 `gh run list` 为空，Actions 未注册工作流。**
- 原因链：(a) fork 的默认分支继承上游为 `datafoundry`，GitHub 从默认分支注册 workflows，`main` 上的新 workflow 文件未被发现（`workflow run` 报 404 "not found on the default branch"）；(b) fork 默认不启用 Actions。
- 处置：`gh api -X PATCH repos/... -f default_branch=main`（fork 默认分支改为 `main`，与融合主线一致）；`PUT actions/permissions enabled=true`；追加空提交 `phase0: trigger workflow registration scan`（**a608660**，任务计划外的操作提交）触发注册扫描。
- 结果：两个 workflow 注册且 `active`。`gh workflow run` 手动 dispatch 成功（run 39612294183 CI、39612304259 Docs）；该 push（a608660）本身也随后触发了 push 事件的 CI（run 39612570780）与 Docs（run 39612570658）。

### CI 结果

| Run | 触发 | 结果 |
|---|---|---|
| CI 39612570780 | push (a608660) | **全部 4 job 通过**：Core Smoke Tests ✓、Build and Web Tests ✓、Docs ✓、Native Deploy Smoke ✓ |
| CI 39612294183 | workflow_dispatch | cancelled——与上述 push run 命中同一 concurrency group（`ci-CI-refs/heads/main`，cancel-in-progress）被取消 |
| Deploy Docs 39612570658/39612304259 | push/dispatch | failure @ "Configure Pages"：`Create Pages site failed. Error: Resource not accessible by integration`——fork 未开启 GitHub Pages，GITHUB_TOKEN 无权创建 Pages site。属任务允许记录的 runner/secret 类环境失败，未修（不要求修绿）。修复路径：Settings→Pages 开启后自动恢复。 |

CI run 列表（gh run list --limit）：https://github.com/startsuper2016-star/dataagent/actions/runs/39612570780 （CI 全绿）

## 自检结论

- FUSION_BASE.md 含 40 位 sha：✓ `4f7c81dd830706b67bd24ac73642d6ca6740747a`
- workflows 无 `datagallery-lab` 残留：✓（grep 0 命中）
- `.nvmrc` = `22`：✓
- README 首行为署名行：✓
- CI 因 repository 门控跳过 → 不再跳过，实际运行且 CI 主工作流全绿：✓
- 工作树干净，已推送 origin/main 至 a608660

## Commit 列表（origin/main）

1. `ed16114` phase0: record fusion base commit
2. `9128391` phase0: repoint CI repository gates to fork
3. `466ccfb` phase0: pin node 22, attribute upstream
4. `a608660` phase0: trigger workflow registration scan（操作提交：空提交，用于 fork Actions 注册扫描，无内容变更）

## 与计划的偏差（均已按结果符合 Expected 处理）

1. LFS skip-smudge（fork 不含 LFS 对象，二进制媒体以 pointer 落地）。
2. FUSION_BASE.md 增加 `BASE_COMMIT=` 前缀行（满足接口约定）。
3. fork 默认分支 `datafoundry`→`main`、显式启用 Actions、追加空提交 a608660——均为让 CI 真正触发的必要操作。
4. Deploy Docs 因 Pages 未开启而失败——按任务要求记录原因，未修复。
