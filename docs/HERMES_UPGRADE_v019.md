# Hermes v0.18 → v0.19.1 — Upgrade Plan + Buzz-Replaces-Slack Cutover

Written 2026-07-31. Companion to `HERMES_UPGRADE_v018.md`; same shape — upstream
changes diffed against **what we actually use**, not a feature tour.

## 0. Bottom line

| | |
|---|---|
| Running | **v0.18.0** (`nousresearch/hermes-agent:v2026.7.1`) |
| Target | **v0.19.1** (`v2026.7.30`), published 2026-07-30 |
| Path | v0.18.1 → v0.18.2 → v0.19.0 → v0.19.1 |

Two decisions, and **they are sequenced, not parallel**: Buzz messaging support
landed in the v0.19.x line ([#68871](https://github.com/NousResearch/hermes-agent/issues/68871),
closed 2026-07-29; v0.19.1 notes list *"continued platform work (Buzz/Nostr
channel …)"*). It is **not backportable to v0.18** — the upgrade gates the Buzz
work entirely.

**⚠ v0.19.1 is ~1 day old and rolls up ~2,789 commits / ~4,748 files changed
since v0.19.0.** Our last bump needed two follow-up fixes (#491 `dashboard`→
`serve` + aux-model pin, #492 CI bootstrap-pin sync). Recommendation: stage it,
and prefer v0.19.2 for prod if it appears before we finish the smoke.

## 1. What we actually depend on

Everything below is a real call site in `services/slack-operator/`. This is the
blast-radius surface; anything upstream that doesn't touch these doesn't matter
to us regardless of how prominent it is in the release notes.

| Surface | Where | Notes |
|---|---|---|
| HTTP Session API | `hermes-session-client.ts` | `POST /api/sessions`, `/{id}/chat`, `/{id}/chat/stream` (SSE), `/{id}/fork` |
| Gateway base + auth | `HERMES_API_URL` → `http://hermes-gateway:8642`, `HERMES_API_TOKEN` / `API_SERVER_KEY` | `resolveHermesSessionConfig()` returns null ⇒ degraded-safe no-op |
| SSE frame parsing | `parseSseFrames()` | we parse frames ourselves — a format change breaks us silently |
| Co-pilot rail, router narration, failure analysis | `index.ts` ×4 `resolveHermesSessionConfig()` call sites | `HERMES_FAILURE_ANALYSIS=1` is live in prod |
| Voice | `monitor-hermes-voice.ts` | same gateway |

## 2. What upstream changed that touches it

### 2.1 Session storage moved — **the one to actually watch**

v0.19.0: *"Gateway session metadata consolidated into `state.db`; routing index
moved to `state.db` (`sessions.json` now an optional legacy mirror)."*

That is an **internal storage** change, not a documented API change. Our client
speaks HTTP, so we are *probably* unaffected — but "probably" is what burned us
last time: the v0.18 Session-API 401 looked like a code change and turned out to
be a recreate artifact. Verify empirically (§3.2), do not reason about it.

### 2.2 `pre_tool_call` approve action — reverted mid-window, then re-landed

Affects anything hanging off that extension point. We do not ship a Hermes
plugin today, so this is **informational** — but it becomes load-bearing the
moment we adopt the Buzz platform plugin (§4).

### 2.3 Provider config gained `enabled: false` + `excluded_providers`

Optional. Relevant only if we want to pin the aux model harder than #491 did.

### 2.4 What upstream does **NOT** document — plan around this

I checked the notes for v0.18.1, v0.18.2, v0.19.0 and v0.19.1 specifically for
the Session API, gateway auth / `API_SERVER_KEY`, the `serve` command and its
flags, SSE event names and frame format, and required migrations.

**None of them are mentioned.** Not "unchanged" — *unaddressed*. The notes are
user-facing (speed, MoA, desktop, billing, password managers); backend API
stability is simply not covered.

So the upgrade's blast radius on our integration is **undocumented upstream**.
That is exactly the shape of today's two production defects — a belief about a
system nobody had measured. Treat §3 as the source of truth, not the changelog.

## 3. Staging smoke

### 3.0 Resolve the real digest (never `:latest`)

```bash
docker buildx imagetools inspect nousresearch/hermes-agent:v2026.7.30 | grep -i digest | head -1
```

Record the sha256 — that is the new pin. Do not invent one.

### 3.1 Isolated bring-up

Bring it up on a scratch port with its own volume. **Never** against the prod
`avg_avg-hermes-skills` volume: Hermes owns it as UID 10000 and re-secures it to
0700, and `Deploy Production` execs into the `avg-hermes` sidecar — so a Hermes
crash can red an averray deploy while the backend is healthy (#657 made that
gate advisory, it did not remove the coupling).

### 3.2 ⚠ THE HIGHEST-VALUE CHECK — the Session API still answers

The storage move (§2.1) is the one plausible breakage. Prove the four endpoints
we actually call, against the new image, before anything else:

```bash
# 201 expected — a 401 here is the v0.18 recreate artifact, NOT a code change
curl -si -X POST "$H/api/sessions" -H "Authorization: Bearer $KEY" -d '{}' | head -1
```

Then `/chat`, `/chat/stream` (confirm SSE frame names still parse through
`parseSseFrames`), and `/fork`. A green boot with a broken stream is the failure
mode that would reach prod silently, because the co-pilot rail degrades quietly
by design.

### 3.3 Regression surface

- Failure analysis still writes `hermes_failure_analysis_written` / `_done`.
- Router narration and the co-pilot rail still return (not silently null).
- Voice path still resolves the gateway.
- `state.db` created cleanly on a fresh volume; no manual migration demanded.

### 3.4 Go / no-go

Go only if §3.2 is fully green. A partial pass is a no-go: our client fails
degraded-safe, so partial breakage looks like calm.

## 4. Buzz replaces Slack as the control surface

**Decision (operator, 2026-07-31):** Buzz becomes the control + monitoring
surface, replacing Slack — it is native to agents and to Hermes, and it is a
relay we own rather than a SaaS we post into.

### 4.1 Which of the three connection methods

| Method | Verdict |
|---|---|
| **Native gateway platform** | **ADOPT.** Buzz becomes a Hermes messaging platform alongside Telegram/Discord, keeping Hermes' approval system, memory and session handling. NIP-42 auth, BIP-340 signing, cron delivery (`deliver=buzz`). |
| Relay bridge (`buzz-acp`) | Reject for us. Buzz's harness owns the transport, so we lose the Hermes-side approval semantics we rely on. |
| Desktop runtime | **Reject.** The docs state it **auto-approves tool permissions**. Unacceptable for anything sharing a channel with an agent that can act. |

### 4.2 What changes in our code — less than it sounds

`alert-bridge.ts` already anticipated this. Its own header says *"AlertChannel:
the pluggable dispatch interface (Slack now; a push channel later)"* and
*"same AlertChannel interface later — the routine never changes."*

```ts
export interface AlertChannel {
  readonly name: string;
  dispatch(payload: AlertPayload): Promise<boolean>;
}
```

So the work is **one new implementation**, `buzzAlertChannel()`, plus swapping
five `alertChannel.dispatch(...)` call sites in `index.ts`. The alert *decision*
layer — `decideMoneyAlert`, `alertProvenance`, the gap-keyed de-dup (#590) — is
transport-agnostic and does not change at all. #590 was not wasted work; it was
the right layering.

### 4.3 The hazard that must govern the cutover

**A money-alerting system whose only channel can fail silently is worse than one
that pages noisily.** Slack is a hosted service we currently trust; a
self-hosted Nostr relay is infrastructure *we* now have to keep up. If the relay
is down and Buzz is the sole path, alerts do not fail loudly — they simply never
arrive, and the board looks calm.

Therefore:

1. **Dual-dispatch during bake.** `AlertChannel.dispatch` already returns
   `boolean` (sent / no-op), so a composite channel can send to both and report
   honestly. Run both for a full bake period.
2. **Do not cut Slack until Buzz has delivered a real money alert** — not a test
   ping. The first genuine `payout shortfall` or pool-below-floor that lands in
   Buzz is the gate.
3. **Add relay reachability to the probes.** Once Buzz is the control surface it
   is production infrastructure, and by our own rule the thing that carries the
   alarm must itself be monitored. A `buzz_relay` probe belongs next to the
   other seven.

### 4.4 Ops weight — be honest about it

Buzz is a Rust relay plus **Postgres, Redis and S3/MinIO**. The VPS already runs
the monitor, its Postgres, the Hermes sidecar and the task runners. This is not
a plugin; it is a second stack. Size the box before, not after.

### 4.5 Why it is nonetheless the right direction

Every Buzz participant — human or agent — is a **keypair**, and every message is
a signed event on a relay we control. That is the same identity model Averray
runs on-chain. Slack can only ever be a place agents *post into*; Buzz is a
place they are *members of*, with the audit trail as a first-class artifact
rather than a channel history we scrape.

## 5. Sequencing

1. §3 smoke on v0.19.1 (or v0.19.2 if it lands first) — **gates everything**.
2. Prod bump + the existing post-bump checks.
3. Stand up the Buzz relay; `hermes gateway setup` → Buzz; native platform.
4. `buzzAlertChannel()` + composite dual-dispatch; bake.
5. `buzz_relay` probe.
6. Cut Slack only after §4.3.2 is satisfied.

## 6. Open questions

- Does v0.19.x's `state.db` consolidation need a one-time migration from an
  existing v0.18 volume, or only on fresh state? §3.2 answers it; the notes do not.
- Does the bundled `buzz` plugin use `pre_tool_call` (§2.2)? If so its
  revert/re-land history becomes load-bearing for us.
- Relay hosting: same VPS, or its own box? §4.4 argues this is a sizing
  decision, not a detail.
