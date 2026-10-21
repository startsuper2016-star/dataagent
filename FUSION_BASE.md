BASE_COMMIT=4f7c81dd830706b67bd24ac73642d6ca6740747a
fork_base: 4f7c81dd830706b67bd24ac73642d6ca6740747a (main @ 2026-10-21)
env: node v22.22.1, DTC case OK 2026-10-21

## G0 决策门结论（2026-10-22）

- D2 参数通道：**字面量内联**（加固单遍替换版，见 spike-params-channel.md 附录 C；40/40 注入矩阵通过）；安全声明仅覆盖 SQLite 方言；**Phase 1 禁接 MySQL/远程源**（反斜杠转义差异）；gateway 扩 params 列 Phase 3。
- D5 回调超时：**客户端 5s 硬超时强制**（实测无超时则沙箱永久挂起——Windows settrace 在 C 层阻塞期失效）；失败转 RuntimeError 不重试。
- deepagents 16 提交：全部友好，三锚点（semantic/协议/data-gateway）零触碰（blob SHA 三方比对）；SemanticProviderChain 接口不变。
- 快照 vs main：三锚点 56/56 文件 blob 一致，语义接口兼容，OntologySemanticProvider 按 main 签名实现。
- 迁移面实测：9 连接（8 可迁 + 1 s3 排除）/ 254 table 资产 / 88 绑定；凭据实为 fernet://（9/9 试解密前置断言）。
- 冻结偏离：并行会话重启平台，接受 22:52 备份为有效快照；**Phase 1 迁移启动时重新执行冻结+备份**。
- G0 结论：**维持 fork main @ 4f7c81dd 基线，进入 Phase 1**。
