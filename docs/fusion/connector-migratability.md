# 连接/资产可迁移性盘点表（裁决 D1 收窄口径）

> Phase 0 · Task 8 · 2026-10-21
> 权威库：元枢根目录 `ontology.db`（只读实测）；判定依据见文末代码引用。
> 本文是 **Phase 1 迁移脚本 `scripts/migrate-yuanshu.ts` 的规格输入**，按类型域全集标注，不描述现状为止。

## 结论（TL;DR）

- **可迁移（连接）**：6 类 —— `mysql / postgresql / oracle / sqlserver / sqlite` 直接迁移，`clickhouse` 可迁移但需评估（DF 走 HTTP JSON 接口，参数面不同）。
- **stub 禁用（连接）**：1 类 —— `hive`（DF 无适配器）→ 迁为 `status=disabled` 的 stub 行 + 告警。
- **排除（连接）**：14 类 —— object_storage 5 + file_transfer 3 + message_queue 4 + api 2。
- **资产**：`table` 可迁移；`sql_view` 特殊承载（`ont_bindings.source_sql`）；`document` 排除。
- **实测现状**：9 条连接（sqlite=6、mysql=2、s3=1）全部 `active`、全部 `credential_type=plain`；255 份资产（table=254、document=1）、0 份 sql_view、88 条 object_bindings。
- **Phase 1 实际迁移面**：8 条连接（6 sqlite + 2 mysql）、254 份 table 资产；排除 1 条 s3 连接 + 1 份 document 资产。

---

## 1. 实测分布（元枢 `ontology.db`，2026-10-21 只读导出）

```text
connections by type: [('mysql', 2), ('s3', 1), ('sqlite', 6)]
assets by kind:      [('document', 1), ('table', 254)]
object_bindings:     88
connections by status: [('active', 9)]
```

行级核对（迁移脚本必须处理的实测形态）：

| 观测 | 实测值 | 对迁移的含义 |
|---|---|---|
| sqlite 连接 6 条 | `半导体制造样例库 / 设备运维演示库 / 电商订单样例库 / 污水处理演示库 / SPC_MVP_SQLITE / DC_WORKSPACE_SQLITE`，全部 `category=database`、`status=active`、`credential_type=plain` | **文件路径存放在 `database` 列**（如 `...\local-data\spc_mvp\spc_mvp.db`），不在 params —— 迁移映射见规则 3 |
| `type=sqlite` 不在元枢模型枚举注释内 | `models/connection.py:39` 注释只列 `mysql/postgresql/oracle/sqlserver/hive/clickhouse` | 枚举漂移：RCA/DC MVP 实际扩展了 sqlite。迁移脚本白名单**必须显式接受 `type=sqlite`** |
| `params` 列双重 JSON 编码 | sqlite 与 `DC_DORIS_MYSQL` 行的 params 是 JSON **字符串** `'null'`/`'{}'`（非 JSON null、非对象） | 迁移脚本需 `JSON.parse` 且容忍 `'null'` 字面量；不可假设拿到 dict |
| mysql 连接 2 条 | `dc`（params=`'{}'`）、`DC_DORIS_MYSQL`（params=`'null'`），全部 `active`、`plain` 凭据 | D1 可迁移口径内 |
| s3 连接 1 条 | `aa`（params 含 `bucket`/`endpoint`），持有唯一 1 份 document 资产（S3 上的 PDF） | D1 排除口径；连接与 document 资产**成对排除** |
| 资产外键完整性 | 255 份资产全部 `connection_id` 非空（无孤儿资产） | 迁移可按连接级联判定，无需孤儿兜底 |
| sql_view 资产 | **0 份** | 特殊承载通道（source_sql）本期无存量数据，但规格保留 |

## 2. 连接类型域盘点（D1 收窄口径逐类标注）

元枢类型域全集（`backend/app/models/connection.py:24-43`，五大类）× DataFoundry 适配器域（`packages/data-gateway/src/index.ts:367-396` 注册表 28 项；`packages/data-gateway/src/supported-types.ts` 参数面）：

### 2.1 database 类 —— `可迁移`

