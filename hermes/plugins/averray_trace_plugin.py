"""Best-effort Hermes trace bridge.

Hermes owns the real agent runtime. This plugin contains no Averray business
logic; it only forwards lifecycle events to trace-mcp's internal HTTP ingest
endpoint when Hermes exposes compatible hooks.
"""

import json
import os
import urllib.request
from datetime import datetime, timezone


TRACE_HTTP_URL = os.environ.get("TRACE_HTTP_URL", "http://trace-mcp:8789/hermes-event")


def _post(kind, payload):
    body = json.dumps(
        {
            "kind": kind,
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "payload": payload,
        }
    ).encode("utf-8")
    request = urllib.request.Request(
        TRACE_HTTP_URL,
        data=body,
        headers={"content-type": "application/json"},
        method="POST",
    )
    try:
        urllib.request.urlopen(request, timeout=2).read()
    except Exception:
        # Tracing must never break Hermes task execution.
        pass


async def pre_llm_call(event):
    _post("pre_llm_call", getattr(event, "dict", lambda: {"repr": repr(event)})())


async def post_llm_call(event):
    _post("post_llm_call", getattr(event, "dict", lambda: {"repr": repr(event)})())


async def pre_tool_call(event):
    _post("pre_tool_call", getattr(event, "dict", lambda: {"repr": repr(event)})())


async def post_tool_call(event):
    _post("post_tool_call", getattr(event, "dict", lambda: {"repr": repr(event)})())

