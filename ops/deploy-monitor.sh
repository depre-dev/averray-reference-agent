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
#   ops/deploy-monitor.sh --restart-consumers
#                                         # ...and restart the MCP bundle's
#                                         # consumers even if it did not change
#                                         # (retry after a failed restart)
#
# Beyond the sha, this owns the two steps a deploy is not correct without and
# that nobody remembers to type: syncing hermes/skills into the skills volume,
# and restarting whatever runs from the MCP bundle once it has been republished.
# Both are advisory and both are loud; see their notes below.
set -euo pipefail

cd "$(dirname "$0")/.."

ALLOW_DIRTY=false
FORCE_RESTART=false
SERVICE=slack-operator
for arg in "$@"; do
  case "$arg" in
    --allow-dirty) ALLOW_DIRTY=true ;;
    --restart-consumers) FORCE_RESTART=true ;;
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

PROJECT=avg
COMPOSE=(docker compose -p "$PROJECT" --env-file .env.prod
  -f ops/compose.yml
  -f ops/compose.prod.yml
  -f ops/compose.command-center.yml
  -f ops/compose.cloudflare-access.yml)

# The volume the MCP servers actually run from, project-prefixed as Docker
# names it. See the bundle-consumer restart at the end of this script.
BUNDLE_VOLUME="${PROJECT}_avg-app"
BUNDLE_ID_PATH=/bundle/.mcp-bundle-id

# Reading a named volume needs a container; there is no host path for one that
# is not root-only and box-specific. alpine:3.20 is already pinned in
# ops/compose.yml (mcp-env), so it is local on any box being deployed to.
#
# The existence check is not defensive padding: `docker run -v <name>:...`
# CREATES a missing volume, and a volume created outside Compose has none of
# Compose's labels — which is exactly the state Compose refuses to adopt. On a
# first-ever deploy that would turn a read into a broken stack. No volume means
# no previous bundle, which is what the empty string says.
read_bundle_id() {
  docker volume inspect "${BUNDLE_VOLUME}" >/dev/null 2>&1 || return 0
  docker run --rm -v "${BUNDLE_VOLUME}:/bundle:ro" alpine:3.20 \
    cat "${BUNDLE_ID_PATH}" 2>/dev/null | tr -d '\r\n' || true
}

# SYNC THE SKILL TREE FIRST — on every deploy, whatever service is being
# deployed.
#
# hermes/skills/** is not baked into any image. It reaches the agent by being
# bind-mounted in and copied into the avg-hermes-skills volume, and until that
# copy happens a merged SKILL.md edit is live nowhere. Compose gates `hermes`
# on skills-sync, but that only fires when Hermes itself restarts, which a
# monitor deploy does not do — so the sync would run days late, or not at all.
#
# This is the same lesson as GIT_SHA above: a correctness-critical step must not
# depend on an operator remembering to type it, so it lives here.
#
# ADVISORY, not fatal. Deploying the board is how the operator sees the money
# path, and the board reads none of these skills; failing that deploy because a
# skill file could not be copied would be the coupling #657 removed. A stale
# tree still fails closed where it matters (Hermes will not boot onto one) and
# skills-observer keeps reporting the drift until it is fixed.
#
# --no-deps is deliberate. skills-sync depends on hermes-permissions, which is
# a one-shot that has already exited by the time anyone deploys; pulling it in
# here would re-run its `chmod -R 0777 /opt/data` and re-open the Hermes data
# volume that Hermes spends its life securing to 0700 — a permissions change
# nobody asked a monitor deploy to make. The volume already exists on any box
# being deployed to, and the first-boot ordering is handled by compose's
# dependency graph, not by this script.
echo "syncing hermes/skills -> the skills volume"
if GIT_SHA="$GIT_SHA" GIT_DIRTY="$GIT_DIRTY" "${COMPOSE[@]}" run --rm --no-deps --build skills-sync; then
  echo
