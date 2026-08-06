#!/usr/bin/env bash
# INT-2 §1 mechanical bring-up. Source this file from bash or zsh.
# It never enables dispatch, never touches production, and attaches
# non-destructively when both named disposable databases are already healthy.
set -uo pipefail

ok() { echo "  ✓ $*"; }
fail() { echo "  ✗ $*" >&2; }
die() { fail "$*"; return 1; }

_int2_bringup() {
  echo "=== INT-2 §1 bring-up ==="
  export REFERENCE_CHECKOUT="${REFERENCE_CHECKOUT:-$PWD}"
  export CEREMONY_ROOT="${CEREMONY_ROOT:-${CR:-}}"
  [ -n "$CEREMONY_ROOT" ] \
    || { die "CEREMONY_ROOT is required; create it per runbook §1"; return 1; }
  export CR="$CEREMONY_ROOT"
  export HARNESS_CHECKOUT="${HARNESS_CHECKOUT:-$CEREMONY_ROOT/agent-harness}"
  export HARNESS_BIN="${HARNESS_BIN:-$HARNESS_CHECKOUT/.venv/bin/harness}"

  [ -d "$CEREMONY_ROOT" ] \
    || { die "ceremony root is absent: $CEREMONY_ROOT"; return 1; }
  [ -e "$REFERENCE_CHECKOUT/.git" ] \
    || { die "reference checkout is not a Git checkout"; return 1; }
  [ -x "$HARNESS_BIN" ] \
    || { die "Harness executable is absent: $HARNESS_BIN"; return 1; }
  [ -d "$CEREMONY_ROOT/profiles/coding-change-pilot" ] \
    || { die "pinned coding-change-pilot profile is absent"; return 1; }

  _int2_pin="3355f4906864b0f0e0fe5fd5eb5220172e174206"
  _int2_head="$(git -C "$HARNESS_CHECKOUT" rev-parse HEAD 2>/dev/null)" \
    || { die "cannot read Harness revision"; return 1; }
  if [ "$_int2_head" != "$_int2_pin" ]; then
    [ -z "$(git -C "$HARNESS_CHECKOUT" status --porcelain)" ] \
      || { die "Harness checkout is dirty; refusing to change its pin"; return 1; }
    git -C "$HARNESS_CHECKOUT" fetch -q origin \
      || { die "cannot fetch the Harness pin"; return 1; }
    git -C "$HARNESS_CHECKOUT" checkout -q --detach "$_int2_pin" \
      || { die "cannot check out the Harness pin"; return 1; }
    (
      cd "$HARNESS_CHECKOUT" && uv sync --frozen
    ) || { die "uv sync failed after re-pinning Harness"; return 1; }
  fi
  [ "$(git -C "$HARNESS_CHECKOUT" rev-parse HEAD)" = "$_int2_pin" ] \
    || { die "Harness pin assertion failed"; return 1; }
  "$HARNESS_BIN" --help >/dev/null 2>&1 \
    || { die "Harness CLI cannot import after uv sync"; return 1; }
  ok "Harness pinned and CLI healthy (${_int2_pin:0:12})"

  _int2_attach=0
  _int2_harness_exists=0
  _int2_reference_exists=0
  docker container inspect int2-harness-postgres >/dev/null 2>&1 \
    && _int2_harness_exists=1
  docker container inspect int2-reference-postgres >/dev/null 2>&1 \
    && _int2_reference_exists=1
  if docker exec int2-harness-postgres \
      pg_isready -U postgres -d harness_ceremony >/dev/null 2>&1 \
    && docker exec int2-reference-postgres \
      pg_isready -U postgres -d reference_ceremony >/dev/null 2>&1; then
    _int2_attach=1
    ok "ATTACH mode: both existing databases are healthy; no data recreated"
  fi

  if [ "$_int2_attach" = "0" ]; then
    if [ "$_int2_harness_exists" = "1" ] \
      || [ "$_int2_reference_exists" = "1" ]; then
      die "a named ceremony database already exists but the pair is not healthy; refusing destructive re-creation"
      return 1
    fi
    docker run --rm --detach --name int2-harness-postgres \
      --publish 127.0.0.1:55432:5432 \
      --env POSTGRES_PASSWORD=harness-ceremony \
      --env POSTGRES_DB=harness_ceremony \
      postgres:18 >/dev/null \
      || { die "cannot start the Harness database"; return 1; }
    docker run --rm --detach --name int2-reference-postgres \
      --publish 127.0.0.1:55433:5432 \
      --env POSTGRES_PASSWORD=reference-ceremony \
      --env POSTGRES_DB=reference_ceremony \
      postgres:16-alpine >/dev/null \
      || { die "cannot start the reference database"; return 1; }
    for _int2_i in $(seq 1 60); do
      docker exec int2-harness-postgres \
        pg_isready -U postgres -d harness_ceremony >/dev/null 2>&1 && break
      sleep 1
    done
    for _int2_i in $(seq 1 60); do
      docker exec int2-reference-postgres \
        pg_isready -U postgres -d reference_ceremony >/dev/null 2>&1 && break
      sleep 1
    done
    docker exec int2-harness-postgres \
      pg_isready -U postgres -d harness_ceremony >/dev/null 2>&1 \
      || { die "Harness database did not become ready"; return 1; }
    docker exec int2-reference-postgres \
      pg_isready -U postgres -d reference_ceremony >/dev/null 2>&1 \
      || { die "reference database did not become ready"; return 1; }
  fi

  export HARNESS_DATABASE_URL="postgresql://postgres:harness-ceremony@127.0.0.1:55432/harness_ceremony"
  export DATABASE_URL="postgresql://postgres:reference-ceremony@127.0.0.1:55433/reference_ceremony"

  if [ "$_int2_attach" = "0" ]; then
    (
      cd "$HARNESS_CHECKOUT" \
        && HARNESS_DATABASE_URL="$HARNESS_DATABASE_URL" \
          uv run harness db migrate
    ) >/dev/null \
      || { die "Harness migration failed"; return 1; }
    for _int2_migration in "$REFERENCE_CHECKOUT"/ops/migrations/*.sql; do
      docker exec -i int2-reference-postgres \
        psql -U postgres -d reference_ceremony \
          --set ON_ERROR_STOP=1 -q < "$_int2_migration" >/dev/null \
        || {
          die "reference migration failed: $(basename "$_int2_migration")"
          return 1
        }
    done
    ok "both disposable schemas migrated"
  fi

  if [ "$_int2_attach" = "1" ] \
    && [ -f "$REFERENCE_CHECKOUT/services/harness-dispatcher/dist/index.js" ]; then
    ok "dispatcher build already present in attach mode"
  else
    (
      cd "$REFERENCE_CHECKOUT" && npm ci && npm run build
    ) >/dev/null \
      || { die "reference dependency install/build failed"; return 1; }
    ok "reference dispatcher built"
  fi

  export HARNESS_PROFILES_ROOT="$CEREMONY_ROOT/profiles"
  export HARNESS_PROFILE_SHA256="$(
    shasum -a 256 \
      "$HARNESS_PROFILES_ROOT/coding-change-pilot/profile.yaml" |
      awk '{print $1}'
  )"
  export HARNESS_DISPATCH_ARTIFACT_DIR="$CEREMONY_ROOT/dispatch-artifacts"
  export HARNESS_DISPATCH_INTENT_DIR="$CEREMONY_ROOT/dispatch-intents"
  export HARNESS_DISPATCH_HEARTBEAT_PATH="$CEREMONY_ROOT/dispatcher-heartbeat.json"
  export HARNESS_DISPATCH_ALERTS_PATH="$CEREMONY_ROOT/dispatcher-alerts.jsonl"
  export HARNESS_DISPATCH_READ_TIMEOUT_MS=15000
  export HALT_FILE="$CEREMONY_ROOT/HALT"
  export POLICY_CONFIG_PATH="$REFERENCE_CHECKOUT/hermes/config/policy.yaml"
  export HERMES_DISPATCH_ALLOWED_REPOS="depre-dev/averray-reference-agent"
  export HARNESS_DISPATCH_ACTIVE_POLICY_VERSION="dispatch-policy-v1"
  export HARNESS_DISPATCH_ACTIVE_POLICY_HASH="$(
    cd "$REFERENCE_CHECKOUT" && node --input-type=module -e '
      const proposal = await import("./packages/averray-mcp/dist/agent-task-proposal.js");
      const policy = await import("./packages/averray-mcp/dist/dispatch-policy.js");
      const identity = await proposal.dispatchPolicyIdentity(
        policy.loadDispatchPolicyConfig(process.env),
        "dispatch-policy-v1",
      );
      process.stdout.write(identity.policyHash);
    '
  )" || { die "cannot derive the active dispatch policy identity"; return 1; }
  export HARNESS_DISPATCH_ENABLED=false
  unset HARNESS_DISPATCH_DEP_CACHE_DIR
  ok "ceremony environment exported; dispatch remains disabled"
  return 0
}

if ! _int2_bringup; then
  echo "BRING-UP FAILED; correct the reported cause and source again." >&2
  return 1 2>/dev/null || exit 1
fi

echo "Bring-up complete. Run a setup script; human propose/inspect/approve remains."
