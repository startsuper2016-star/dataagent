# Phase 2 · Task 1 报告：services/ontology-logic 服务骨架 + MCP echo

**状态：完成** · Commit: `1d9d27e`（已推送 origin main）· 日期：2026-10-22

## 交付文件（10 个，含 uv.lock）

```
services/ontology-logic/
├── pyproject.toml                        # uv + hatchling，src 布局，依赖照抄 datalink
├── uv.lock                               # 已生成并入库（同 datalink 先例）
├── src/ontology_logic/
│   ├── __init__.py                       # __version__ = "0.1.0"
│   ├── config.py                         # pydantic 分节配置（server/api/llm/mcp），env 加载
│   ├── api/{__init__,deps,server}.py     # FastAPI：GET /healthz
│   └── mcp/{__init__,server}.py          # FastMCP：ontology_ping 工具，streamable-http 默认
└── tests/test_health.py                  # fastapi.testclient，2 条断言
```

根 `.gitignore` **未改动**：`git check-ignore -v` 实测已覆盖——`.venv/`（第 2 行，任意层级匹配）与 `__pycache__/`（第 37 行）均命中 `services/ontology-logic/` 下路径，无需补条目。

## 设计要点

- **config.py**：pydantic BaseModel 分节（仿 `datalink_config.example.json` 的 server/llm 分节风格），但按任务要求用 env 简化（无 JSON 文件）。env 名与 Phase 2 Task 2 契约对齐：`ONTOLOGY_API_BASE_URL`（默认 `http://127.0.0.1:8787` = apps/api `API_PORT` 默认值）、`ONTOLOGY_SERVICE_TOKEN`、`ONTOLOGY_LOGIC_CALLBACK_TIMEOUT`（默认 5.0s，D5）、`ONTOLOGY_LOGIC_HOST/PORT`（127.0.0.1:8901）、`ONTOLOGY_LOGIC_LLM_MODEL/API_KEY/BASE_URL`（可选段，默认空=禁用）、`ONTOLOGY_LOGIC_MCP_HOST/PORT/TRANSPORT`（127.0.0.1:8902，streamable-http）。
- **deps.py**：`lru_cache` 单例 `get_config()`（datalink api/deps.py 同款 DI 模式）。
- **mcp/server.py**：`FastMCP("ontology-logic")` + `@mcp.tool()` 注册 `ontology_ping`（无参，返回 `{"pong": true, "service": "ontology-logic"}`）；`python -m ontology_logic.mcp.server` 可直接启动；transport 默认 streamable-http（datalink 推荐模式同族，服务双面暴露需要 HTTP），env 可切 stdio。

## 验收结果（4/4 通过）

| # | 验收项 | 结果 |
|---|---|---|
| 1 | `uv lock` + `uv sync` | ✅ 解析 46 包，`.venv` 建成（CPython 3.12.13） |
| 2 | `uv run pytest` | ✅ 2 passed（healthz 状态码+JSON 体、content-type） |
| 3 | uvicorn 后台起 + curl | ✅ `curl http://127.0.0.1:8901/healthz` → **200** `{"status":"ok","service":"ontology-logic"}`，已停止 |
| 4 | MCP server 实测 | ✅ `python -m ontology_logic.mcp.server` 启动后，向 `http://127.0.0.1:8902/mcp` 发 initialize → 返回 `serverInfo {"name":"ontology-logic"}`；带 session 再调 `tools/call ontology_ping` → 返回 `{"pong": true,"service": "ontology-logic"}`，isError=false，已停止 |

## datalink 依赖版本抄写情况

pyproject 依赖**逐条照抄** `services/datalink/pyproject.toml` 的声明（pydantic>=2.0、mcp>=1.0、fastapi>=0.100、uvicorn>=0.20），同款 aliyun 镜像 index、hatchling 构建、ruff/pytest 配置；另按计划补 `httpx>=0.27`（Task 2 回调 + TestClient 依赖）。锁定版本对比（datalink uv.lock → 本服务 uv.lock）：

| 包 | datalink | ontology-logic | 说明 |
|---|---|---|---|
| **mcp** | **1.28.1** | **1.30.0** | 首次 lock 曾解析到 2.3.0（大版本漂移，触发计划风险表），已加 `mcp>=1.0,<2` 上限强制对齐 datalink 的 1.x 线 |
| fastapi | 0.139.0 | 0.159.1 | 同 0.x 线，仅声明 lower bound（与 datalink pyproject 一致） |
| uvicorn | 0.49.0 | 0.54.0 | 同上 |
| pydantic | 2.13.4 | 2.14.1 | 同 2.x 线 |

## 疑虑 / 备注

1. **mcp 1.30.0 vs datalink 1.28.1**：同大版本内小版本差（lower-bound lock 的正常浮动）；FastMCP 注册/transport API 实测可用。若需字节级一致可在两边同时收紧 pin。
2. pytest 有 1 条无害 deprecation 警告：starlette 1.9 提示 TestClient 未来改用 httpx2——来自依赖内部，不影响功能，后续升 starlette 时一并处理。
3. config 的 `service_token` 默认空；apps/api 侧真实 token 在 Phase 2 Task 4 联调时经 env 注入，本任务不涉及。
4. `python -m ontology_logic.mcp.server` 走 `if __name__ == "__main__"` 入口（datalink 无此入口，系为满足验收 4 的启动方式而加），不改变 MCP 注册模式。
