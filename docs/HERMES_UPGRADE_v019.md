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

**⚠ VERDICT AFTER THE SMOKE (2026-07-31): WAIT FOR v0.19.2. NO-GO on v0.19.1.**
The Session API our monitor depends on never binds — see §3.5.4. Two open
upstream bugs match the symptom, v0.19.1 is ~1 day old rolling up ~2,789
commits with 8+ open `api_server` issues, and **v0.18 works fine today**, so
there is no pressure. Our last bump needed two follow-ups (#491, #492).

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

## 3.5 SMOKE RESULTS — run 2026-07-31 against v0.19.1

Image pinned by digest, isolated container/volume, loopback port 18642, prod
`v2026.7.1` never touched.

```
nousresearch/hermes-agent:v2026.7.30
sha256:b869e64d6496d4763d5e4fb675b5f504cb23b0e35ec9b790481a56118602b10f
→ boots, self-reports "v0.19.1 (2026.7.30) · upstream cc4cab2f"
```

**Two undocumented changes found. Neither appears in any release note.**

### 3.5.1 The gateway now runs under s6 supervision

v0.19.1 supervises the gateway (`gateway run --replace` under s6, auto-restart
on crash) instead of running it as the container's foreground process.
`--no-supervise` / `HERMES_GATEWAY_NO_SUPERVISE=1` restores the old behaviour.

**Why it matters to us specifically:** `Deploy Production` execs into the
`avg-hermes` sidecar, and today a Hermes crash reds a deploy. Under s6 the
gateway restarts and the container stays up, so the container exit code no
longer reflects gateway health and that failure signature changes. Decide
deliberately which we want; do not inherit it by accident.

### 3.5.2 ★ `API_SERVER_ENABLED` alone no longer enables the Session API

The blocker, and the fix is a config file — not code.

`gateway/config.py` resolves **`env > config > default`**: the `API_SERVER_*`
env vars are an OVERRIDE LAYER on top of a `platforms:` opt-in that must already
exist in `config.yaml`. Our config had `model`, `auxiliary`, `mcp_servers`,
`paths` — no `platforms:` key. So there was nothing to override, the platform
never registered, the gateway logged `No messaging platforms enabled`, bound
nothing, and **reported healthy the whole time**.

v0.18 enabled it from container env alone, which is why the missing block was
invisible for as long as it has existed.

Fix (landed separately, harmless on v0.18 which ignores it):

```yaml
platforms:
  api_server:
    enabled: true
```

Key, port and bind address stay in the environment. Note `/opt/data/config.yaml`
is mounted READ-ONLY from `hermes/config/hermes.yaml`, so `hermes gateway setup`
cannot write it — it has to be a committed file change.

### 3.5.3 Four wrong turns, recorded so nobody repeats them

Each was plausible and each cost a cycle:

1. **"v0.19 broke the Session API."** No — it was never enabled in the smoke.
2. **"The API server needs a model configured."** No — it stayed dead with a
   model present.
3. **"The home was empty (the `gateway.py:2976` docstring describes exactly
   this)."** No — the symptom persisted with a byte copy of the prod home. That
   docstring is about systemd units baking a temp `HERMES_HOME`; it matched our
   *symptom*, not our *cause*.
4. **"It needs `/opt/data/.env` (doctor says so)."** No — writing one changed
   nothing.

Also: `hermes migrate` handles **xAI model retirement only**, and
`gateway migrate-legacy` removes **systemd units** — neither migrates config.
So doctor's `Config version outdated (v0 → v33)` is ADVISORY, not the blocker,
and there is no general config-migration command to run.

And the upstream docs say platforms live in `~/.hermes/gateway-config.yaml`;
**the code says a `platforms:` section in `config.yaml`.** Following the docs
would have created a file Hermes never reads. Same lesson as the deployed
contract ABI: the artifact beats the description.

### 3.5.4 The opt-in was NECESSARY BUT NOT SUFFICIENT — verdict: WAIT

> **⚠ CORRECTED 2026-08-04 — THE ROOT CAUSE BELOW IS WRONG. See
> [HERMES_UPGRADE_v020.md §1](HERMES_UPGRADE_v020.md).**
>
> Both suspects were cleared by running the real config loader inside both
> images with this repo's own `hermes/config/hermes.yaml` mounted:
> `api_server` was always in `PORT_BINDING_PLATFORM_VALUES`, and `extra` always
> resolved to `['host','key','port']` — **identically on v0.19.1 and v0.20.0**.
> #75348 is about Baileys WhatsApp being *absent* from the allowlist and never
> applied to us; #74505 concerns top-level YAML keys, while our key arrives via
> env, which writes `extra` directly.
>
> The deciding check named below resolves to **present**, so the conclusion it
> was meant to support does not follow. The failure is downstream of config, in
> the adapter's `connect()` / bind.
>
> Left in place rather than deleted: it is an accurate record of what was
> believed on 2026-07-31, and the black-box method is still worth reading. Only
> the root cause and the "wait for upstream" conclusion are wrong — and a wrong
> root cause left standing in a doc misdirects the next attempt, which this one
> already did.

