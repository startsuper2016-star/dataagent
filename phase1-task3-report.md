# Phase 1 — Task 3 报告：参数内联（spike 附录 C 单遍替换版 + 键名断言）

- 状态：完成
- Commit：`a5a1716` — `phase1: inline params (single-pass, key contract, spike appendix C)`（未 push，控制器统一推送）
- 测试：`npx vitest run packages/ontology` → **30 passed (30)**（schema 3 + dsl 17 + inline 10），inline-params.ts 独立 `tsc --noEmit`（strict + noUncheckedIndexedAccess + exactOptionalPropertyTypes）零错误

## 交付物

| 文件 | 变更 |
| --- | --- |
| `packages/ontology/src/inline-params.ts` | 新建：`inlineParams(sql, params): string`（任务规格逐字照抄——单遍 replace 回调是安全核心） |
| `packages/ontology/src/inline-params.test.ts` | 新建：10 用例（字面量内联、DROP 注入端到端、键名契约、子参数、无级联、无 `$` 模式、相邻参数、null/布尔、非有限数、p1/p10 边界） |
| `packages/ontology/src/index.ts` | 追加 `export * from "./inline-params.js";` |

## 安全契约落地核对（Task 6 spike 评审定案）

| 契约 | 落地 | 证据 |
| --- | --- | --- |
| 单遍替换（替换产物不再被扫描） | 一次 `sql.replace(re, callback)` 完成全部替换；回调返回值不参与再次匹配 | "no cascade" 用例：值 `:p1' OR '1'='1` 仅转义为 `':p1'' OR ''1''=''1'`，不二次展开 |
| 键名必须匹配 `^p\d+(_\d+)?$` | 实现入口先断言全部键，非法键抛 `参数键名不合法: <key>（必须为 p<N>[_<M>]）`（消息格式固定，后续任务可匹配） | "rejects keys" 用例覆盖 `evil`、`x0` |
| SQLite-only 转义 | 值中 `'` 翻倍为 `''`（`replace(/'/g, "''")`） | "escapes single quotes" 用例：内存库端到端，DROP payload 按字面量匹配、表未被删、`sqlite_master` 表计数仍为 1 |
| 数值 `Number.isFinite` 门卫 | 有限数走 `String(v)`；NaN/Infinity 落入字符串转义路径（`'NaN'` 等） | "NaN and Infinity" 用例 |
| null/undefined → `NULL`；boolean → `1`/`0` | 同任务规格 | "null and boolean literals" 用例 |

## 与 spike 附录 C 的差异说明（均为键名断言带来的有意收窄，非缺陷）

- 键白名单 `^p\d+(_\d+)?$` 使附录 C 的键正则转义（"纵深防御"注释）成为冗余——`p\d+(_\d+)?` 不含正则元字符，任务规格版直接拼接 alternation。
- 同理，附录 C 的 `sort((a,b) => b.length - a.length)` 键长排序在 `\b` 回溯语义下冗余：实测验证 `node -e`——`/:(?:p1|p10)\b/g` 对 `:p1, :p10` 两个都匹配（`p1` 先试、`\b` 失败后引擎回溯尝试 `p10`）；`/:(?:p1)\b/g` 对 `:p10` 不匹配（`1` 与 `0` 间无词边界）。p1/p10 边界用例通过即证。
- 附录 C 的 `Date instanceof` 分支未包含（任务规格未含，不越界添加；Date 经 `String(v)` 落入 ISO 字符串转义路径，与附录 C E11 语义一致）。

## 实测验证记录（动手前）

任务"Before You Begin"要求先实测 `:p1\b` 对 `:p10` 的边界行为，已执行：

```
/:(?:p1)\b/g  vs "SELECT :p1, :p10"  → [":p1"]          （不跨匹配 ✓）
/:(?:p1|p10)\b/g vs 同上             → [":p1", ":p10"]  （回溯正确覆盖两者 ✓）
/:(?:p0|p1)\b/g vs "SELECT :p0:p1"   → [":p0", ":p1"]   （相邻参数均替换 ✓）
```

## 偏差记录（1 处，测试预期修正）

任务规格的 "no $-pattern interpretation" 用例预期串为 `'$& $' $`'`（单引号未翻倍）。该预期与任务自身不可妥协的转义契约矛盾：值 `$& $' $`` 含一个 `'`，SQLite 转义必须翻倍，正确字面量为 `'$& $'' $`'`（原预期串在 SQL 里本身是未闭合字符串）。实现按规格逐字照抄、行为正确（DROP 端到端用例独立证实翻倍转义），spike 附录 C `toLiteral` 亦为同一翻倍语义；用例的真实意图——`$&`、`$'`、`` $` `` 不被解释为 replace 替换模式——由回调函数替换天然满足。故仅修正该用例预期串为 `'$& $'' $`'`，实现零改动。修正后 30/30 全绿。

## 既有现象说明（未越界修改）

`npx tsc -p packages/ontology` 报 TS6059（`rootDir: "src"` 继承自 `tsconfig.base.json`）为 Task 1 起既有问题，Task 2 报告已记录（"与本任务无关，未越界修改"），schema/dsl/index 同样触发。本任务沿用 Task 2 做法：新文件走独立 `tsc --noEmit`（strict + noUncheckedIndexedAccess + exactOptionalPropertyTypes）零错误。
