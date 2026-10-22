"""HTTP callback client: sandbox helpers → apps/api ``/api/v1/ontology/*`` routes.

融合裁剪：元枢版函数运行时的数据助手（_build_ontology_helpers）直接调 SQLAlchemy
服务；本服务改为 HTTP 回调 apps/api 本体路由，Bearer ONTOLOGY_SERVICE_TOKEN 鉴权。

D5 契约：**硬超时 + 失败即抛 RuntimeError + 绝不重试**。
- httpx.Timeout(connect=2s, read/write/pool=callback_timeout)，默认 5s；
- 任一失败（传输异常 / 非 200 / 坏 JSON / error 信封）立即抛 RuntimeError。

端点契约（apps/api/src/routes/ontology.ts）：
- POST /api/v1/ontology/query    {entity, filters?, limit?, offset?} → {columns, rows, rowCount}
- POST /api/v1/ontology/sql      {sql, params?}                      → {columns, rows, rowCount}
- POST /api/v1/ontology/traverse {fromEntity, fromFilters?, toEntity, limit?} → {columns, rows, rowCount}
响应包裹（@datafoundry/contracts）：``{success: true, data}`` | ``{success: false, error: {code, message}}``
"""
from __future__ import annotations

from typing import Any

import httpx


def _rows_as_dicts(data: Any) -> list[dict]:
    """``{columns, rows}`` → ``list[dict]``（与元枢 dict(zip(columns, row)) 形态一致）。"""
    if not isinstance(data, dict):
        return []
    columns = data.get("columns") or []
    return [dict(zip(columns, row, strict=True)) for row in (data.get("rows") or [])]


class OntologyCallbackClient:
    """Synchronous httpx client for ontology data callbacks (D5 contract)."""

    def __init__(
        self,
        api_base_url: str,
        service_token: str = "",
        timeout_seconds: float = 5.0,
        transport: httpx.BaseTransport | None = None,
    ):
        self.api_base_url = api_base_url.rstrip("/")
        self.service_token = service_token
        self.timeout = httpx.Timeout(
            connect=2.0, read=timeout_seconds, write=timeout_seconds, pool=timeout_seconds
        )
        # transport 仅测试注入（httpx.MockTransport）；生产为 None（默认连接池）。
        self._client = httpx.Client(timeout=self.timeout, transport=transport)

    def close(self) -> None:
        """Release the underlying HTTP connection pool."""
        self._client.close()

    # --- 传输层 -------------------------------------------------------------------

    def _post(self, path: str, payload: dict[str, Any]) -> Any:
        """POST one callback request and unwrap the contracts envelope.

        D5: 单次投递不重试；一切失败归一为 RuntimeError（沙箱内可直接 except）。
        """
        headers = {"Authorization": f"Bearer {self.service_token}"} if self.service_token else {}
        url = f"{self.api_base_url}{path}"
        try:
            response = self._client.post(url, json=payload, headers=headers)
        except httpx.HTTPError as err:  # 含 TimeoutException / ConnectError 等传输失败
            raise RuntimeError(f"ontology 回调 {path} 失败（D5 不重试）: {err}") from err
        try:
            body = response.json()
        except ValueError:
            body = None
        error = body.get("error") if isinstance(body, dict) else None
        failed = response.status_code != 200 or error is not None or (
            isinstance(body, dict) and body.get("success") is False
        )
        if failed:
            # 优先透出 apps/api 错误信封的 message，否则报 HTTP 状态。
            message = error.get("message") if isinstance(error, dict) else error
            if message:
                raise RuntimeError(f"ontology 回调 {path} 失败: {message}")
            raise RuntimeError(f"ontology 回调 {path} 返回非 200: HTTP {response.status_code}")
        if not isinstance(body, dict):
            raise RuntimeError(f"ontology 回调 {path} 响应不是 JSON 对象")
        return body.get("data")

    # --- 数据助手（返回形态与元枢 helper 逐一对齐） ---------------------------------

    def query_rows(
        self, entity_name: str, filters: dict, limit: int = 100, offset: int = 0
    ) -> list[dict]:
        """POST /api/v1/ontology/query → list[dict]（每行按 columns 字典化）。"""
        data = self._post(
            "/api/v1/ontology/query",
            {"entity": entity_name, "filters": filters, "limit": limit, "offset": offset},
        )
        return _rows_as_dicts(data)

    def execute_sql(self, sql: str, params: dict | None = None) -> dict:
        """POST /api/v1/ontology/sql → {columns, rows, rowCount}（行不做字典化）。"""
        data = self._post("/api/v1/ontology/sql", {"sql": sql, "params": params or {}})
        return data if isinstance(data, dict) else {}

    def traverse_rows(
        self, from_entity: str, from_filters: dict, to_entity: str, limit: int = 100
    ) -> list[dict]:
        """POST /api/v1/ontology/traverse → list[dict]（目标实体实例字典化）。"""
        data = self._post(
            "/api/v1/ontology/traverse",
            {
                "fromEntity": from_entity,
                "fromFilters": from_filters,
                "toEntity": to_entity,
                "limit": limit,
            },
        )
        return _rows_as_dicts(data)
