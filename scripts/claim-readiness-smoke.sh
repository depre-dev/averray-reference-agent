#!/usr/bin/env bash
set -euo pipefail

MODEL="${HERMES_DEFAULT_MODEL:-}"
ENV_FILE=".env.prod"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --model)
      MODEL="$2"
      shift 2
      ;;
    --env-file)
      ENV_FILE="$2"
      shift 2
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "${ENV_FILE} is missing. Create it from ops/.env.example or scripts/bootstrap-wallet.sh first." >&2
  exit 1
fi

if [[ -z "${MODEL}" ]]; then
  MODEL="$(grep '^HERMES_DEFAULT_MODEL=' "${ENV_FILE}" | tail -n 1 | cut -d= -f2- || true)"
fi
MODEL="${MODEL:-deepseek-v4-pro:cloud}"

if ! grep -Eq '^AGENT_WALLET_PRIVATE_KEY=0x[0-9a-fA-F]{64}$' "${ENV_FILE}"; then
  echo "AGENT_WALLET_PRIVATE_KEY is missing or malformed in ${ENV_FILE}." >&2
  echo "Use a testnet-only key. Do not paste the private key into chat or logs." >&2
  exit 1
fi

if grep -q '^AGENT_WALLET_ADDRESS=' "${ENV_FILE}"; then
  grep '^AGENT_WALLET_ADDRESS=' "${ENV_FILE}"
else
  echo "AGENT_WALLET_ADDRESS is not set; wallet_status should still derive the address from the private key."
fi

if ! docker compose --env-file "${ENV_FILE}" -f ops/compose.yml -f ops/compose.prod.yml -p avg \
  exec -T hermes sh -lc 'printf "%s" "${AGENT_WALLET_PRIVATE_KEY:-}" | grep -Eq "^0x[0-9a-fA-F]{64}$"'; then
  echo "Hermes container does not see AGENT_WALLET_PRIVATE_KEY." >&2
  echo "Recreate Hermes after env changes, then rerun this smoke:" >&2
  echo "  docker compose --env-file ${ENV_FILE} -f ops/compose.yml -f ops/compose.prod.yml -p avg up -d --build --force-recreate hermes" >&2
  exit 1
fi

if ! docker compose --env-file "${ENV_FILE}" -f ops/compose.yml -f ops/compose.prod.yml -p avg \
  exec -T hermes sh -lc 'set -a && . /config-runtime/reference-agent.env && set +a && printf "%s" "${AGENT_WALLET_PRIVATE_KEY:-}" | grep -Eq "^0x[0-9a-fA-F]{64}$"'; then
  echo "Hermes MCP launcher cannot read a valid AGENT_WALLET_PRIVATE_KEY from /config-runtime/reference-agent.env." >&2
  echo "Recreate Hermes after pulling the latest compose/config changes, then rerun this smoke:" >&2
  echo "  docker compose --env-file ${ENV_FILE} -f ops/compose.yml -f ops/compose.prod.yml -p avg up -d --build --force-recreate hermes" >&2
  exit 1
fi

PROMPT=$(cat <<'PROMPT'
Use the configured Averray reference MCP tools only for this claim-readiness smoke. Do not use browser, shell, or Python fallback tools.

Goal:
1. Check wallet readiness with wallet_status and wallet_export_address.
2. Check policy readiness with policy_get_budget.
3. List open Wikipedia jobs compactly with averray_list_jobs using category/source/state filters and a small limit.
4. Inspect one Wikipedia job definition with averray_get_definition.
5. Run policy_check_claim for that job using:
   - taskType: job.agentContext.taskType if present, otherwise job.source.taskType.
   - verifierMode: job.verifierMode.
   - rewardUsd/estimatedCostUsd: 0 unless the definition provides USD estimates.
6. Report whether this agent appears ready to claim a Wikipedia job, and list any blockers or uncertainties.

Safety boundary:
- Do NOT call averray_claim.
- Do NOT call averray_submit.
- Do NOT request approval.
- Do NOT edit Wikipedia.
- Do NOT reveal or ask for private keys.
- Stop after the readiness report.
PROMPT
)

docker compose --env-file "${ENV_FILE}" -f ops/compose.yml -f ops/compose.prod.yml -p avg \
  exec hermes /opt/hermes/.venv/bin/hermes chat \
  --provider ollama-cloud \
  -m "${MODEL}" \
  -q "${PROMPT}"
