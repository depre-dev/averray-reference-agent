"""Best-effort Hermes trace bridge.

Hermes owns the real agent runtime. This plugin contains no Averray business
logic; it only forwards lifecycle events to trace-mcp's internal HTTP ingest
endpoint when Hermes exposes compatible hooks.
"""

import json
import os
import urllib.request
from datetime import datetime, timezone
from collections.abc import Mapping, Sequence


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


def _event_payload(event):
    if hasattr(event, "model_dump"):
        try:
            return _json_safe(event.model_dump())
        except Exception:
            pass
    if hasattr(event, "dict"):
        try:
            return _json_safe(event.dict())
        except Exception:
            pass
    if hasattr(event, "__dict__"):
        try:
            return _json_safe(event.__dict__)
        except Exception:
            pass
    return {"repr": repr(event)}


def _json_safe(value):
    if isinstance(value, Mapping):
        return {str(key): _json_safe(item) for key, item in value.items()}
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        return [_json_safe(item) for item in value]
    return repr(value)


async def pre_llm_call(event):
    _post("pre_llm_call", _event_payload(event))


async def post_llm_call(event):
    _post("post_llm_call", _event_payload(event))


async def pre_tool_call(event):
    _post("pre_tool_call", _event_payload(event))


async def post_tool_call(event):
    _post("post_tool_call", _event_payload(event))
