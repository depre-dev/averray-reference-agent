#!/bin/sh
set -eu

ENV_FILE="${MCP_ENV_FILE:-/config-runtime/reference-agent.env}"

if [ -r "${ENV_FILE}" ]; then
  set -a
  # shellcheck disable=SC1090
  . "${ENV_FILE}"
  set +a
fi

exec node "$@"
