#!/usr/bin/env bash
#
# Upgrade Hermes to a pinned image tag — snapshot first, two checks after.
#
# WHY THIS EXISTS: we sat on v0.18.0 for a month because every candidate release
# was "too new to trust". That is a policy with no exit condition — every release
# is two days old at some point, and every one of them has open bugs — so it
# resolves to never upgrading, while the eventual jump grows and gets harder to
# debug. The v0.19.1 attempt already cost a day chasing a root cause that turned
# out to be wrong (see HERMES_UPGRADE_v020.md §1).
#
# The fix is not more waiting. It is making the upgrade CHEAP TO ABORT, so it can
# be attempted on evidence rather than on confidence. Release age is a proxy for
# risk; a restorable snapshot and two narrow checks are a measurement of it.
#
# WHAT MAKES THIS SAFE TO JUST TRY:
#   • The board does not depend on Hermes. The money path keeps running through
#     a failed upgrade, and #657 already made the deploy gate advisory.
#   • Nothing about Hermes is forked. We ship 4 files (2 config, 1 plugin, 1
#     skill) against a stock upstream image, so a rollback is a tag, not a
#     migration.
#   • The ONE real unknown is on-disk state: /opt/data holds memory.db, sessions
#     and plugins, both versions carry SQLite schema handling, and v0.20.0 adds
#     session_recovery.py. If the new version migrates that volume, an older
#     image may not read it back. That is what the snapshot is for — it turns
#     the unknown into a controlled fact instead of a reason to postpone.
#
# Usage, from the repo root on the VPS:
#   ops/upgrade-hermes.sh v2026.8.3          # snapshot, bump, recreate, check
#   ops/upgrade-hermes.sh --check-only       # run the two checks against today
#
# This script does NOT roll back on its own. A failed check prints the exact
# revert commands and stops; humans own deploy (invariant #1), and an automatic
# restore of a data volume is not a decision a script should take.
set -euo pipefail

cd "$(dirname "$0")/.."

PROJECT=avg
ENV_FILE=.env.prod
HERMES_VOLUME="${PROJECT}_avg-hermes"
CHECK_ONLY=false
TARGET=""

for arg in "$@"; do
  case "$arg" in
    --check-only) CHECK_ONLY=true ;;
    -*) echo "unknown flag: $arg" >&2; exit 2 ;;
    *) TARGET="$arg" ;;
  esac
done

[ -f "$ENV_FILE" ] || { echo "ERROR: $ENV_FILE not found — run from the repo root on the VPS." >&2; exit 1; }

# The command-center profile is REQUIRED: hermes-gateway lives behind it, and it
# is the service that serves the Session API on 8642. Without the profile
# compose silently matches nothing and reports success having done nothing —
# the same shape as the `compose restart hermes-gateway` no-op in
# deploy-monitor.sh.
COMPOSE=(docker compose -p "$PROJECT" --env-file "$ENV_FILE"
  --profile command-center
  -f ops/compose.yml
  -f ops/compose.prod.yml
  -f ops/compose.command-center.yml
  -f ops/compose.cloudflare-access.yml)

current_tag() {
  grep '^HERMES_IMAGE=' "$ENV_FILE" | tail -1 | sed 's/^HERMES_IMAGE=//'
}

# ── THE TWO CHECKS ────────────────────────────────────────────────────────
#
# Narrow on purpose. These are the only two things a Hermes version bump has
# ever broken for us, and a check that tests everything is a check nobody runs.

