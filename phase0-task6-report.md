# Phase 0 · Task 6 执行报告：Spike — 网关参数通道选型（D2 定案依据）

- 日期：2026-10-21
- 状态：**DONE**
- Commit：`6604d13e88735651a63886d4d29c37fa071cdbdb`（`phase0: params channel decision (inline literal)`，已推送 `origin/main`：`18320ab..6604d13`）
- 产物：`docs/fusion/spike-params-channel.md`；临时测试代码（不入库）位于 `%TEMP%/spike-params/`（`inline.mjs` + `matrix.mjs`）

## D2 结论

**默认选「字面量内联」（inline literal）**，仅限 `packages/ontology` 对象名重写路径，值全部来自校验后的 filter DSL 参数、键名来自 `p0..pN` 白名单生成器；安全声明仅覆盖 SQLite 方言（Phase 1 全部数据源 = 本地 SQLite）。**gateway 扩 params 列为 Phase 3 加固项**。

## 注入测试矩阵结果

40 用例 × 2 实现对照，每用例在全新 `node:sqlite` 内存库执行并断言表完整性：

- **naive 版**（brief 给定的逐键顺序替换）：**38/40** —— 发现 **1 类缺陷（跨键级联）**，2 用例（B3/B4）复现：值内含 `:pN` token 时，后续键的重扫会把字面量塞进已生成的字符串，整句重新词法化（B4 中 `' OR '1'='1` 载荷一度重组进活代码 `OR` 区，最终因引号失衡以语法错误 fail-closed）。未构成注入逃逸，但属正确性缺陷+高危边界。
- **single-pass 加固版**（单个 alternation 正则单遍替换，键按长度降序、元字符转义）：**40/40 全过**，并消除键插入顺序敏感性。

关键实证：`:p1\b` 在 `:p10`/`:p1_0` 上不匹配（`0`/`_` 为词字符），100 键全量扫描无蚕食；同键自引用安全（replace 单遍不重扫）；经典载荷（DROP/DELETE/UNION/OR 恒真/注释截断/双引号）全部字面量化，0 行命中且表完整；`%`/`_` 在 `=` 下为字面字符；null/number（0、负数、`1e+21`、MAX_SAFE_INTEGER）/boolean/Date/空串分支语义正确；`NaN`/`Infinity` 走 `String()` 兜底（文档已注明校验层须拦截）；非白名单键名实证为「抛错或打碎语句」→ 白名单是安全前提。

## 方案对比（gateway 扩 params 改动面）

- `AdapterSqlInput|RunSqlReadonlyInput` 非测试引用：**39 处 / 10 个文件**（`types.ts`、`index.ts` + 全部 8 个适配器）
- `local-sql-adapters.ts` 中 `prepare(` 调用点：**4**
- 结论：横切契约改动，且各引擎命名参数方言不一（多数仅 `?`/`$1`），Phase 0/1 不实施。

## 偏离 brief 的说明

1. **实现修订**：brief 的 naive 顺序替换实现被实测证伪（级联缺陷），文档定版为单遍替换实现并附代码。这是 spike 的核心产出，非偏离目的。
2. brief Step 2 脚本的 `INJECTED:` 日志语义有误导（`db.exec` 对合法 SELECT 不抛错即打印该词）；已用 `sqlite_master` 探测 + 矩阵 G1 用例（断言表存在与 0 行）替代验证，DROP 确未生效。
3. 矩阵执行首轮暴露 4 处 harness 断言错误（A1/A2 误把「正确替换」判为蚕食、D7 全局完整性检查与用例自身 INSERT 冲突、F1 期望串写错），已修正后复跑得出上述最终数字。

## 疑虑 / 后续

- D2 结论仅声明 SQLite 方言安全；MySQL 反斜杠转义差异已写入文档「限制」节，作为 Phase 3 扩 params 的首要理由。
- `node:sqlite` 在 Node 22 为实验特性（有 ExperimentalWarning），结论针对内联算法本身，不受影响。
- 若 Phase 1 需要生成 LIKE 条件，必须叠加 `ESCAPE`（当前对象名重写路径不使用 LIKE）。