| 元枢 type | 现状 | DF 适配器 | 处置 | 迁移要点 |
|---|---|---|---|---|
| `sqlite` | **6 条（存量主体）** | `sqlite` ✓ | **可迁移** | `connections.database` 列 → DF config `path`（规则 3）；本地文件需确认目标机可寻址（现路径指向元枢仓库 `local-data/`） |
| `mysql` | 2 条 | `mysql` ✓ | **可迁移** | host/port/database 直通；凭据走规则 2 重加密；用户名键名规则 3 |
| `postgresql` | 0 | `postgresql` ✓ | **可迁移**（无存量） | server 模板参数直通（host/port/database/schema/username/password） |
| `oracle` | 0 | `oracle` ✓ | **可迁移**（无存量） | DF 吃 `connectString` 单键（supported-types.ts:103），元枢是 host/port(+params.sid) → 迁移时**拼接 connectString** |
| `sqlserver` | 0 | `sqlserver` ✓ | **可迁移**（无存量） | server 模板参数直通 |
| `clickhouse` | 0 | `clickhouse` ✓ | **可迁移 · 需评估**（无存量） | DF 走 HTTP JSON 接口（默认端口 8123、`secure` 布尔），与元枢 native 口径不同；无存量，评估后放行 |

### 2.2 database 类 —— `stub 禁用`

| 元枢 type | 现状 | DF 适配器 | 处置 |
|---|---|---|---|
| `hive` | 0 | 无 | **stub 禁用（适配器就绪前禁用接入）**：迁为 `status=disabled` 的 datasources stub 行 + 迁移告警，未来接 Spark/HiveServer2（可借道 DF `spark` 适配器）时转正 |

### 2.3 非数据库类 —— `排除`（迁移排除清单）

| 大类 | 元枢 type | 现状 | 排除理由（D1） |
|---|---|---|---|
| object_storage | `s3` | **1 条**（`aa`，持有 1 份 document 资产） | DF 无对象存储适配器；相关 document 资产一并排除 |
| object_storage | `oss / cos / obs / minio` | 0 | 同上 |
| file_transfer | `ftp / sftp / hdfs` | 0 | DF 无文件传输适配器 |
| message_queue | `kafka / pulsar / rocketmq / rabbitmq` | 0 | DF 无 MQ 适配器 |
| api | `rest / graphql` | 0 | DF 无 API 适配器 |

排除项处置：迁移脚本**跳过并输出排除清单**（连接名/类型/资产名），不做 stub 行；后续需要时单独立项（对齐 D8 的 Redis/Neo4j/MinIO 一期不迁口径）。

## 3. 资产盘点（D1 三形态）

| kind | 现状 | 处置 | 迁移落点 |
|---|---|---|---|
| `table` | **254 份**（全部挂连接） | **可迁移** | 随所属连接迁为 DF datasources 下的表资产；schema_snapshot/primary_key 直通；列级 `sensitivity_tags` 见规则 5 |
| `sql_view` | 0 份 | **特殊承载** | 不落 datasources；表达式以 `ont_bindings.source_sql`（可选列）承载（D1 明文） |
| `document` | **1 份**（S3 源 PDF） | **排除** | locator.source_type ∈ file/oss/directory/api/mq 均排除；与所属连接成对进排除清单 |

关联性：88 条 `object_bindings` 指向本体对象（元枢域概念），不在 D1 连接/资产迁移面内，由 Phase 1 本体数据迁移任务（T1.1）另行处理；本文仅记录基数。

## 4. 迁移映射规则（评审实锤的 5 个字段级不兼容）

Phase 1 脚本必须逐条实现；任何一条未处理即断言失败中止（回滚四件套内断言）。

1. **PK 用户域**：DF `data_sources` 主键为 `(user_id, id)`（`packages/metadata/src/index.ts:3677` 等，`PRIMARY KEY (user_id, id)` 模式；裁决 D6 同口径）。元枢 `connections.created_by` 可空且无用户表强约束 → **迁移必须为每条连接指定 owner user**（映射到融合侧指定 workspace/user 身份），不允许 NULL owner 落库。
2. **凭据重加密（D7）**：元枢 `credential_ref = fernet://<Fernet 令牌>`，经 `FernetVault` 以 `CREDENTIAL_ENCRYPTION_KEY` 解密（该 key 在元枢根目录 .env，与 `SECRET_KEY` 二选一；未设置时兜底派生 `sha256("ontology:credentials:v1:" + SECRET_KEY)` —— **迁移脚本必须同时尝试两条派生路径**）。**迁移前置断言：迁移前须对全部存量连接逐条试解密，9/9 解密成功才允许执行迁移。**DF 消费方是 `EncryptedSecretStore`，密钥为 `SECRET_MASTER_KEY`（`packages/metadata/src/index.ts:692,729`；缺钥即 `SECRET_MASTER_KEY_REQUIRED`，`packages/metadata/src/config-store.ts:305`），输出为 DF 侧重加密入库。**迁移 = 元枢解密 → DF 重加密，全程禁止明文搬运/落日志**。实测：9/9 条连接的 credential_ref 全部为 `fernet://gAAAAAB...`（Fernet 令牌）；`credential_type='plain'` 仅是列的陈旧默认值，与 ref 格式无关。格式权威定义见元枢仓库 `backend/app/services/data_plane/credential_vault.py`（`connection.py:56-61` 的 `plain://` 注释已过时，`plain://` 仅为读兼容遗留，以 vault 实现为准）。
3. **config 键名差异**：
   - DF 适配器吃 `username`（非 `user`；`serverDatabaseParameters`，supported-types.ts:257-266）；
   - sqlite/duckdb 吃 `path`（supported-types.ts:10,18）；**实测元枢 sqlite 的文件路径在 `connections.database` 列（params 为 `'null'`）→ 必须 `database → config_json.path` 重定位**；
   - oracle：元枢 host/port + params.sid → DF `connectString` 拼接；
   - 元枢 params 的 `charset / ssl_ca / sid / jdbc_extra` 在 DF 侧**无消费方**：标注丢弃（`charset/ssl_ca/jdbc_extra`）或惰性保留原样于扩展字段（`sid`，仅 oracle 拼串用）。**另实测：元枢 params 列是双重 JSON 编码字符串，脚本需 `JSON.parse` 两次并容忍 `'null'`。**
