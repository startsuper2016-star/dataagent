# Phase 0 · Task 8 报告：连接/资产可迁移性盘点表（D1 收窄口径）

- 状态：**DONE_WITH_CONCERNS**
- Commit：`9c68cf5`（phase0: connector migratability inventory，已推送 origin/main）
- 产出：`docs/fusion/connector-migratability.md`（124 行）

## 实测分布（ontology.db 只读导出，2026-10-21）

- connections by type：mysql=2、s3=1、sqlite=6（共 9 条，全部 active、全部 credential_type=plain）
- assets by kind：table=254、document=1（共 255，无孤儿资产）；sql_view=0
- object_bindings：88

## 盘点结论（D1 口径）

- 可迁移（连接 6 类）：mysql / postgresql / oracle / sqlserver / sqlite 直迁；clickhouse 可迁移需评估（DF 走 HTTP JSON 接口，当前 0 存量不阻塞）
- 占位禁用（1 类）：hive → status=disabled 占位 + 告警
- 排除（14 类）：object_storage 5 + file_transfer 3 + message_queue 4 + api 2；资产 kind=document 同排除
- 特殊承载：sql_view → ont_bindings.source_sql（本期 0 存量，规格保留）
- Phase 1 实际迁移面：8 条连接（6 sqlite + 2 mysql）+ 254 份 table 资产；排除 1 条 s3 + 1 份 document

文档含 5 条迁移映射规则（PK 用户域 / D7 凭据重加密 / config 键名 / status 语义 / 脱敏模型不等价），全部附代码行级引用（元枢 connection.py/asset.py；DF data-gateway index.ts:367-396、supported-types.ts、metadata index.ts:405/692/729、config-store.ts:305、types.ts:156）。

## 疑虑（实测与任务简报假设的偏差，均已在文档中如实标注）

1. **存量比简报假设多**：简报称"实际只有 sqlite 一个连接（SPC_MVP_SQLITE）"，实测 9 条（sqlite=6、mysql=2、s3=1）——并行会话（RCA/DC MVP）在权威库持续写入。迁移面相应扩大到 8 条连接。
2. **sqlite 路径不在 params**：实测 6 条 sqlite 的文件路径存放在 `connections.database` 列，params 是双重 JSON 编码字符串 `'null'`。映射规则 3 已补"database → config_json.path 重定位 + JSON.parse 容忍 'null'"，脚本实现时必须按此处理。
3. **枚举漂移**：`type=sqlite` 不在元枢 `models/connection.py` 类型注释枚举内（模型注释只列 6 个 DB 类型）。迁移脚本白名单必须显式接受 sqlite，不能从模型枚举生成。
4. **s3 连接持有唯一 document 资产**：`aa`（bucket/endpoint）与 1 份 S3 PDF 成对落排除清单——若后续业务需要该 PDF，需按 D8 口径单独立项。

## 后续输入

- 本表白名单/映射规则即 `scripts/migrate-yuanshu.ts`（T1.1）的常量表与断言依据。
- 建议迁移执行前再次冻结/备份 ontology.db（实测库仍在被并行写入，T0.3 的停写纪律需在 Phase 1 迁移窗口强制执行）。