With the `platforms:` block live and mounted (verified inside the container),
`No messaging platforms enabled` **drops to 0** — the platform registers. But
**8642 still never binds**, and the gateway log is silent: no error, no bind
attempt, no traceback. §3.2's four endpoints have therefore **never returned
201**. The Session API is UNTESTED, not proven.

Black-box probing was exhausted at that point (see §3.5.3 — four wrong turns).
Searching upstream issues gave the vocabulary that container archaeology could
not, and two open bugs match the symptom exactly:

- **[#74505](https://github.com/NousResearch/hermes-agent/issues/74505)**
  *"bridge api_server key/cors_origins/model_name from YAML top-level to
  `extra`"* — api_server settings belong in a nested `extra` dict, and
  top-level YAML keys are NOT being bridged into it. Matches
  `_ensure_platform_extra_dict(platforms_data, name)` in `gateway/config.py`.
- **[#75348](https://github.com/NousResearch/hermes-agent/issues/75348)**
  *"Baileys whatsapp platform binds 127.0.0.1:3000 but is absent from
  `PORT_BINDING_PLATFORM_VALUES`"* — there is an allowlist governing which
  platforms may bind a port at all.

Either produces precisely what we saw: platform registers, logs nothing, binds
nothing.

**RECOMMENDATION: stay on v0.18.0 and wait for v0.19.2.** v0.19.1 is a ~1-day-old
release rolling up ~2,789 commits with 8+ open `api_server` bugs. Nothing about
our current setup is broken — v0.18 serves the Session API correctly today — so
there is no pressure to take a release still settling.

**The deciding check, if we want to close it sooner:** is `api_server` present
in `PORT_BINDING_PLATFORM_VALUES`? Absent ⇒ upstream bug, wait. Present ⇒ the
fix is `extra:` nesting in our config and the upgrade is viable now. Worth
running regardless, because **the same `extra` mechanism will govern the Buzz
platform config** — this is not throwaway knowledge, it is a Buzz prerequisite.

### 3.5.5 What is BANKED regardless

- `platforms.api_server` opt-in — merged, verified necessary, harmless on v0.18.
- The s6 supervision change (§3.5.1) — decide it before any bump.
- The digest pin and the v0.18 rollback pin (§4.5).
- This smoke recipe, reusable verbatim against v0.19.2.

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

### 4.4 Ops weight — MEASURED 2026-07-31, it fits

Buzz is a Rust relay plus **Postgres, Redis and S3/MinIO** — a second stack, not
a plugin. So we measured the box rather than guessing.

| | |
|---|---|
| CPU | 8 cores, load 0.85 → **~10% utilised** |
| RAM | 22 GiB total, 6.2 used, **16 GiB available**, no swap |
| Disk | **155 GB free / 21% used** (after the prune below) |
| Running | 17 containers — two Postgres *and* two Redis already |

Sized against what comparable services already cost **on this box**, not docs:

| component | local evidence | estimate |
|---|---|---|
| Rust relay (Axum) | — | 100–300 MiB |
| Postgres | `avg-postgres` **50 MiB**, `agent-postgres` 1.03 GiB | 50 MiB–1 GiB |
| Redis | both live instances **~22 MiB** | ~25 MiB |
| MinIO | — | 200–400 MiB |

**≈0.5–1.5 GiB against 16 GiB free — 3–9% of headroom.** Postgres and Redis are
already proven cheap here, so the stack is heavier in *components* than in
resources. CPU is a non-issue at our message volume. **Verdict: it fits.**

Disk was the only sore point and it was mostly garbage: 76 GB build cache +
32.8 GB stale images. One prune took it from **126 GB used (66%) → 39 GB (21%)**,
reclaiming ~74 GB, with all 17 containers still up:

```bash
docker builder prune -f && docker image prune -af --filter "until=168h" && df -h /
```

**But nothing watches disk.** The seven probes are `product_api`, `chain_height`,
`signer_liquidity`, `capabilities`, `api_latency`, `money_path`,
`treasury_liquidity` — no disk. MinIO stores media, which grows with use rather
than staying flat, and a full disk is a *correlated* failure: it takes the
monitor, the money board and the alert path at the same moment, so the thing
meant to warn you dies with the thing it watches. A `disk_headroom` probe is a
prerequisite for MinIO, on the same logic as `buzz_relay` in §4.3.

### 4.5 Rollback pin — record it BEFORE upgrading

The prune deleted older Hermes images (`v2026.6.19`, and a digest-pinned tag),
so old versions demonstrably do get cleaned. The current image survives only
because it is in use. Rollback target, captured 2026-07-31:

```
nousresearch/hermes-agent:v2026.7.1
sha256:b6c019227889e6675424a2b6223b2cafdd36bf7d1048d1ddd8e043b880d6cc0f
```

Confirm that digest is present (or re-pullable) **before** starting §3, not
after a bad bump. Monitor rollback images are also retained: `sha-9ff2d56`
(current), `sha-8e69416`, `sha-cb6da52`.

### 4.6 Why it is nonetheless the right direction

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
