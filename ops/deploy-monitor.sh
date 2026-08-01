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

# WHAT ACTUALLY MAKES THE SHA A LIE.
#
# The first cut of this guard used `git status --porcelain`, which counts
# untracked files — and a long-lived VPS accumulates those permanently
# (.env.prod.bak.<epoch> × 8, a hand-rolled deploy.sh). It refused the very
# first real deploy, and it would have refused every one after it, which turns
# --allow-dirty into muscle memory and leaves the guard doing nothing. A check
# that always fires is a check nobody reads; that is the same failure this
# board has spent a week removing.
#
# So distinguish by whether the file can actually reach the image:
#
#   tracked modifications        → YES. The image is HEAD plus edits nobody can
#                                  see. This is the un-popped-stash incident.
#   untracked under packages/,
#     services/, scripts/        → YES. `COPY . .` puts them in the build stage
#                                  and the final stage copies those trees back
#                                  out, so they compile and ship.
#   untracked anywhere else      → NO. The runtime image only takes those three
#                                  trees plus the package manifests, so root
#                                  cruft cannot change what runs. Reported, not
#                                  refused.
TRACKED_DIRT="$(git status --porcelain --untracked-files=no)"
SHIPPED_UNTRACKED="$(git ls-files --others --exclude-standard -- packages services scripts)"
OTHER_UNTRACKED="$(git ls-files --others --exclude-standard -- ':!packages' ':!services' ':!scripts')"

if [ -n "$OTHER_UNTRACKED" ]; then
  echo "note: untracked files outside the shipped trees (cannot affect the image):"
  echo "$OTHER_UNTRACKED" | sed 's/^/  /'
  echo
fi

if [ -n "$TRACKED_DIRT" ] || [ -n "$SHIPPED_UNTRACKED" ]; then
  GIT_DIRTY=true
  if [ "$ALLOW_DIRTY" != true ]; then
    echo "ERROR: the build would not match ${GIT_SHA:0:8} — refusing." >&2
    echo >&2
    [ -n "$TRACKED_DIRT" ] && { echo "modified tracked files:" >&2; echo "$TRACKED_DIRT" | sed 's/^/  /' >&2; }
    [ -n "$SHIPPED_UNTRACKED" ] && { echo "untracked files that WOULD be built and shipped:" >&2; echo "$SHIPPED_UNTRACKED" | sed 's/^/  /' >&2; }
    echo >&2
    echo "The image would be ${GIT_SHA:0:8} PLUS these, so the sha would not" >&2
    echo "describe what is running. An un-popped stash on this box once silently" >&2
    echo "reverted a built asset while everything downstream reported healthy." >&2
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
