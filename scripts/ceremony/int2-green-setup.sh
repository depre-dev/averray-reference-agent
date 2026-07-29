#!/usr/bin/env bash
# INT-2 §2.6 mechanical setup. Source it; human approval remains manual.
set -uo pipefail

ok() { echo "  ✓ $*"; }
fail() { echo "  ✗ $*" >&2; }
die() { fail "$*"; return 1; }

_int2_green_setup() {
  for _int2_name in CEREMONY_ROOT REFERENCE_CHECKOUT HARNESS_CHECKOUT HARNESS_BIN; do
    eval "_int2_value=\${${_int2_name}:-}"
    [ -n "$_int2_value" ] \
      || { die "$_int2_name is not set; source int2-bringup.sh"; return 1; }
  done
  pgrep -f "harness worker" >/dev/null 2>&1 \
    && { die "a Harness worker is already running; stop it first"; return 1; }
  pgrep -f "$REFERENCE_CHECKOUT/services/harness-dispatcher/dist/index.js" \
    >/dev/null 2>&1 \
    && { die "dispatcher is running; stop it before setup"; return 1; }
  export HARNESS_DISPATCH_ENABLED=false
  unset HARNESS_DISPATCH_DEP_CACHE_DIR
  mkdir -p "$CEREMONY_ROOT/evidence"

  node "$REFERENCE_CHECKOUT/scripts/ceremony/int2-evidence.mjs" \
    preflight-pair --repository-root "$REFERENCE_CHECKOUT" \
    > "$CEREMONY_ROOT/evidence/scripted-pair-preflight.json" \
    || { die "controlled-pair preflight failed"; return 1; }

  _int2_source="$REFERENCE_CHECKOUT/test/fixtures/agent-integration/ceremony/lint-format-green.jsonl"
  export GREEN_MODEL_SCRIPT="$CEREMONY_ROOT/lint-format-green.jsonl"
  cp "$_int2_source" "$GREEN_MODEL_SCRIPT"
  shasum -a 256 "$_int2_source" "$GREEN_MODEL_SCRIPT" \
    > "$CEREMONY_ROOT/evidence/lint-format-green-script.sha256"
  _int2_a="$(sed -n '1s/ .*//p' "$CEREMONY_ROOT/evidence/lint-format-green-script.sha256")"
  _int2_b="$(sed -n '2s/ .*//p' "$CEREMONY_ROOT/evidence/lint-format-green-script.sha256")"
  [ "$_int2_a" = "$_int2_b" ] \
    || { die "committed and staged model-script hashes differ"; return 1; }

  export HARNESS_TEST_MODEL_SCRIPT="$GREEN_MODEL_SCRIPT"
  export GREEN_WORK_ITEM="${GREEN_WORK_ITEM:-ceremony-lint-format-green-003}"
  ok "green script staged and preflighted; worker may now be started"
  return 0
}

if ! _int2_green_setup; then
  unset HARNESS_TEST_MODEL_SCRIPT 2>/dev/null
  return 1 2>/dev/null || exit 1
fi

echo "Next: propose, inspect containment, approve once through harness-pilot, then enable dispatch."
