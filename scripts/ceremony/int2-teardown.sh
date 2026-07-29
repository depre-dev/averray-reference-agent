#!/usr/bin/env bash
# INT-2 §5 teardown. Stops only named disposable resources and removes only
# the exact ceremony root after evidence has been archived.
set -euo pipefail

: "${CEREMONY_ROOT:?CEREMONY_ROOT is required}"
: "${REFERENCE_CHECKOUT:?REFERENCE_CHECKOUT is required}"
_int2_archive="${1:?usage: int2-teardown.sh /path/to/archive}"

pgrep -f "$REFERENCE_CHECKOUT/services/harness-dispatcher/dist/index.js" \
  >/dev/null 2>&1 \
  && { echo "dispatcher is still running; stop it first" >&2; exit 1; }
pgrep -f "${HARNESS_CHECKOUT:-__none__}/.venv/bin/harness worker" \
  >/dev/null 2>&1 \
  && { echo "Harness worker is still running; stop it first" >&2; exit 1; }
[ -d "$CEREMONY_ROOT/evidence" ] \
  || { echo "evidence directory is absent; refusing teardown" >&2; exit 1; }

mkdir -p "$_int2_archive"
_int2_name="int2-evidence-$(basename "$CEREMONY_ROOT")"
cp -R "$CEREMONY_ROOT/evidence" "$_int2_archive/$_int2_name"
(
  cd "$_int2_archive/$_int2_name"
  find . -type f -exec shasum -a 256 {} \; | sort \
    > "$_int2_archive/$_int2_name.sha256"
)

export HARNESS_DISPATCH_ENABLED=false
docker stop int2-harness-postgres >/dev/null 2>&1 || true
docker stop int2-reference-postgres >/dev/null 2>&1 || true

case "$CEREMONY_ROOT" in
  /|/home|/Users|/var|/var/lib|/var/lib/harness-dispatcher|"$HOME")
    echo "refusing suspicious CEREMONY_ROOT=$CEREMONY_ROOT" >&2
    exit 1
    ;;
esac
rm -rf "$CEREMONY_ROOT"
echo "Teardown complete; evidence archived at $_int2_archive/$_int2_name"
