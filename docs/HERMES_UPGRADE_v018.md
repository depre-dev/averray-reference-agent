# Hermes v0.17 → v0.18 — Upgrade Plan + Staging-Smoke Runbook

- **Status:** Plan + runbook. No brain-feature implementation here (needs the image running). Refreshes the target from the **already-completed** v0.17 upgrade to v0.18.
- **Date:** 2026-07-02
- **Prod is on v0.17.** `nousresearch/hermes-agent:v2026.6.19` on both `hermes` and `hermes-gateway` (confirmed via `docker inspect avg-hermes-1 avg-hermes-gateway-1`, 2026-07-02). The full v0.14→v0.17 bump **and** the agentic arc (PRs #465–475) are **live in prod**: Session API, agentic backlog, router narration, SSE streaming, learned routing, model = `glm-5.2:cloud`.
- **⚠ Stale template:** `ops/.env.example:11` still shows the **v0.14** digest. It does not reflect the live pin and misled this plan's first draft — **update it to `v2026.6.19`** (§ Cleanup).
- **Upstream now:** **v0.18.0 / v2026.7.1** ("The Judgment Release", 2026-07-01).
- **Builds on:** [`HERMES_UPGRADE_v017.md`](./HERMES_UPGRADE_v017.md) — the v0.17 eval, now **executed and deployed**.

---

## 0. Bottom line

We already did the hard part. **v0.17 is live** and the whole "control plane on a smarter brain" arc runs in prod. The v0.17→v0.18 bump is a **single-major, ~2-week jump**, and the heavy v0.15–0.17 changes (s6 supervision, UID-remap/boot-chown) are **already crossed and verified** (#464 skills-volume owner + #467 trace EADDRINUSE). So this bump is **low-risk relative to the last one.**

The "remaining new features" are exactly two buckets:

1. **The two v0.17 items we deliberately deferred** — background subagents (#1) and MCP elicitation (#4) — each blocked on a specific gateway limitation, *not* forgotten.
2. **What v0.18 adds** — and the single highest-value question is whether **v0.18's matured background subagents unblock #1.**

---

## 1. Remaining from v0.17 (deferred, with their exact blockers)

### 1.1 Background subagents (#1) — **DEFERRED**
v0.17's `delegate_task` posts completion to the gateway's **process watcher, not the REST `/api/sessions` history**, so a background result can't round-trip through our stateless co-pilot / router loop. Groundwork exists; the loop was left one-shot.
- **Unblock condition:** the delegation result must land somewhere our loop can read — the REST session history, or a pollable/streamable run endpoint. **← v0.18 is the candidate (see §2.1).**

### 1.2 MCP elicitation (#4) — **DORMANT**
The v0.17 gateway Session API is create/chat/fork only — **no tool-confirmation event, no answer endpoint**. We shipped fail-closed groundwork (`packages/averray-mcp/src/copilot-elicitation.ts`, `GATEWAY_ELICITATION_SUPPORTED=false`, flag `HERMES_COPILOT_ELICITATION` OFF) + `docs/HERMES_COPILOT_ELICITATION.md`.
- **Unblock condition:** the gateway lands an elicitation event + an answer endpoint. **Check in the v0.18 smoke (§3).**

---

## 2. What v0.18 adds

### 2.1 Matured background subagents — **ADOPT + the key unblock question**
*"parallel subagents run in the background, one consolidated return when all finish"* ([#49734](https://github.com/NousResearch/hermes-agent/pull/49734)); a "will resume" affordance; CLI/TUI status-bar tracking.
- The "**consolidated return into the conversation**" framing *suggests* the result now re-enters the session — exactly the round-trip **#1** needs. **This is NOT confirmed from the release notes** (concurrency/depth/timeout **and** the delivery channel are undocumented).
- **→ The #1 smoke question (highest value):** does a background `delegate_task` result appear in the REST `/api/sessions/{id}` history (or a readable run endpoint)? If yes, #1 unblocks and becomes the top post-bump build.

### 2.2 Completion contracts for `/goal` (`pre_verify`) — **ADOPT (truth-boundary synergy)**
Evidence-based done-ness: *"the standing-goal loop judges against evidence, not the model's say-so"* ([#50501](https://github.com/NousResearch/hermes-agent/pull/50501)) via a **`pre_verify` hook** + a profile-scoped checks ledger; migration `v32` defaults **verify-on-stop OFF**.
- Same principle as our card-side ground-truth panel (#484) and router grounding (#486/#487). **`pre_verify` is a seam to make our verification Hermes's own done-check** — e.g. "PR checks green + no `reconcileTaskClaim` mismatch." Medium effort, post-bump.

### 2.3 Gateway scale-to-zero + drain — **ADOPT (ops, config)**
Dormant-when-idle + wake-without-dropping-in-flight; external drain coordination; **`restart_drain_timeout`** (default **0** to avoid systemd crash loops); self-heal for stranded gateways. Our gateway runs supervised at `:8642` — set `restart_drain_timeout` deliberately (verify it doesn't clip in-flight co-pilot sessions).

### 2.4 MoA / `/learn` / `/journey` — **BORROW / nice-to-have**
`moa` provider + `/moa` (strong ensemble for hard routing calls); `/learn` auto-distills skills (feeds our `skills-observer`); `/journey` memory/skill timeline. Low urgency. **Vertex AI — SKIP** unless we want Gemini.

---

## 3. Staging smoke (v0.17 → v0.18 — lighter than the last bump)

The s6 / UID-remap heavy lifting is already done and verified, so this smoke focuses on **(a) the two unblock questions** and **(b) v0.18's breaking-change surface**. Isolated throwaway profile; touches no prod containers/volumes. ~20 min.

### 3.0 Resolve the real digest (never `:latest`/`:main`)
```bash
docker buildx imagetools inspect nousresearch/hermes-agent:v2026.7.1 | grep -i digest | head -1
# record the sha256 → that's the new pin. Do NOT invent one.
```

### 3.1 Isolated bring-up
```bash
cd /srv/averray-reference-agent
docker pull nousresearch/hermes-agent:v2026.7.1
HERMES_IMAGE=nousresearch/hermes-agent:v2026.7.1 \
  docker compose --env-file .env.prod \
  -f ops/compose.yml -f ops/compose.prod.yml -f ops/compose.command-center.yml \
  -p avg-v018smoke up -d hermes hermes-gateway
docker compose -p avg-v018smoke logs --tail=60 hermes hermes-gateway   # boots clean under s6?
```

### 3.2 ⚠ #1 UNBLOCK TEST (the highest-value check)
From a gateway session, issue a **background** `delegate_task` and then read the session:
```bash
# after the subagent finishes ("will resume"), does its result land in REST history?
curl -s -H "Authorization: Bearer $HERMES_API_TOKEN" \
  http://localhost:<smoke-gw-port>/api/sessions/<id> | jq '.messages[-3:]'
```
✅ **Result appears in `/api/sessions/{id}` history** → #1 unblocks; make it the top post-bump build.
❌ Still watcher-only → #1 stays deferred; note the exact delivery channel v0.18 uses.

### 3.3 #4 elicitation check
- Does the v0.18 gateway emit a **tool-confirmation / elicitation** stream event and expose an **answer endpoint**? (Inspect `/api/sessions` SSE + the OpenAPI/`api_server` surface.) ✅ → activate the shipped #4 groundwork post-bump. ❌ → stays dormant.

### 3.4 Regression + breaking-change surface (v0.18-specific)
- **Skills-volume owner unchanged** (v0.18 has no new Docker changes, but confirm): `docker run --rm -v avg_avg-hermes-skills:/s alpine stat -c '%u:%g %a' /s` → still `10000:10000 0700`, so #464's `user: "10000:10000"` holds.
- **MCP tools** (`averray`,`wallet`,`receipt`,`trace`,`policy`) all connect — esp. **`trace`** (the #467 EADDRINUSE fix must survive v0.18's s6 double-spawn).
- **Models resolve:** `glm-5.2:cloud` (our default) **and** `deepseek-v4-pro:cloud`.
- **verify-on-stop now OFF** (migration v32) — confirm nothing we rely on assumed it ON.
- **Per-profile cron** (reverted from centralized) — our daily operator-report cron still registers.
- **auth.json cloning disabled** — our gateway OAuth/token path doesn't depend on it.
- **`prompt_caching.enabled` backed out** — confirm not set in our config.

### 3.5 Go / no-go + teardown
```bash
docker compose -p avg-v018smoke down     # tears down ONLY the smoke project
```
GO if 3.1/3.4 pass → bump the pin (record the digest, the #1/#4 answers, the model + ownership results). NO-GO on any ❌ → capture + hold/fix.

---

## 4. Post-bump integration backlog (prioritized by the smoke's answers)

Narrow PRs, each behind the existing guardrails (dispatch allowlist, budgets, 4h cap, HALT tiering, human merge/deploy gate):

1. **IF §3.2 confirms round-trip → wire background subagents (#1)** into the co-pilot/router planner — the deferred highest-leverage item finally lands. Decide the budget-accounting question first (does Hermes's own fan-out count against the dispatch budget?).
2. **`pre_verify` completion contract (§2.2)** — wire one real Averray check (PR checks green + no `reconcileTaskClaim` mismatch, reusing #484) into Hermes's `/goal` verification. Highest synergy with #484–488.
3. **IF §3.3 confirms elicitation → activate #4** — the fail-closed groundwork already exists; just flip on the gateway path.
4. **Gateway scale-to-zero + `restart_drain_timeout`** tuning in compose.
5. **MoA preset for high-risk routing** (optional).

---

## 5. Open decisions for the operator

1. **Bump v0.18?** Low-risk single-major jump (§3). The longer we hold, the wider the v0.19 gap.
2. **Background subagents:** if v0.18 unblocks them, do we want Hermes fanning out its own parallel work — and does that spend count against the dispatch budget?
3. **Completion contracts:** adopt `pre_verify` as the seam that makes our verification Hermes's own done-check? (Recommended — same truth-boundary principle we just shipped.)
4. **Elicitation:** activate #4 if v0.18 exposes it, or keep lane-park.

---

## Cleanup

`ops/.env.example` pins the **v0.14** digest while prod runs **v0.17** (`v2026.6.19`) — this stale template misled the first draft of this plan. **Update `.env.example`'s `HERMES_IMAGE` (and its comment) to the live `v2026.6.19` digest** so the template matches reality. Small, worth doing with the next ops PR.

---

*Refreshed 2026-07-02 after confirming the live pin is v0.17. Recommendation + runbook — the bump itself is operator-run on the box.*
