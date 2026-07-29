#!/usr/bin/env bash
# Shared evidence verifier for the intentional verification failure. Read-only.
set -euo pipefail

: "${CEREMONY_ROOT:?CEREMONY_ROOT is required}"
: "${REFERENCE_CHECKOUT:?REFERENCE_CHECKOUT is required}"
: "${NEG_INTENDED_RUN_ID:?NEG_INTENDED_RUN_ID is required}"

_int2_work_item="${NEG_WORK_ITEM:-ceremony-lint-format-red-003}"
_int2_evidence="$CEREMONY_ROOT/evidence/$_int2_work_item"
node "$REFERENCE_CHECKOUT/scripts/ceremony/int2-evidence.mjs" verify \
  --case negative \
  --work-item "$_int2_work_item" \
  --run-id "$NEG_INTENDED_RUN_ID" \
  --evidence-dir "$_int2_evidence"
echo "Verified negative evidence: $_int2_evidence"
