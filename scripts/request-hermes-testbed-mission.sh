#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'EOF'
Usage:
  scripts/request-hermes-testbed-mission.sh <target-url> [goal]

Environment:
  MONITOR_URL=http://127.0.0.1:8790
  MONITOR_TOKEN=<optional monitor bearer token>
  REQUESTER=<agent name, default current user>
  AGENT_NAME=Hermes
  ALLOW_TEST_MUTATIONS=true|false
  FRESH_MEMORY=true|false
  MAX_BROWSER_STEPS=80
  MAX_MINUTES=20

Examples:
  scripts/request-hermes-testbed-mission.sh https://testbed.averray.com \
    "Try the main onboarding flow like a new outside agent."

  MONITOR_TOKEN=... ALLOW_TEST_MUTATIONS=true \
    scripts/request-hermes-testbed-mission.sh https://testbed.averray.com
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

target_url="${1:-${TARGET_URL:-}}"
if [[ -z "${target_url}" ]]; then
  usage
  exit 64
fi

monitor_url="${MONITOR_URL:-http://127.0.0.1:8790}"
requester="${REQUESTER:-${USER:-agent}}"
agent_name="${AGENT_NAME:-Hermes}"
goal="${2:-${GOAL:-Test the page like a new outside agent and return a structured report.}}"
allow_test_mutations="${ALLOW_TEST_MUTATIONS:-false}"
fresh_memory="${FRESH_MEMORY:-true}"
max_browser_steps="${MAX_BROWSER_STEPS:-80}"
max_minutes="${MAX_MINUTES:-20}"

payload="$(
  jq -n \
    --arg requester "${requester}" \
    --arg targetUrl "${target_url}" \
    --arg goal "${goal}" \
    --arg agentName "${agent_name}" \
    --argjson allowTestMutations "${allow_test_mutations}" \
    --argjson freshMemory "${fresh_memory}" \
    --argjson maxBrowserSteps "${max_browser_steps}" \
    --argjson maxMinutes "${max_minutes}" \
    '{
      requester: $requester,
      targetUrl: $targetUrl,
      goal: $goal,
      agentName: $agentName,
      allowTestMutations: $allowTestMutations,
      freshMemory: $freshMemory,
      maxBrowserSteps: $maxBrowserSteps,
      maxMinutes: $maxMinutes
    }'
)"

headers=(-H "content-type: application/json")
if [[ -n "${MONITOR_TOKEN:-}" ]]; then
  headers+=(-H "authorization: Bearer ${MONITOR_TOKEN}")
fi

curl -fsS -X POST "${monitor_url%/}/monitor/testbed-missions" \
  "${headers[@]}" \
  -d "${payload}" \
  | jq '{ok, requester, missionId:.run.id, status:.run.status, targetUrl:.run.targetUrl, runner, nextStep, detailUrl:("/monitor/testbed-missions/" + .run.id)}'
