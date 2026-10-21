# Spike：网关参数通道选型（裁决 D2 定案依据）

> Phase 0 · Task 6 · 2026-10-21
> 环境：Node v22.22.1（`node:sqlite` 内置，无需安装）；测试代码为一次性 spike，不入库（`%TEMP%/spike-params/`）。

## 结论（TL;DR）

**D2 定案：默认选「字面量内联」（inline literal）。**

- **适用范围（严格限定）**：仅限 `packages/ontology` 的对象名重写路径（object-name rewrite）；值全部来自**校验后的 filter DSL 参数**，键名来自白名单生成器（`p0..pN` 固定模式）。
- **方言声明（诚实口径）**：本结论仅对 **SQLite 方言**声明安全。Phase 1 全部数据源 = 本地 SQLite（按 D1 收窄），因此 Phase 1 可直接采用。
- **实现修订**：不得使用逐键顺序替换的 naive 实现；必须采用**单遍替换**（single-pass alternation）实现——spike 实测 naive 版在跨键自引用场景会把语句结构打碎（2 用例复现，语法错误 fail-closed，未构成注入逃逸，但属于正确性缺陷+高危边界）。
- **gateway 扩 params**（方案 a）：改动面横切 10 个非测试文件 / 39 处引用 / 8 个适配器，**列为 Phase 3 加固项**，不在 Phase 0/1 实施。

---

## 1. 背景与候选方案

元枢 fusion 需要把校验后的 filter DSL 参数送进 SQL。两条候选通道：

| 方案 | 描述 | 优点 | 缺点 |
|---|---|---|---|
| **(a) gateway 扩 params** | `AdapterSqlInput` / `RunSqlReadonlyInput` 增加 `params` 字段，透传到各引擎的原生参数绑定 | 引擎级绑定，方言无关，理论最安全 | 改动面大（见 §5）；需逐一验证 8 个适配器对应引擎的命名参数支持（`:p0` vs `?` vs `$1`） |
| **(b) 字面量内联** | 在 `packages/ontology` 内把 `:pN` 直接替换为转义后的 SQL 字面量（`''` 转义 + 类型分支） | 零网关改动；对 SQLite 语义完全可控；语句即所见即所得 | 方言敏感（MySQL 反斜杠等，见 §6）；实现必须正确 |

## 2. 注入测试矩阵（实测）

### 2.1 方法

- 被测实现两份（`%TEMP%/spike-params/inline.mjs`）：
  - `inlineParams`：**naive 版**（brief 给定的逐键 `new RegExp(":k\\b")` 顺序替换）；
  - `inlineParamsSinglePass`：**加固版**（一个 `:(?:p0|p1|...|pN)\b` alternation 正则 + replacer 回调，键按长度降序，替换结果不再被扫描）。
- 执行器 `matrix.mjs`：40 个用例 × 2 实现，每用例在**全新内存库**（`node:sqlite` `DatabaseSync(':memory:')`）上执行；每例断言内联产物 SQL、查询结果、以及**表完整性**（种子表 `t` 必须仍为 6 行、审计表 `audit` 必须为 0 行——任何 DROP/DELETE/INSERT 生效即判失败）。
- 复现：`cd %TEMP%/spike-params && node matrix.mjs naive && node matrix.mjs single`

### 2.2 用例分组与结果

