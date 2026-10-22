"""ontology-logic — Python logic sidecar for DataFoundry ontology.

FastAPI + MCP service (mirrors the services/datalink layout) hosting the
function sandbox and pure-Python statistics kernel. Data access inside
functions is performed via HTTP callbacks to apps/api `/api/v1/ontology/*`
routes using a Bearer service token.
"""

__version__ = "0.1.0"
