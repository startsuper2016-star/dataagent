"""ontology-logic MCP server — expose the logic sandbox as MCP tools.

Default surface: ontology_ping (connectivity echo) only, following the
datalink mcp/server.py registration pattern. Real tools (ontology_run_logic,
ontology_query) are registered alongside it in later Phase 2 tasks.

Transport: streamable-http by default (same family as datalink's
streamable-http mode), stdio available via ONTOLOGY_LOGIC_MCP_TRANSPORT.

Run with: uv run python -m ontology_logic.mcp.server
"""

import logging

from mcp.server.fastmcp import FastMCP

from ontology_logic.api.deps import get_config

logger = logging.getLogger(__name__)

mcp = FastMCP("ontology-logic")


@mcp.tool()
def ontology_ping() -> dict:
    """Connectivity check for the ontology-logic MCP server.

    Always succeeds — returns an echo payload so clients can verify
    transport wiring before calling real logic tools.
    """
    return {"pong": True, "service": "ontology-logic"}


def start_mcp_server(host: str = "", port: int = 0, transport: str = "") -> None:
    """Start the MCP server.

    Args:
        host: Bind host. Empty = ONTOLOGY_LOGIC_MCP_HOST or 127.0.0.1.
        port: Bind port. 0 = ONTOLOGY_LOGIC_MCP_PORT or 8902.
        transport: 'streamable-http' (default) or 'stdio'.
    """
    config = get_config()
    mcp.settings.host = host or config.mcp.host
    mcp.settings.port = port or config.mcp.port
    effective_transport = transport or config.mcp.transport

    logger.info(
        "Starting ontology-logic MCP server (%s) on %s:%s",
        effective_transport,
        mcp.settings.host,
        mcp.settings.port,
    )
    mcp.run(transport=effective_transport)


if __name__ == "__main__":
    start_mcp_server()
