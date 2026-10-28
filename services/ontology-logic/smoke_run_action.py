"""Live MCP smoke: call ontology_run_action on the running 8902 server."""
import asyncio
import sys

sys.path.insert(0, "tests")

from mcp import ClientSession  # noqa: E402
from mcp.client.streamable_http import streamablehttp_client  # noqa: E402


async def main() -> None:
    async with streamablehttp_client("http://127.0.0.1:8902/mcp") as (read, write, _):
        async with ClientSession(read, write) as session:
            await session.initialize()
            tools = await session.list_tools()
            names = sorted(t.name for t in tools.tools)
            print("tools:", names)
            assert "ontology_run_action" in names, "ontology_run_action not registered"

            result = await session.call_tool(
                "ontology_run_action",
                {"action_code": "mcp_discover_probe", "params": {"chamber": "CH1"}, "mode": "execute"},
            )
            print("isError:", result.isError)
            print("content:", result.content[0].text[:400])
            assert not result.isError, result.content[0].text[:200] if result.content else "empty"

            # 未声明 token / 缺参走 isError 自纠通道

            # 规则求值（ontology_eval_rule）：live 规则 + 行过滤
            rule = await session.call_tool(
                "ontology_eval_rule",
                {"rule_name": "live_eval_rule", "filters": {"lot_id": "L2"}, "limit": 5},
            )
            print("eval isError:", rule.isError)
            print("eval content:", rule.content[0].text[:400])
            assert not rule.isError

            bad = await session.call_tool(
                "ontology_run_action",
                {"action_code": "mcp_discover_probe", "params": {}, "mode": "execute"},
            )
            print("missing-param isError:", bad.isError, "|", bad.content[0].text[:120])
            assert bad.isError


asyncio.run(main())
