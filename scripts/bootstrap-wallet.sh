#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ROOT_DIR}/.env.prod"

if [[ -f "${ENV_FILE}" ]]; then
  echo "${ENV_FILE} already exists; refusing to overwrite secrets." >&2
  exit 1
fi

node --input-type=module <<'NODE' > "${ENV_FILE}"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { randomUUID } from "node:crypto";

const privateKey = generatePrivateKey();
const account = privateKeyToAccount(privateKey);

console.log(`HERMES_IMAGE=nousresearch/hermes-agent@sha256:8811f1809971ac558f8d5e311e22fe73dc2944616dda7295c98acb6028f9df08`);
console.log(`POSTGRES_USER=avg_agent`);
console.log(`POSTGRES_PASSWORD=${randomUUID().replaceAll("-", "")}`);
console.log(`POSTGRES_DB=avg_agent`);
console.log(`DATABASE_URL=postgres://avg_agent:REPLACE_PASSWORD@postgres:5432/avg_agent`);
console.log(`AVERRAY_API_BASE_URL=https://api.averray.com`);
console.log(`AVERRAY_APP_BASE_URL=https://app.averray.com`);
console.log(`AGENT_WALLET_PRIVATE_KEY=${privateKey}`);
console.log(`AGENT_WALLET_ADDRESS=${account.address}`);
console.log(`OLLAMA_API_KEY=`);
console.log(`OLLAMA_BASE_URL=https://ollama.com/api`);
console.log(`HERMES_DEFAULT_MODEL=qwen3.5:cloud`);
console.log(`HERMES_COMPARISON_MODEL=kimi-k2.5:cloud`);
console.log(`SLACK_WEBHOOK_URL=`);
console.log(`TRACE_HTTP_PORT=8789`);
console.log(`HALT_FILE=/data/HALT`);
NODE

password="$(grep '^POSTGRES_PASSWORD=' "${ENV_FILE}" | cut -d= -f2)"
perl -0pi -e "s/REPLACE_PASSWORD/${password}/g" "${ENV_FILE}"
chmod 600 "${ENV_FILE}"

echo "Wrote ${ENV_FILE} with mode 600."
grep '^AGENT_WALLET_ADDRESS=' "${ENV_FILE}"