else
  echo >&2
  echo "WARNING: the skills sync did not complete — the running agent may be" >&2
  echo "         reading a skill tree that does not match this commit. The" >&2
  echo "         deploy of ${SERVICE} continues (it does not read these files)." >&2
  echo "         Check the log above; skills-observer will keep reporting the" >&2
  echo "         drift until it is resolved." >&2
  echo >&2
fi

# Read BEFORE the deploy, because `up` re-runs mcp-bundle as a dependency and
# republishes the volume. Comparing this against the id afterwards is what
# tells us whether the consumers' code actually changed under them.
BUNDLE_ID_BEFORE="$(read_bundle_id)"

echo "deploying ${SERVICE} at ${GIT_SHA:0:8}$([ "$GIT_DIRTY" = true ] && echo ' (dirty)')"

# NEVER --remove-orphans here: this compose project shares a network with
# services defined in other files, and it would take them down.
GIT_SHA="$GIT_SHA" GIT_DIRTY="$GIT_DIRTY" "${COMPOSE[@]}" up -d --build "$SERVICE"

# RESTART WHATEVER RUNS FROM THE BUNDLE.
#
# The MCP servers are not in anyone's image: they live in the avg-app volume,
# which mcp-bundle rewrites (rm -rf + cp -a) every time this script runs. An MCP
# client registers its tool list ONCE, at process startup, so rewriting the
# volume under a running consumer changes the files and not the tool surface —
# it keeps advertising the previous list, and nothing errors.
#
# On 2026-08-02 that cost us twice. `averray_board_health` (#657) shipped;
# `hermes` picked it up only because someone restarted it by hand, and
# `hermes-gateway` — up nine hours — did not. The Buzz inbound listener then
# answered an operator's question about system health from `averray_ops_health`
# (the Postgres control plane, explicitly NOT the board) and said "No issues on
# the board" having never read the board. It surfaced only because #666 made the
# prompt name the tool. Same class as the skills volume in #664: the artifact
# ships, the consumer never reloads, and nothing errors.
#
# Nor is leaving them alone the safe option. The rewrite unlinks the old files,
# so a consumer that later respawns an MCP subprocess gets NEW code behind an
# OLD registration. The running system is not stale, it is undefined.
#
# WHY `docker ps` AND NOT COMPOSE. hermes-gateway is behind
# `--profile command-center`, so `compose restart hermes-gateway` finds nothing
# unless the profile is passed — and the next consumer added behind the next
# profile would be missed in exactly the same silence this is here to end.
# Profile membership is a Compose concept; "who has this volume mounted right
# now" is a runtime one, and the runtime is the thing we need the truth about.
# This also cannot start something the operator deliberately stopped, which
# `compose up` could.
#
# ADVISORY, not fatal — the same call #664 made for the skills sync. Deploying
# the board is how the operator sees the money path, and the board does not run
# from this volume. Failing that deploy because the agent would not restart
# would be coupling the money path to the agent, which is precisely backwards.
# A restart that does not happen is reported here and keeps being reported by
# skills-observer until it does.
BUNDLE_ID_AFTER="$(read_bundle_id)"

if [ "$FORCE_RESTART" != true ] && [ -z "$BUNDLE_ID_AFTER" ]; then
  # No stamp means mcp-bundle did not run in this deploy — `${SERVICE}` does not
  # depend on it — or the volume predates the stamp. Either way nothing here
  # established that the consumers changed, and restarting the agent on no
  # evidence is the coupling this script is careful not to introduce. Say what
  # is actually known, which is nothing.
  echo
  echo "no bundle id in ${BUNDLE_VOLUME} — this deploy did not republish it, so nothing here" >&2
  echo "can say whether the consumers are current. skills-observer reports that separately," >&2
  echo "and --restart-consumers restarts them anyway." >&2
