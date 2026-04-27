#!/usr/bin/env bash
set -euo pipefail

RUN_ID="${1:-}"
if [[ -z "${RUN_ID}" ]]; then
  echo "usage: scripts/replay-run.sh <run_id>" >&2
  exit 1
fi

docker compose -p avg exec -T postgres psql "${DATABASE_URL:-postgres://avg_agent:avg_agent@postgres:5432/avg_agent}" \
  -c "select jsonb_pretty(jsonb_build_object('run', to_jsonb(r), 'toolCalls', coalesce(c.calls, '[]'::jsonb), 'receipts', coalesce(rc.receipts, '[]'::jsonb))) from runs r left join lateral (select jsonb_agg(to_jsonb(t) order by t.idx) calls from tool_calls t where t.run_id = r.id) c on true left join lateral (select jsonb_agg(to_jsonb(x)) receipts from receipts x where x.run_id = r.id) rc on true where r.id = '${RUN_ID}';"