4. **status 语义映射**：元枢 `active | inactive | error`（connection.py:70-71）→ DF `ready | disabled | failed | deleted`（`packages/metadata/src/index.ts:404`）。映射：`active→ready`、`inactive→disabled`、`error→failed`；DF `deleted` 不由迁移产生。实测 9/9 为 `active` → 全部 `ready`。另注意 DF gateway 摘要展示层把 `deleted` 显示为 `disabled`（data-gateway/src/index.ts:411），盘点口径以存储值为准。
5. **脱敏模型不等价**：元枢是**列级分级** `sensitivity_tags`（`{"phone":"pii","amount":"sensitive"}`，asset.py:63-64）；DF 是**二值清单** `maskFields: string[]`（packages/data-gateway/src/types.ts:156）。分级→二值必然有损（pii 与 sensitive 不可区分）→ **golden 断言集必须排除脱敏输出差异，或显式声明对齐规则**（对齐规则：`sensitivity_tags` 非空列全部并入 `maskFields`，分级信息保留在迁移报告不落 DF）。

## 5. 判定依据（代码引用）

元枢（源仓库 `ontology-master`）：
- `backend/app/models/connection.py:16-61` —— 五大类 type 域、params 各类有效字段、status 枚举（`:56-61` 的 `plain://` 注释已过时，仅为读兼容遗留）
- `backend/app/services/data_plane/credential_vault.py` —— 凭据格式权威实现（FernetVault：`fernet://` 加解密、`CREDENTIAL_ENCRYPTION_KEY` 及派生键兜底）
- `backend/app/models/asset.py:30-64` —— kind 三形态、locator 按 kind 校验、sensitivity_tags 列级分级
- `docs/datafoundry-fusion-plan.md` 架构裁决节 —— D1（收窄口径原文）、D6（user/workspace 身份绑定）、D7（凭据密码学管线）、D8（一期不迁清单）

DataFoundry（本仓库）：
- `packages/data-gateway/src/index.ts:367-396` —— 28 项适配器注册表；`:353-359` credential_ref → `secrets.get` 消费链；`:411` deleted→disabled 展示映射
- `packages/data-gateway/src/supported-types.ts:8-18` —— sqlite/duckdb `path` 参数；`:257-266` server 模板 `username`；`:98-108` oracle `connectString`
- `packages/metadata/src/index.ts:404` —— DataSourceRecord status 四值；`:692,729` —— EncryptedSecretStore 装配；`:3677` —— `(user_id, id)` 复合主键模式
- `packages/metadata/src/config-store.ts:305` —— `SECRET_MASTER_KEY_REQUIRED`
- `packages/data-gateway/src/types.ts:156` —— `maskFields: string[]` 二值脱敏

## 6. Phase 1 迁移脚本输入摘要

```text
白名单（迁移）:  connection.type ∈ {sqlite, mysql, postgresql, oracle, sqlserver, clickhouse*}
stub（禁用）:    connection.type ∈ {hive}            → status=disabled + 告警
排除（跳过）:    connection.type ∈ {s3, oss, cos, obs, minio, ftp, sftp, hdfs,
                                    kafka, pulsar, rocketmq, rabbitmq, rest, graphql}
                asset.kind = document
特殊承载:        asset.kind = sql_view               → ont_bindings.source_sql
资产白名单:      asset.kind = table（且所属连接在白名单内）

* clickhouse 需评估后放行（HTTP JSON 接口口径差异，当前 0 存量，不阻塞 Phase 1）
```

幂等与回滚：按 T1.1 回滚四件套执行（迁移前双库备份 → 事务化应用 → 断言失败即中止恢复 → 幂等重跑）；本表的白名单/映射规则即脚本内常量表与断言依据。