elif [ "$FORCE_RESTART" != true ] && [ -n "$BUNDLE_ID_BEFORE" ] &&
     [ "$BUNDLE_ID_BEFORE" = "$BUNDLE_ID_AFTER" ]; then
  # Only a clean build can produce a stable id, and a clean build at the same
  # sha is byte-identical — so this deploy changed nothing under the consumers.
  # Dirty builds never take this path (mcp-bundle stamps them uniquely), so
  # "unchanged" is never a guess.
  #
  # Note what this does NOT say. "The bundle did not change" is not "the
  # consumers are current" — nothing here looked at them, and one could still be
  # stale from an earlier deploy whose restart failed. Claiming otherwise would
  # be worst on the path where it matters most: the operator who just read the
  # restart warning below and re-ran this script to retry would be told
  # everything is fine while the stale consumer stayed stale. That is the
  # original bug wearing the fix's clothes. Hence --restart-consumers.
  echo
  echo "MCP bundle unchanged (${BUNDLE_ID_AFTER}) — this deploy made nothing stale."
  echo "  (Whether the consumers were already current is a separate question this"
  echo "   does not answer; skills-observer does. Force one with --restart-consumers.)"
else
  echo
  if [ "$FORCE_RESTART" = true ] && [ "$BUNDLE_ID_BEFORE" = "$BUNDLE_ID_AFTER" ]; then
    echo "MCP bundle unchanged (${BUNDLE_ID_AFTER:-unknown}); restarting anyway as asked."
  else
    echo "MCP bundle is now ${BUNDLE_ID_AFTER:-unknown} (was ${BUNDLE_ID_BEFORE:-none})."
  fi
  echo "restarting everything that runs from it, so its tool list matches:"

  BUNDLE_CONSUMERS="$(docker ps \
    --filter "volume=${BUNDLE_VOLUME}" \
    --filter "label=com.docker.compose.project=${PROJECT}" \
    --format '{{.ID}} {{.Label "com.docker.compose.service"}}' || true)"

  RESTART_FAILED=false
  RESTARTED=0
  while read -r cid service; do
    [ -n "$cid" ] || continue
    # The publisher mounts the same volume. It is a one-shot that has already
    # exited by now, but skip it by name rather than by luck.
    [ "$service" != mcp-bundle ] || continue
    if docker restart "$cid" >/dev/null; then
      echo "  restarted ${service} (${cid:0:12})"
      RESTARTED=$((RESTARTED + 1))
    else
      echo "  FAILED to restart ${service} (${cid:0:12})" >&2
      RESTART_FAILED=true
    fi
  done <<EOF
$BUNDLE_CONSUMERS
EOF

  if [ "$RESTARTED" -eq 0 ]; then
    # Not success. Every box that runs the agent has consumers of this volume,
    # so finding none means either they are all down or the lookup is wrong —
    # and "the deploy printed nothing" must not be how either one is discovered.
    echo >&2
    echo "WARNING: the bundle changed but NO running consumer of ${BUNDLE_VOLUME} was found." >&2
    echo "         Nothing was restarted. If hermes / hermes-gateway are up, they are now" >&2
    echo "         serving a tool list from the previous bundle: check" >&2
    echo "         \`docker ps --filter volume=${BUNDLE_VOLUME}\`." >&2
    echo >&2
  elif [ "$RESTART_FAILED" = true ]; then
    echo >&2
    echo "WARNING: at least one consumer did not restart. It is still serving the tool list" >&2
    echo "         from the previous bundle — a tool shipped by this deploy is invisible to" >&2
    echo "         it, and it will answer as if that tool does not exist. The deploy of" >&2
    echo "         ${SERVICE} continues (it does not run from this volume)." >&2
    echo "         skills-observer keeps reporting the drift until it is resolved." >&2
    echo >&2
  fi
fi

echo
echo "deployed. Confirm the monitor knows its own version:"
echo "  curl -s localhost:8790/monitor/product-health | grep -o '\"self\":{[^}]*}'"