# CHECK 1 — does the Session API actually BIND and answer?
#
# This is the v0.19.1 failure, and /health is NOT sufficient to detect it: on
# v0.19.1 the gateway reported healthy while nothing listened on 8642 and the
# four session endpoints had never returned 201. So this creates a real session.
#
# The key is read from the env file and passed in a header. It is never echoed;
# `set -x` is deliberately not used anywhere in this script.
check_session_api() {
  local port key code
  port="$(grep '^HERMES_GATEWAY_PORT=' "$ENV_FILE" | tail -1 | sed 's/^HERMES_GATEWAY_PORT=//')"
  port="${port:-8642}"
  key="$(grep '^HERMES_GATEWAY_API_KEY=' "$ENV_FILE" | tail -1 | sed 's/^HERMES_GATEWAY_API_KEY=//')"
  if [ -z "$key" ]; then
    echo "  CHECK 1 SKIPPED: HERMES_GATEWAY_API_KEY is unset — cannot authenticate." >&2
    return 1
  fi
  # `|| echo 000` here would CONCATENATE with curl's own "000" on a refused
  # connection, yielding "000000", missing the case below, and reporting
  # "bound, but not serving sessions" when nothing was listening at all. Caught
  # by running this against a box with no gateway — a check that misnames the
  # failure is worse than no check, and this one exists to name exactly that
  # failure.
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 \
    -X POST "http://127.0.0.1:${port}/api/sessions" \
    -H "Authorization: Bearer ${key}" \
    -H 'Content-Type: application/json' \
    -d '{}' 2>/dev/null)" || true
  [ -n "$code" ] || code=000
  case "$code" in
    200|201)
      echo "  CHECK 1 PASS: POST /api/sessions -> $code (the Session API binds and answers)" ;;
    000)
      echo "  CHECK 1 FAIL: nothing listening on 127.0.0.1:${port} — this is the v0.19.1 symptom." >&2
      return 1 ;;
    *)
      echo "  CHECK 1 FAIL: POST /api/sessions -> $code (bound, but not serving sessions)." >&2
      return 1 ;;
  esac
}

# CHECK 2 — did the MCP tool surface survive?
#
# v0.20.0 introduces lazy MCP startup from a fingerprint-keyed on-disk
# tool-schema cache. Our five MCP servers are NOT in anyone's image — they live
# in the avg-app volume, which mcp-bundle rewrites on every deploy — and a
# consumer registers its tool list ONCE at startup. That combination already bit
# us on 2026-08-02, when hermes-gateway kept advertising a stale list and
# answered an operator's health question from the wrong tool.
#
# A CACHE keyed by fingerprint could fix that, or could add a second stale
# layer. This does not guess: it prints what the container reports so the
# operator can compare it against the previous run. Reported, not asserted —
# the same honesty the v0.18 smoke used for undocumented shapes.
check_mcp_tools() {
  echo "  CHECK 2 (report, not verdict) — MCP registration lines from the gateway:"
  "${COMPOSE[@]}" logs --tail 400 hermes-gateway 2>/dev/null \
    | grep -iE 'mcp|tool.*(cache|schema|registered)' | tail -12 | sed 's/^/    /' \
    || echo "    (no MCP lines in the last 400 log lines — worth a closer look)"
}

run_checks() {
  echo
  echo "── checks ──────────────────────────────────────────────────────────"
  local failed=false
  check_session_api || failed=true
  check_mcp_tools
  echo
  [ "$failed" = false ]
}

if [ "$CHECK_ONLY" = true ]; then
  echo "running checks against the CURRENT deployment ($(current_tag))"
  run_checks || exit 1
  exit 0
fi

[ -n "$TARGET" ] || { echo "ERROR: give a target image tag, e.g. ops/upgrade-hermes.sh v2026.8.3" >&2; exit 2; }

FROM_IMAGE="$(current_tag)"
TO_IMAGE="nousresearch/hermes-agent:${TARGET#nousresearch/hermes-agent:}"
[ -n "$FROM_IMAGE" ] || { echo "ERROR: HERMES_IMAGE not set in $ENV_FILE." >&2; exit 1; }

echo "Hermes upgrade"
echo "  from : $FROM_IMAGE"
echo "  to   : $TO_IMAGE"
echo

# ── 1. SNAPSHOT ───────────────────────────────────────────────────────────
#
# Before anything else, and FATAL if it fails. This is the whole reason the
# upgrade is cheap to attempt: without a restorable copy of /opt/data, a version
# that migrates the volume turns "revert the tag" into "lose the agent's memory
# and session history". The snapshot is what converts an unknown into a fact.
#
# Named for the version it came FROM, because that is the version it can be
# restored into. alpine:3.20 is already pinned in ops/compose.yml, so it is
# local on any box being deployed to.
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
SNAPSHOT="hermes-data-${FROM_IMAGE##*:}-${STAMP}.tgz"
echo "snapshotting ${HERMES_VOLUME} -> ${SNAPSHOT}"
docker run --rm -v "${HERMES_VOLUME}:/d:ro" -v "$PWD:/backup" alpine:3.20 \
  tar czf "/backup/${SNAPSHOT}" -C /d . \
  || { echo "ERROR: snapshot failed — NOT upgrading. Nothing has changed." >&2; exit 1; }
