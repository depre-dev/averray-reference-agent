#!/usr/bin/env bash
#
# Deploy the Hermes monitor (slack-operator) — with its own version baked in.
#
# WHY THIS EXISTS: the self-freshness probe answers "is this board running
# current code?", and it needs a GIT_SHA build arg because `.git` is in
# .dockerignore so the build cannot discover the sha itself. The compose file
# has always documented the fix — "prefix the deploy with
# GIT_SHA=$(git rev-parse HEAD)" — and in practice nobody ever typed it. The
# probe therefore reported "unknown" from the day it shipped, which means the
# one check that would have caught "the VPS is six commits behind with four
# merged PRs live nowhere" has never once been able to answer.
#
# A correctness-critical value must not depend on an operator remembering a
# shell prefix. So it lives here instead, where it cannot be omitted.
#
# Usage, from the repo root on the VPS:
#   ops/deploy-monitor.sh                 # build + deploy slack-operator
#   ops/deploy-monitor.sh --allow-dirty   # ...from a dirty tree, marked as such
#   ops/deploy-monitor.sh web             # deploy a different service
set -euo pipefail

cd "$(dirname "$0")/.."

ALLOW_DIRTY=false
SERVICE=slack-operator
for arg in "$@"; do
  case "$arg" in
    --allow-dirty) ALLOW_DIRTY=true ;;
    -*) echo "unknown flag: $arg" >&2; exit 2 ;;
    *) SERVICE="$arg" ;;
  esac
done

if ! git rev-parse --git-dir >/dev/null 2>&1; then
  # Fail closed. Building without a sha is what produced the silent "unknown",
  # and doing it silently again is how it stays broken for another month.
  echo "ERROR: not a git checkout — cannot determine the running version." >&2
  echo "       Deploy from the git checkout, or the board can never tell you" >&2
  echo "       whether it is running current code." >&2
  exit 1
fi

GIT_SHA="$(git rev-parse HEAD)"
GIT_DIRTY=false
if [ -n "$(git status --porcelain)" ]; then
  GIT_DIRTY=true
  if [ "$ALLOW_DIRTY" != true ]; then
    echo "ERROR: working tree is dirty — refusing to build." >&2
    echo >&2
    git status --short >&2
    echo >&2
    echo "The image would be ${GIT_SHA:0:8} PLUS these uncommitted changes, so the" >&2
    echo "sha would not describe what is running. This has bitten before: an" >&2
    echo "un-popped stash on this box silently reverted a built asset." >&2
    echo >&2
    echo "Commit/stash them, or re-run with --allow-dirty (the board will then" >&2
    echo "report its version as unknown, which is the truth)." >&2
    exit 1
  fi
  echo "WARNING: building from a DIRTY tree — self-freshness will report unknown."
fi

COMPOSE=(docker compose -p avg --env-file .env.prod
  -f ops/compose.yml
  -f ops/compose.prod.yml
  -f ops/compose.command-center.yml
  -f ops/compose.cloudflare-access.yml)

echo "deploying ${SERVICE} at ${GIT_SHA:0:8}$([ "$GIT_DIRTY" = true ] && echo ' (dirty)')"

# NEVER --remove-orphans here: this compose project shares a network with
# services defined in other files, and it would take them down.
GIT_SHA="$GIT_SHA" GIT_DIRTY="$GIT_DIRTY" "${COMPOSE[@]}" up -d --build "$SERVICE"

echo
echo "deployed. Confirm the monitor knows its own version:"
echo "  curl -s localhost:8790/monitor/product-health | grep -o '\"self\":{[^}]*}'"
