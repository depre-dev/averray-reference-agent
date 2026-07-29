#!/usr/bin/env bash
# Shared evidence verifier for the supervised green path. Read-only.
set -euo pipefail

: "${CEREMONY_ROOT:?CEREMONY_ROOT is required}"
: "${REFERENCE_CHECKOUT:?REFERENCE_CHECKOUT is required}"
: "${GREEN_INTENDED_RUN_ID:?GREEN_INTENDED_RUN_ID is required}"

_int2_work_item="${GREEN_WORK_ITEM:-ceremony-lint-format-green-003}"
_int2_evidence="$CEREMONY_ROOT/evidence/$_int2_work_item"
node "$REFERENCE_CHECKOUT/scripts/ceremony/int2-evidence.mjs" verify \
  --case green \
  --work-item "$_int2_work_item" \
  --run-id "$GREEN_INTENDED_RUN_ID" \
  --evidence-dir "$_int2_evidence"
echo "Verified green evidence: $_int2_evidence"
