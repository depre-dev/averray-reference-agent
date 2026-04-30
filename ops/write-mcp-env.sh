#!/bin/sh
set -eu

OUT_FILE="${1:-/mcp-env/reference-agent.env}"
TMP_FILE="${OUT_FILE}.tmp"

mkdir -p "$(dirname "${OUT_FILE}")"
umask 077
: > "${TMP_FILE}"

write_var() {
  name="$1"
  eval "value=\${${name}:-}"
  escaped="$(printf "%s" "${value}" | sed "s/'/'\\\\''/g")"
  printf "%s='%s'\n" "${name}" "${escaped}" >> "${TMP_FILE}"
}

for name in \
  DATABASE_URL \
  AVERRAY_API_BASE_URL \
  AGENT_WALLET_PRIVATE_KEY \
  OLLAMA_API_KEY \
  OLLAMA_BASE_URL \
  HERMES_DEFAULT_MODEL \
  HERMES_COMPARISON_MODEL \
  TRACE_HTTP_PORT \
  TRACE_HTTP_URL \
  POLICY_CONFIG_PATH \
  HALT_FILE \
  WALLET_NETWORK \
  SLACK_WEBHOOK_URL \
  LOG_LEVEL
do
  write_var "${name}"
done

chmod 0444 "${TMP_FILE}"
mv "${TMP_FILE}" "${OUT_FILE}"
