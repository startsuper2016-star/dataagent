"""ontology-logic REST API server — FastAPI app entrypoint.

Run with: uv run uvicorn ontology_logic.api.server:app --port 8901
"""

import logging

from fastapi import FastAPI

from ontology_logic import __version__

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
