#!/usr/bin/env bash
set -euo pipefail

TASK=""
MODELS="qwen3.5:cloud,kimi-k2.5:cloud"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --task)
      TASK="$2"
      shift 2
      ;;
    --models)
      MODELS="$2"
      shift 2
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

if [[ -z "${TASK}" ]]; then
  echo "--task is required" >&2
  exit 1
fi

IFS=',' read -r -a model_array <<< "${MODELS}"
for model in "${model_array[@]}"; do
  echo "== Running Hermes with model ${model}"
  docker compose --env-file .env.prod -f ops/compose.yml -f ops/compose.prod.yml -p avg \
    exec hermes /opt/hermes/.venv/bin/hermes chat \
    --provider ollama-cloud \
    -m "${model}" \
    -q "${TASK}"
done
