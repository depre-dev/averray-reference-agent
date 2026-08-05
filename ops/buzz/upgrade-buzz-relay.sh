#!/usr/bin/env bash
#
# Upgrade the Buzz relay stack to a DIGEST-pinned build of upstream main —
# snapshot first, checks after. Companion to ops/upgrade-hermes.sh; same
# policy: release age is a proxy for risk, a restorable snapshot plus narrow
# checks is a measurement of it.
#
# WHY MAIN AND NOT A RELEASE: upstream has cut exactly two relay releases ever
# (v0.1.1, v0.2.0 — 2026-07-10) while building ghcr.io/block/buzz:main on
# every merge and running :main in its own reference deploy. For this project,
# main IS the release channel; waiting for a v0.3.0 is a policy with no exit
# condition. The pin is BY DIGEST, so "what are we running" stays a fact and
# rollback is exact.
#
# WHY NOW: device pairing. relay-v0.2.0 cannot advertise pairing_relay_url in
# NIP-11, the desktop's legacy /pair fallback cannot pass the relay's NIP-42
# origin check (proven live 2026-08-05: "relay url mismatch" on every
# attempt), and the advertised-URL route needs the newer relay.
#
# Usage, from the repo root on the VPS:
#   ops/buzz/upgrade-buzz-relay.sh              # snapshot, pin, up, check
#   ops/buzz/upgrade-buzz-relay.sh --check-only # checks against what runs now
#
# Does NOT roll back on its own. A failed check prints the exact revert
# commands and stops — humans own deploy, and restoring a database is not a
# decision a script should take.
set -euo pipefail

BUZZ_DIR=/srv/buzz/deploy/compose
OVERLAY_DIR=/srv/averray-reference-agent/ops/buzz
ENV_FILE="$BUZZ_DIR/.env"
BACKUP_DIR=/srv/buzz/backups
CHECK_ONLY=false
[ "${1:-}" = "--check-only" ] && CHECK_ONLY=true

COMPOSE=(docker compose -f "$BUZZ_DIR/compose.yml"
  -f "$OVERLAY_DIR/compose.averray.yml"
  -f "$OVERLAY_DIR/compose.pairing.yml")

# ── CHECKS ────────────────────────────────────────────────────────────────
# Narrow on purpose: the three things this upgrade exists to change or must
# not break, each read from the LIVE system, never from a file.

check_nip11() {
  # The public NIP-11 is the relay's own statement of what it is. Post-upgrade
  # it must (a) no longer claim 0.2.0 and (b) advertise the pairing relay.
  local doc version pairing
  doc="$(curl -fsS -H 'Accept: application/nostr+json' https://buzz.averray.com --max-time 10)" || {
    echo "  CHECK 1 FAIL: NIP-11 unreachable via the tunnel." >&2; return 1; }
  version="$(printf '%s' "$doc" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("version",""))')"
  pairing="$(printf '%s' "$doc" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("pairing_relay_url",""))')"
  if [ "$version" = "0.2.0" ]; then
    echo "  CHECK 1 FAIL: relay still reports version 0.2.0 — the pin did not take." >&2; return 1
  fi
  if [ "$pairing" != "wss://pair.averray.com" ]; then
    echo "  CHECK 1 FAIL: NIP-11 pairing_relay_url is '${pairing:-<absent>}', expected wss://pair.averray.com." >&2
    return 1
  fi
  echo "  CHECK 1 PASS: relay version ${version}, pairing_relay_url advertised"
}

check_sidecar() {
  # The pairing relay must present ITSELF at its hostname: NIP-42's expected
  # URL derives from the tenant the Host header selects, so a wrong or missing
  # community here is tomorrow's "relay url mismatch".
  local doc
  doc="$(curl -fsS -H 'Accept: application/nostr+json' https://pair.averray.com --max-time 10)" || {
    echo "  CHECK 2 FAIL: pair.averray.com NIP-11 unreachable — is the tunnel route added?" >&2; return 1; }
  echo "  CHECK 2 PASS: pairing relay answers at its own hostname"
}

