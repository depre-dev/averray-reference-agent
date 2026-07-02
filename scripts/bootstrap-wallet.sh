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

const agentPrivateKey = generatePrivateKey();
const adminPrivateKey = generatePrivateKey();
const verifierPrivateKey = generatePrivateKey();
const agentAccount = privateKeyToAccount(agentPrivateKey);
const adminAccount = privateKeyToAccount(adminPrivateKey);
const verifierAccount = privateKeyToAccount(verifierPrivateKey);

console.log(`HERMES_IMAGE=nousresearch/hermes-agent:v2026.6.19`);
console.log(`POSTGRES_USER=avg_agent`);
console.log(`POSTGRES_PASSWORD=${randomUUID().replaceAll("-", "")}`);
console.log(`POSTGRES_DB=avg_agent`);
console.log(`DATABASE_URL=postgres://avg_agent:REPLACE_PASSWORD@postgres:5432/avg_agent`);
console.log(`AVERRAY_API_BASE_URL=https://api.averray.com`);
console.log(`AVERRAY_APP_BASE_URL=https://app.averray.com`);
console.log(`AGENT_WALLET_PRIVATE_KEY=${agentPrivateKey}`);
console.log(`AGENT_WALLET_ADDRESS=${agentAccount.address}`);
console.log(`TEST_WALLET_SIGNER_ENABLED=0`);
console.log(`TEST_WALLET_SIGNER_ENVIRONMENT=testnet`);
console.log(`TEST_WALLET_SIGNER_PORT=8791`);
console.log(`TEST_WALLET_SIGNER_REFRESH_SKEW_SECONDS=60`);
console.log(`TEST_WALLET_SIGNER_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium`);
console.log(`AUTH_TOKEN_TTL_SECONDS=3600`);
console.log(`TEST_WALLET_AGENT_PRIVATE_KEY=${agentPrivateKey}`);
console.log(`TEST_WALLET_AGENT_ADDRESS=${agentAccount.address}`);
console.log(`TEST_WALLET_ADMIN_PRIVATE_KEY=${adminPrivateKey}`);
console.log(`TEST_WALLET_ADMIN_ADDRESS=${adminAccount.address}`);
console.log(`TEST_WALLET_VERIFIER_PRIVATE_KEY=${verifierPrivateKey}`);
console.log(`TEST_WALLET_VERIFIER_ADDRESS=${verifierAccount.address}`);
console.log(`OLLAMA_API_KEY=`);
console.log(`OLLAMA_BASE_URL=https://ollama.com/v1`);
console.log(`HERMES_DEFAULT_MODEL=glm-5.2:cloud`);
console.log(`HERMES_MONITOR_REPLY_MODEL=glm-5.2:cloud`);
console.log(`HERMES_COMPARISON_MODEL=qwen3.5:cloud`);
console.log(`SLACK_WEBHOOK_URL=`);
console.log(`TRACE_HTTP_PORT=8789`);
console.log(`HALT_FILE=/data/HALT`);
NODE

password="$(grep '^POSTGRES_PASSWORD=' "${ENV_FILE}" | cut -d= -f2)"
perl -0pi -e "s/REPLACE_PASSWORD/${password}/g" "${ENV_FILE}"
chmod 600 "${ENV_FILE}"

echo "Wrote ${ENV_FILE} with mode 600."
grep '^AGENT_WALLET_ADDRESS=' "${ENV_FILE}"
grep '^TEST_WALLET_.*_ADDRESS=' "${ENV_FILE}"
