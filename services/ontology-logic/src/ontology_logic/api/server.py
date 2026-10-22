"""ontology-logic REST API server — FastAPI app entrypoint.

Faces:
- GET  /healthz    liveness probe (Task 1)
- POST /run_logic  run one registered logic function (Task 4, REST mirror of
                   the MCP ontology_run_logic tool — same validation, same
                   executor singleton, same error messages)
- POST /query      query entity rows via the apps/api HTTP callback (REST
                   mirror of the MCP ontology_query tool)

Run with: uv run uvicorn ontology_logic.api.server:app --port 8901
"""

import logging

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from ontology_logic import __version__
from ontology_logic.api.deps import get_executor
from ontology_logic.core.executor import CircularCallError, MaxDepthError
from ontology_logic.functions.registry import validate_logic_params

logger = logging.getLogger(__name__)

app = FastAPI(
    title="ontology-logic",
    description=(
        "Python logic sidecar for DataFoundry ontology — function sandbox and "
        "pure-Python statistics kernel, exposed to agents via MCP."
    ),
    version=__version__,
)


@app.get("/healthz", summary="Liveness probe")
async def healthz() -> dict:
    """Report service liveness. Connectivity smoke target for orchestration."""
    return {"status": "ok", "service": "ontology-logic"}


# --- Task 4: REST mirror faces（与 MCP 工具同校验、同执行器、同错误文案） -------------


class RunLogicRequest(BaseModel):
    logic_name: str
    params: dict = Field(default_factory=dict)


class QueryRequest(BaseModel):
    entity: str
    filters: dict = Field(default_factory=dict)
    limit: int = 100
    offset: int = 0


@app.post("/run_logic", summary="Run one registered logic function in the sandbox")
async def run_logic(body: RunLogicRequest) -> dict:
    """Execute ``{logic_name, params}`` through the sandbox executor.

    Errors (unregistered logic / missing-typed params per FunctionSpec.input_schema /
    circular-depth guards / D5 callback failures) return HTTP 400 with the verbatim
    message — same text the MCP tool surfaces via isError content.
    """
    invalid = validate_logic_params(body.logic_name, body.params)
    if invalid is not None:
        raise HTTPException(status_code=400, detail=invalid)
    try:
        result = get_executor().run_registered(None, body.logic_name, body.params)
    except (CircularCallError, MaxDepthError, ValueError, RuntimeError) as err:
        logger.warning("POST /run_logic(%s) failed: %s", body.logic_name, err)
        raise HTTPException(status_code=400, detail=str(err)) from err
    return {"logic_name": body.logic_name, "result": result}


@app.post("/query", summary="Query ontology entity rows (apps/api callback)")
async def query(body: QueryRequest) -> dict:
    """Query ``{entity, filters?, limit?, offset?}`` via the apps/api callback.

    Callback failures (D5) return HTTP 502 with the verbatim message.
    """
    try:
        rows = get_executor().callbacks.query_rows(
            body.entity, body.filters, limit=body.limit, offset=body.offset
        )
    except RuntimeError as err:
        logger.warning("POST /query(%s) failed: %s", body.entity, err)
        raise HTTPException(status_code=502, detail=str(err)) from err
    return {"rows": rows, "rowCount": len(rows)}
