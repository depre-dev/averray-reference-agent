"""Pinned-kernel worker-kill probe that leaves disposable evidence readable."""

from __future__ import annotations

import json
import os
from pathlib import Path

from agent_runtime.contracts import EventType
from agent_runtime.ledger import MigrationRunner
from tests.acceptance.support import (
    events,
    start_worker,
    submit,
    task,
    wait_for,
    wait_for_terminal,
)
from tests.conftest import reset_postgres_schema


def main() -> None:
    dsn = required("HARNESS_TEST_DATABASE_URL")
    model_script = required("INT4D_MODEL_SCRIPT")
    artifact_root = required("INT4D_ARTIFACT_ROOT")
    reset_postgres_schema(dsn)
    with MigrationRunner(dsn) as runner:
        runner.apply()

    overrides = {
        "HARNESS_ARTIFACT_ROOT": artifact_root,
        "HARNESS_TEST_MODEL_SCRIPT": model_script,
    }
    first = start_worker(dsn, overrides)
    replacement = None
    run_id = submit(dsn, task("workflow_model_executor.yaml"))
    try:
        def durable_then_inflight() -> bool | None:
            types = [item.event.event_type for item in events(dsn, run_id)]
            completed = types.count(EventType.CAPABILITY_COMPLETED)
            dispatched = types.count(EventType.CAPABILITY_DISPATCHED)
            return True if completed >= 1 and dispatched >= 2 else None

        wait_for(durable_then_inflight, timeout=30)
        first.kill_group()
        replacement = start_worker(dsn, overrides)
        terminal = wait_for_terminal(dsn, run_id, timeout=75)
        stored = events(dsn, run_id)
        completions = [
            item.event.payload
            for item in stored
            if item.event.event_type is EventType.CAPABILITY_COMPLETED
        ]
        print("INT4D_WORKER_PROBE " + json.dumps({
            "runId": run_id,
            "terminalState": terminal.state.value,
            "outcome": terminal.outcome.value if terminal.outcome else None,
            "killSignal": "SIGKILL",
            "durableBeforeKill": True,
            "completionRows": len(completions),
        }, sort_keys=True))
    finally:
        first.kill_group()
        if replacement is not None:
            replacement.stop()


def required(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"{name} is required")
    return str(Path(value)) if name != "HARNESS_TEST_DATABASE_URL" else value


if __name__ == "__main__":
    main()