| 组 | 用例 | 覆盖点 | naive | single-pass |
|---|---|---|---|---|
| A token 边界 | A1_p1_vs_p10 | `:p1` 不蚕食 `:p10`（`\b` 实证：`0` 是词字符，`:p1\b` 不匹配 `:p10` 前缀） | PASS | PASS |
| | A2_p1_vs_p1_0 | `:p1` 不蚕食 `:p1_0`（下划线是词字符） | PASS | PASS |
| | A3_p0_adjacent_word | `:p0` 不蚕食 `:p0x` | PASS | PASS |
| | A4_param_twice | 同 token 出现两次全部替换 | PASS | PASS |
| | A5_p0_to_p99_sweep | `p0..p99` 共 100 键全量替换 | PASS | PASS |
| | A6_insertion_order_irrelevant | 键插入顺序 p10 先于 p1，结果一致 | PASS | PASS |
| B 自引用/级联 | B1_self_ref_same_key | 值含 `:p0` 自身，单次替换不二次展开 | PASS | PASS |
| | B2_self_ref_in_multi | 值含 `:v`（brief 原攻击用例的 w 参数） | PASS | PASS |
| | B3_cross_key_cascade | 值含 `:p1` → 跨键级联 | **FAIL（缺陷①）** | PASS |
| | B4_cascade_quote_parity | 级联 + `' OR '1'='1` 引号奇偶攻击 | **FAIL（缺陷①）** | PASS |
| C 经典载荷 | C1..C6 | `'; DROP TABLE t;--`、`'; DELETE/INSERT;--`、`' UNION SELECT`、`' OR '1'='1`、`safe' --`、双引号载荷 | 全 PASS | 全 PASS |
| D 值形态 | D1/D2 | `%`、`_` 在 `=` 比较下按字面字符精确匹配 | PASS | PASS |
| | D3/D4 | 反斜杠（尾随 `\`、`a'b\c'd` 混合）不破坏引用 | PASS | PASS |
| | D5/D6/D7 | 中文/emoji + 引号，含端到端写入后回查往返 | PASS | PASS |
| | D8 | 值含换行符 | PASS | PASS |
| E 类型分支 | E1/E2 | `null` / `undefined` → `NULL`（`IS :p0` → `IS NULL`） | PASS | PASS |
| | E3–E6 | 0 / 负浮点 / 科学计数 `1e+21` / `MAX_SAFE_INTEGER` 数值语义 | PASS | PASS |
| | E7/E8 | `NaN` / `Infinity` → 走字符串分支成 `'NaN'`/`'Infinity'`（不产生裸标识符） | PASS | PASS |
| | E9/E10 | `true→1`、`false→0` | PASS | PASS |
| | E11 | `Date` → ISO 8601 `'2026-10-21T08:30:00.000Z'` 且可匹配 | PASS | PASS |
| | E12/E13 | 空字符串 `''`；对象走 `String()` 兜底（校验层应拦截） | PASS | PASS |
| F 键名白名单 | F1_malicious_key_regex | 键 `p1).*(x`：naive 构造正则即抛 `SyntaxError`；single-pass 元字符转义后正常处理白名单键 | PASS* | PASS |
| | F2_malicious_key_dotstar | 键 `.*`：naive 产生贪婪误匹配打碎语句（白名单必要性实证）；single-pass 转义后零改动 | PASS* | PASS |
| G 端到端 | G1_step2_canonical | Step 2 原样场景：DROP 未生效，`t` 仍存在，0 行 | PASS | PASS |

\* F 组对 naive 断言的是「危险行为按预期暴露」（抛错/误匹配被观察到），用于实证白名单前提，不是安全通过。

**汇总：naive 38/40（发现 1 类缺陷，2 用例复现）；single-pass 40/40 全过。**

### 2.3 关键实证

1. **`\b` 边界理论安全，实证成立**：`:p1\b` 在 `:p10` 上不匹配（`0` 为词字符），在 `:p1_0` 上不匹配（`_` 为词字符）。A1/A2 最终 SQL 均为 `a = 'safe' AND b = 'y'`，`b` 列由 `:p10`/`:p1_0` 自己的字面量填充，未出现 `'safe'0` 形态的蚕食。100 键全量扫描（A5）无任何串扰。
2. **值内 token 自引用安全**：`String.prototype.replace` 全局单遍左→右扫描，替换产物不重扫；同键自引用（B1/B2）两版实现均安全。
3. **`''` 转义可阻断经典载荷**：所有 C 组载荷（DROP/DELETE/INSERT/UNION/OR 恒真/注释截断）均被字面量化，执行结果 0 行，表完整性断言全绿。Step 2 原样命令实测输出 `INJECTED: SELECT * FROM t WHERE a = 'x''; DROP TABLE t;--'`（该日志仅表示 `db.exec` 未抛错——SELECT 语句合法执行 0 行；附带探测确认 `sqlite_master` 中 `t` 表仍存在）。
4. **`%`/`_` 在 `=` 比较下是字面字符**（D1/D2）。注意：若未来把内联用于 `LIKE` 子句，`%`/`_` 会恢复通配语义——Phase 1 的对象名重写路径不使用 LIKE，无此风险（见 §6 限制）。

### 2.4 缺陷①：naive 跨键级联（已定位、已给出修订）

用例 B3（`{ p0: ":p1", p1: "x', b='evil" }`）实测产物：

```sql
SELECT * FROM t WHERE a = ''x'', b=''evil'' AND b = 'zzz'
-- SQLite: near "x''": syntax error
```

用例 B4（`{ p0: ":p1", p1: "' OR '1'='1" }`）实测产物：

```sql
SELECT * FROM t WHERE a = '''' OR ''1''=''1''
-- SQLite: near "1": syntax error（载荷一度重组进 OR 布尔区，最终因引号失衡 fail-closed）
```

机理：naive 逐键替换，处理 `:p1` 时会重扫 `:p0` 已替换产生的字符串内部，把 `:p1` 的字面量（自带一对引号）塞进外层字符串，导致整句重新词法化——B4 中载荷片段进入活代码区（`OR` 关键字生效），仅因末尾多余引号失衡而报语法错误。**未构成注入逃逸（fail-closed），但破坏正确性且是高危边界，不可接受。**

**修订（本 spike 定版实现）**：单遍替换 `inlineParamsSinglePass`——一个 alternation 正则（键按长度降序 + 元字符转义纵深防御）+ replacer 回调，替换产物永不被重扫。40/40 全过，同时天然消除键插入顺序敏感性。

## 3. 方案 (a) gateway 扩 params 的改动面（Step 3 统计）

对 `packages/data-gateway/src` 实测：

```
grep -rn "AdapterSqlInput\|RunSqlReadonlyInput" .../src | grep -v test | wc -l   → 39
grep -c "prepare(" .../src/adapters/local-sql-adapters.ts                        → 4
grep -rln "AdapterSqlInput\|RunSqlReadonlyInput" .../src | grep -v test          → 10 个文件
```

- 引用该输入契约的非测试文件共 **10 个**（全 `src` 共 14 个 `.ts`）：`types.ts`（契约定义）、`index.ts`（导出面）、以及全部 **8 个适配器文件**（local-sql / local-dataset / sql-family / search / nosql / lakehouse / warehouse / enterprise-sql）。
- 即扩 `params` 是**横切改动**：改契约 → 8 个适配器逐个接参数绑定 → 各引擎方言验证（SQLite/DuckDB/PG/MySQL/NoSQL 对命名参数 `:pN` 的支持形态各不相同，多数只支持 `?`/`$1` 位置参数，还需改 SQL 生成端的占位符策略）。
- 结论：Phase 0/1 不具备性价比；列为 **Phase 3 加固项**，届时以「位置参数 `?` + 数组绑定」为首选形态重新设计。

## 4. D2 最终结论

1. **默认通道 = 字面量内联**，采用 §2.4 的单遍替换实现，仅用于 `packages/ontology` 对象名重写路径；值域前置约束：全部来自校验后的 filter DSL 参数、键名由白名单生成器产生（`p0..pN` 纯词字符模式，F 组实证非白名单键名要么抛错要么打碎语句——白名单是安全前提而非可选项）。
2. **Phase 1 数据源 = 本地 SQLite（D1 口径）**，本结论仅对 SQLite 方言声明安全。
3. **gateway 扩 params 列为 Phase 3 加固项**，触发条件：接入远程/多方言数据源、或出现必须参数绑定的合规要求。

## 5. 限制（Limits）

- **方言**：`''` 转义 + 反斜杠按字面处理，仅对 SQLite（及同为标准字符串语义的 PG 标准模式）成立。**MySQL 默认模式下反斜杠是转义符**：值 `x\'` 会吃掉收尾引号导致逃逸——这是 Phase 3 扩 params 的首要理由。Phase 1 不接 MySQL，无暴露面。
- **LIKE**：内联不转义 `%`/`_`。`=` 比较下它们是字面字符（D1/D2 已证）；一旦用于 LIKE 子句将恢复通配语义。对象名重写路径不得生成 LIKE 条件；若 Phase 1+ 需要 LIKE，须叠加 `ESCAPE` 处理。
- **类型分支**：`NaN`/`Infinity`/普通对象按 `String()` 兜底成字符串字面量——不崩溃但语义可疑，filter DSL 校验层必须把数值约束为有限数、把值约束为标量。
- **Date**：内联为 ISO 8601 文本，仅当列以 TEXT 存 ISO 字符串时可匹配；SQLite 无原生 DATETIME 类型，属预期行为。
- **node:sqlite 为实验特性**（Node 22.22.1 输出 ExperimentalWarning）；spike 结论针对内联算法本身，不依赖该 API 的稳定性。
- 本矩阵未覆盖：超长值/深嵌套性能、并发、`sqlite3` 其他绑定 API（better-sqlite3 等语义一致但未实测）。

## 附录 A：复现命令

```bash
# 1) naive 版 demo（brief 原样）
node %TEMP%/spike-params/inline.mjs
# → SELECT * FROM t WHERE a = 'x''; DROP TABLE t;--' AND b = ':v'

# 2) 注入矩阵
cd %TEMP%/spike-params
node matrix.mjs naive    # PASS: 38  FAIL: 2 （B3/B4 级联缺陷）
node matrix.mjs single   # PASS: 40  FAIL: 0

# 3) gateway 改动面
grep -rn "AdapterSqlInput\|RunSqlReadonlyInput" "<dataagent>/packages/data-gateway/src" | grep -v test | wc -l
grep -c "prepare(" "<dataagent>/packages/data-gateway/src/adapters/local-sql-adapters.ts"
```

## 附录 B：single-pass 40 用例全过清单

A1_p1_vs_p10, A2_p1_vs_p1_0, A3_p0_adjacent_word, A4_param_twice, A5_p0_to_p99_sweep, A6_insertion_order_irrelevant, B1_self_ref_same_key, B2_self_ref_in_multi, B3_cross_key_cascade, B4_cascade_quote_parity_attack, C1_classic_drop, C2_delete_insert, C3_union_select, C4_or_always_true, C5_comment_truncation, C6_double_quote_payload, D1_percent_literal_eq, D2_underscore_literal_eq, D3_backslash_trailing, D4_backslash_quote_mix, D5_cjk_quote, D6_emoji_quote, D7_cjk_emoji_roundtrip, D8_newline_in_value, E1_null, E2_undefined, E3_zero, E4_negative_float, E5_scientific, E6_max_safe_integer, E7_nonfinite_becomes_string, E8_infinity_becomes_string, E9_boolean_true, E10_boolean_false, E11_date_iso, E12_empty_string, E13_object_fallback, F1_malicious_key_regex, F2_malicious_key_dotstar, G1_step2_canonical

## 附录 C：定版实现（单遍替换，落地时照抄）

```javascript
function toLiteral(v) {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v === "boolean") return v ? "1" : "0";
  if (v instanceof Date) return `'${v.toISOString()}'`;
  return `'${String(v).replace(/'/g, "''")}'`;
}

export function inlineParamsSinglePass(sql, params) {
  const keys = Object.keys(params).sort((a, b) => b.length - a.length);
  if (keys.length === 0) return sql;
  const alternation = keys
    .map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) // 键来自白名单生成器，此转义为纵深防御
    .join("|");
  return sql.replace(new RegExp(`:(?:${alternation})\\b`, "g"), (m) => toLiteral(params[m.slice(1)]));
}
```
