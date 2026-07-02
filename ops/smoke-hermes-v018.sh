#!/usr/bin/env bash
#
# Turnkey v0.18 staging smoke — RUN ON A THROWAWAY BOX, NEVER PROD.
#
# Stands up an ISOLATED Hermes v0.18 gateway from this repo's own compose (so
# the config + model are exactly like prod, no guessing) and answers the two
# questions that gate the remaining upgrade work (see docs/HERMES_UPGRADE_v018.md):
#
#   TEST #1  Do BACKGROUND delegate_task results round-trip into the REST
#            session history (GET /api/sessions/{id})? If yes, the deferred
#            "background subagents" item (the highest-leverage one) unblocks.
#   CHECK #4 Does the gateway expose MCP elicitation (a tool-confirmation event
#            + an answer endpoint)? If yes, the dormant inline-approval item
#            (#4) unblocks.
#
# plus a model-resolution + boot sanity check. Cleans itself up on exit.
#
# Prereqs on the throwaway box: docker, docker compose, jq, curl, a checkout of
# THIS repo, and a real OLLAMA_API_KEY (ollama-cloud — glm-5.2:cloud runs there).
# Registry + ollama.com network access. It binds only 127.0.0.1:${SMOKE_GW_PORT}.
#
# Usage (from the repo root):
#   OLLAMA_API_KEY=sk-... ./ops/smoke-hermes-v018.sh
#
# NOTE (honest): this is a smoke, so first run may need a nudge — LLMs don't
# always call a tool on command (the #1 prompt may need retrying / hardening),
# and the exact session-history JSON shape + the elicitation endpoint names are
# not documented for v0.18, so the script dumps raw output alongside each verdict
# for you to eyeball. Adjust the greps to what you see.
set -euo pipefail

IMAGE="nousresearch/hermes-agent:v2026.7.1"           # v0.18.0
PROJECT="hermesv018smoke"
PORT="${SMOKE_GW_PORT:-8643}"                          # NOT 8642 — never clash with a live gateway
GW="http://127.0.0.1:${PORT}"
: "${OLLAMA_API_KEY:?Set OLLAMA_API_KEY (ollama-cloud) so glm-5.2:cloud can run}"
command -v jq   >/dev/null || { echo "need jq";   exit 1; }
command -v curl >/dev/null || { echo "need curl"; exit 1; }
[ -f ops/compose.yml ] || { echo "run from the repo root (ops/compose.yml not found)"; exit 1; }

ENVF="$(mktemp)"
TOK="smoke-$(head -c 8 /dev/urandom | od -An -tx1 | tr -d ' \n')"
cat > "$ENVF" <<EOF
HERMES_GATEWAY_API_KEY=${TOK}
OLLAMA_API_KEY=${OLLAMA_API_KEY}
HERMES_GATEWAY_PORT=${PORT}
EOF

COMPOSE=(docker compose --env-file "$ENVF" -f ops/compose.yml -f ops/compose.command-center.yml -p "$PROJECT")
cleanup(){ echo "── teardown (removes the smoke project + its volumes) ──"; "${COMPOSE[@]}" down -v >/dev/null 2>&1 || true; rm -f "$ENVF"; }
trap cleanup EXIT
auth=(-H "Authorization: Bearer ${TOK}" -H "Content-Type: application/json")

echo "── pull + isolated bring-up (project=$PROJECT, gateway 127.0.0.1:$PORT) ──"
docker pull "$IMAGE"
HERMES_IMAGE="$IMAGE" "${COMPOSE[@]}" up -d hermes-gateway

echo "── wait for /health (up to 2 min; boot pulls its own postgres + mcp-bundle) ──"
for i in $(seq 1 40); do
  curl -fsS "$GW/health" >/dev/null 2>&1 && { echo "✅ gateway healthy"; break; }
  sleep 3
  if [ "$i" = 40 ]; then echo "❌ gateway never healthy — logs:"; "${COMPOSE[@]}" logs --tail=80 hermes-gateway; exit 1; fi
done

echo "── model sanity: one plain turn ──"
SID=$(curl -s "${auth[@]}" -X POST "$GW/api/sessions" -d '{}' | jq -r '.session.id')
echo "session=$SID"
reply=$(curl -s "${auth[@]}" -X POST "$GW/api/sessions/$SID/chat" -d '{"input":"Reply with exactly one word: READY"}' | jq -r '.message.content // .message // empty')
echo "model reply: ${reply:0:120}"
[ -n "$reply" ] && echo "✅ glm-5.2:cloud resolves + answers" || echo "⚠ empty reply — check OLLAMA_API_KEY / model catalog on v0.18"

echo
echo "════════ TEST #1 — background delegate_task round-trip ════════"
curl -s "${auth[@]}" -X POST "$GW/api/sessions/$SID/chat" \
  -d '{"input":"Use the delegate_task tool with background=true to spawn ONE subagent whose entire job is to compute 21+21 and reply with only the number 42. Return to me immediately with the background handle — do NOT wait for the subagent."}' \
  | jq -r '.message.content // empty' | sed 's/^/  spawn turn: /' | head -6
echo "  …waiting 60s for the background subagent to finish + (maybe) re-enter the session…"
sleep 60
echo "  REST session history now:"
hist=$(curl -s "${auth[@]}" "$GW/api/sessions/$SID")
echo "$hist" | jq '{turns:((.messages // .session.messages // []) | length), last3:((.messages // .session.messages // [])[-3:] | map({role, content:(.content|tostring|.[0:200])}))}' 2>/dev/null || { echo "  (unexpected shape — raw:)"; echo "$hist" | head -c 500; }
echo
if echo "$hist" | grep -q '42'; then
  echo "✅ #1 PASS — the subagent's result (42) IS in the REST session history →"
  echo "   background subagents ROUND-TRIP → wire them into the planner (top post-bump build)."
else
  echo "❌ #1 FAIL/UNCLEAR — '42' not found in REST history. Either it round-trips"
  echo "   under a different JSON shape (eyeball the dump above) or it's still"
  echo "   watcher-only → #1 stays deferred. Record the exact delivery shape."
fi

echo
echo "════════ CHECK #4 — does the gateway expose MCP elicitation? ════════"
oapi=$(curl -s "${auth[@]}" "$GW/openapi.json" 2>/dev/null || true)
if [ -n "$oapi" ] && echo "$oapi" | jq -e . >/dev/null 2>&1; then
  hits=$(echo "$oapi" | jq -r '.paths | keys[]' 2>/dev/null | grep -iE 'elicit|confirm|answer|approve' || true)
  if [ -n "$hits" ]; then echo "✅ candidate elicitation endpoints:"; echo "$hits" | sed 's/^/   /';
  else echo "❌ no elicit/confirm/answer paths in the OpenAPI → #4 stays dormant on v0.18."; fi
else
  echo "⚠ no parseable /openapi.json at $GW — inspect the gateway API surface manually"
  echo "  (look for a tool-confirmation SSE event + an answer endpoint)."
fi

echo
echo "════════ smoke complete — teardown runs automatically on exit ════════"