ls -lh "$SNAPSHOT" | sed 's/^/  /'
echo

# ── 2. PIN THE NEW TAG ────────────────────────────────────────────────────
#
# Written to .env.prod, not passed as a one-shot override: an override reverts
# on the next deploy, which would mean the upgrade worked today and silently
# undid itself later. Same decay the Bank lane's network attachment had.
cp "$ENV_FILE" "${ENV_FILE}.bak.${STAMP}"
sed -i "s|^HERMES_IMAGE=.*|HERMES_IMAGE=${TO_IMAGE}|" "$ENV_FILE"
# Verify the edit landed rather than trusting sed — a silently no-op'd
# replacement would deploy the OLD image while reporting an upgrade.
[ "$(current_tag)" = "$TO_IMAGE" ] || {
  echo "ERROR: $ENV_FILE still reads '$(current_tag)' — restoring and stopping." >&2
  mv "${ENV_FILE}.bak.${STAMP}" "$ENV_FILE"
  exit 1
}
echo "pinned HERMES_IMAGE=${TO_IMAGE} (backup: ${ENV_FILE}.bak.${STAMP})"

# ── 3. RECREATE ONLY THE TWO HERMES SERVICES ──────────────────────────────
#
# --no-deps is deliberate, for the reason deploy-monitor.sh gives: hermes
# depends on hermes-permissions, a one-shot that runs `chmod -R 0777 /opt/data`.
# Re-running it would re-open the data volume that Hermes spends its life
# securing to 0700 — a permissions change nobody asked a version bump to make.
# skills-sync is also pulled in by those deps and the skill tree does not change
# with an image tag.
echo
echo "recreating hermes + hermes-gateway on ${TO_IMAGE}"
"${COMPOSE[@]}" pull hermes hermes-gateway
"${COMPOSE[@]}" up -d --no-deps hermes hermes-gateway

# Give the gateway a moment to bind before asserting it did not.
echo "waiting for the gateway to settle"
for _ in $(seq 1 30); do
  if "${COMPOSE[@]}" ps hermes-gateway 2>/dev/null | grep -q healthy; then break; fi
  sleep 2
done

# ── 4. CHECK, AND MAKE THE ABORT EXACT ────────────────────────────────────
if run_checks; then
  echo "UPGRADE OK — ${FROM_IMAGE##*:} -> ${TO_IMAGE##*:}"
  echo
  echo "Keep ${SNAPSHOT} until you are satisfied; delete it once the version has run a day."
else
  echo >&2
  echo "UPGRADE FAILED ITS CHECKS. Nothing has been rolled back automatically." >&2
  echo >&2
  echo "To revert — tag first, and restore the volume ONLY if the new version" >&2
  echo "migrated it (a clean revert on the tag alone usually just works):" >&2
  echo >&2
  echo "  mv ${ENV_FILE}.bak.${STAMP} ${ENV_FILE}" >&2
  echo "  ${COMPOSE[*]} up -d --no-deps hermes hermes-gateway" >&2
  echo >&2
  echo "  # only if the agent's memory/sessions came back wrong:" >&2
  echo "  ${COMPOSE[*]} stop hermes hermes-gateway" >&2
  echo "  docker run --rm -v ${HERMES_VOLUME}:/d -v \"\$PWD:/backup\" alpine:3.20 \\" >&2
  echo "    sh -c 'rm -rf /d/* /d/..?* 2>/dev/null; tar xzf /backup/${SNAPSHOT} -C /d'" >&2
  echo "  ${COMPOSE[*]} up -d --no-deps hermes hermes-gateway" >&2
  exit 1
fi
