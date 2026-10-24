# Phase 1 — Task 2 报告：filter DSL 移植（12 操作符 + Python 语义对齐）

- 状态：完成（复审修复后待复审）
- Commit：`0890b61` — `phase1: fix buildWhere param numbering (per-condition index) + regression tests`（基于 `9c4edfa`，均未 push）
- 测试：`npx vitest run packages/ontology` → **20 passed (20)**（schema 3 + dsl 17），dsl.ts 独立 `tsc --noEmit`（strict + noUncheckedIndexedAccess + exactOptionalPropertyTypes）零错误

## 交付物

| 文件 | 变更 |
| --- | --- |
| `packages/ontology/src/dsl.ts` | 新建：`Filters`/`FILTER_OPS`/`Op`、`iterFilterConditions`、`likeToRegex`、`matchSingle`、`matchFilterValue`、`buildWhere`；复审后修正参数编号与错误清单排序 |
| `packages/ontology/src/index.ts` | 追加 `export * from "./dsl.js";` |
| `packages/ontology/src/dsl.test.ts` | brief 测试矩阵 + 复审修复新增回归用例（详见下文） |

## 实现语义要点（与 Python 参照 `entity_data_service.py` L35-105 / L365-387 对照）

- `iterFilterConditions`：标量 → `eq`；非空 dict → 逐 op 展开；未知 op 显式抛 `不支持的过滤操作符`，清单 `sort()` 对齐 Python `sorted(unknown)`；数组/null/空 dict 走 eq 分支。
- `likeToRegex`：`%` → `.*`、`_` → `.`、其余字符 `re.escape` 等价转义，`^...$` + `"i"`（SQLite LIKE 默认 ASCII 不敏感；Python 原版另加 `re.DOTALL`，因 `.` 通配单字符且值经 `String(value)` 单行化，无行为差异）。
- `matchSingle`：`is_null`/`not_null` 先行；null/undefined 值对其余 op 短路 false（含 `neq`，SQL 路径 `<>` 在 NULL 上为 NULL 不匹配，两条路径行为一致，无需特殊处理）；gt/gte/lt/lte 强类型校验，跨类型抛 Python `TypeError` 同文错误；`in`/`not_in` 标量条件自动包单元素数组。
- `buildWhere`：列名双引号包裹；**`i` 为逐条件序号（High-1 修复）**——循环体顶部 `const n = i; i += 1;` 无条件推进，对齐 Python `enumerate(iter_filter_conditions(filters))`：标量条件占 `:p{n}`，`in`/`not_in` 展开 `:p{n}_{j}`，`is_null`/`not_null` 与空 `in`/`not_in` 不占参但占序号；空 `in` → `1 = 0`、空 `not_in` → `1 = 1`；未知属性抛 `属性未定义或未绑定`。

## 复审修复记录（commit 0890b61）

| 项 | 修复 |
| --- | --- |
| High-1 / Medium-1（参数键冲突静默错结果） | `buildWhere` 的 `i` 从"仅标量分支末尾推进"改为循环体顶部逐条件推进；`{chamber_id: {in:["A","B"]}, stat_date: {in:["d1","d2"]}}` 由两条件同用 `p0_*`（后值覆盖前值）修复为 `p0_*` + `p1_*` 各自正确 |
| Low（unknown 排序） | `iterFilterConditions` 与 `matchFilterValue` 两处错误清单加 `.sort()`，对齐 Python `sorted`；测试断言 `不支持的过滤操作符: aa, zz`（输入 `zz, aa`） |
| Low（neq SQL 覆盖） | "translates ops" 用例恢复 `neq` 断言：`"chamber_id" <> :p1` |
| Low（回归用例） | 新增 3 条：①mixed in+eq 编号 ②双 in 编号 ③is_null 占号不占参（后续条件用 `:p1`） |
| Low（matcher neq:null 覆盖） | "null is false…" 用例补回 `expect(matchFilterValue(null, { neq: 1 })).toBe(false)` |

## 测试改动完整清单（修正此前"其余全部断言一字未动"的失实表述）

相对评审版 brief 测试矩阵，当前 `dsl.test.ts` 共有 4 处出入：

1. **like 示例裁决**（前次报告已记录）：`matchFilterValue("L26-100", { like: "l26-1_" })` 期望 `true` 与 brief 自身实现代码及 Python 原版语义（`_` = 恰好一个字符，7 字符值 vs 6 字符模式应为 false）矛盾；改为 6 字符值 `"L26-10"` 期望 `true`，保留原测试意图（`_` 单字符通配 + 大小写不敏感），实现零改动。
2. **neq:null 用例**：我收到的 brief 版本中该 null 匹配用例即为"null is false for everything except is_null/not_null"（以 `gte` 呈现、无 `neq` 断言），与评审版 brief 存在版本出入——本任务在生成时未发现该差异，本次复审已补回 `matchFilterValue(null, { neq: 1 })` → `false` 断言，覆盖对齐。
3. **expanding in params 断言对象形式**：brief 自相矛盾——其 Interfaces 声明 `buildWhere` 返回 `params` 为数组/条目序列形态，而实现代码签名为 `params: Record<string, unknown>`；按实现代码采用对象形式断言 `toEqual({ p0_0: "A", p0_1: "B" })`（Record 是 SQL 命名参数绑定的实际消费形态）。
4. **复审新增（非改动）**：上表 Low 项的 3 条回归用例 + unknown 排序断言 + neq 覆盖断言，均为增量。

## 验证过程

1. 首轮（`9c4edfa`）：测试先行（FAIL `Cannot find module './dsl.js'`）→ 实现后 16/17 → like 裁决修正后 17/17。
2. 复审修复轮（`0890b61`）：High-1 修复 + 回归用例先行验证 → **20/20 全绿**；tsc 严格检查零错误。
3. 既有现象说明：`npx tsc -p packages/ontology` 报 TS6059 为 tsconfig.base.json `rootDir: "src"` 继承问题（Task 1 的 schema.ts 同样触发），与本任务无关，未越界修改。

## 新增回归用例实际断言输出（Node 实测 buildWhere 产物）

```
mixed in+eq -> {"where":["\"chamber_id\" IN (:p0_0, :p0_1)","\"stat_date\" = :p1"],"params":{"p0_0":"A","p0_1":"B","p1":"d"}}
double in   -> {"where":["\"chamber_id\" IN (:p0_0, :p0_1)","\"stat_date\" IN (:p1_0, :p1_1)"],"params":{"p0_0":"A","p0_1":"B","p1_0":"d1","p1_1":"d2"}}
```

## 遗留/移交事项

- 无功能遗留。`:p{n}` 逐条件编号已与 Python `enumerate` 语义对齐，Task 4 `objectQuery` 消费时直接 `where.join(" AND ")` + params 即可；`neq`/`<>` 在 NULL 上两条路径行为一致，无需调用方特殊处理。