check_migrations() {
  # A migration error is the one failure that makes rollback lossy; it must be
  # looked for, not assumed absent.
  if docker logs buzz-prod-relay-1 --since 10m 2>&1 | grep -iE "migration.*(fail|error)" | head -3 | grep -q .; then
    echo "  CHECK 3 FAIL: migration errors in the relay log:" >&2
    docker logs buzz-prod-relay-1 --since 10m 2>&1 | grep -iE "migration.*(fail|error)" | head -3 | sed 's/^/    /' >&2
    return 1
  fi
  echo "  CHECK 3 PASS: no migration errors in the relay log"
}

run_checks() {
  echo; echo "── checks ──────────────────────────────────────────────────"
  local failed=false
  check_nip11 || failed=true
  check_sidecar || failed=true
  check_migrations || failed=true
  echo
  echo "MANUAL, in order — the checks above cannot see these:"
  echo "  · Buzz Desktop reconnects and #Ops history loads"
  echo "  · say 'hermes whats up' in #Ops and get an answer (NIP-OA path)"
  echo "  · monitor board OPS CHANNEL row shows a fresh delivery"
  echo "  · Desktop → Settings → Mobile → Try again → QR renders AND STAYS"
  [ "$failed" = false ]
}

if [ "$CHECK_ONLY" = true ]; then run_checks; exit $?; fi

[ -f "$ENV_FILE" ] || { echo "ERROR: $ENV_FILE not found." >&2; exit 1; }
mkdir -p "$BACKUP_DIR"

# ── 1. SNAPSHOT — pg_dump, not a volume tar ───────────────────────────────
# A tar of a running Postgres volume is a snapshot of a moving target;
# pg_dump is transactionally consistent and needs no downtime. Media in minio
# is untouched by relay migrations and is not part of this snapshot.
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
SNAP="$BACKUP_DIR/buzz-pg-pre-main-$STAMP.sql.gz"
echo "snapshotting postgres → $SNAP"
docker exec buzz-prod-postgres-1 pg_dump -U buzz buzz | gzip > "$SNAP"
[ -s "$SNAP" ] || { echo "ERROR: snapshot is empty — refusing to continue." >&2; exit 1; }
echo "  $(du -h "$SNAP" | cut -f1) written"

# ── 2. RESOLVE AND PIN THE DIGEST ─────────────────────────────────────────
# ":main" moves; the digest does not. The .env records exactly what runs.
echo "resolving ghcr.io/block/buzz:main …"
docker pull -q ghcr.io/block/buzz:main >/dev/null
DIGEST="$(docker inspect --format '{{index .RepoDigests 0}}' ghcr.io/block/buzz:main)"
echo "  $DIGEST"
cp "$ENV_FILE" "$ENV_FILE.bak.$STAMP"
if grep -q '^BUZZ_IMAGE=' "$ENV_FILE"; then
  sed -i "s|^BUZZ_IMAGE=.*|BUZZ_IMAGE=$DIGEST|" "$ENV_FILE"
else
  printf 'BUZZ_IMAGE=%s\n' "$DIGEST" >> "$ENV_FILE"
fi

# ── 3. RECREATE ───────────────────────────────────────────────────────────
( cd "$BUZZ_DIR" && "${COMPOSE[@]}" up -d )

# ── 4. CHECK ──────────────────────────────────────────────────────────────
sleep 8
if run_checks; then
  echo "UPGRADE OK — snapshot kept at $SNAP (keep ~1 week)."
else
  cat >&2 <<EOF

UPGRADE FAILED ITS CHECKS. Nothing has been rolled back automatically.
To revert:
  cp $ENV_FILE.bak.$STAMP $ENV_FILE
  cd $BUZZ_DIR && ${COMPOSE[*]} up -d
If migrations corrupted the schema (CHECK 3), restore the snapshot first:
  gunzip -c $SNAP | docker exec -i buzz-prod-postgres-1 psql -U buzz buzz
EOF
  exit 1
fi
