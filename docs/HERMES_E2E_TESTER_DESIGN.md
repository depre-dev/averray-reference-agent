# Hermes E2E Tester — Design (the product tester)

- **Status:** Reconciled 2026-05-31. T2 pre-seeded session (#293), T3 SIWE role-gating (#290), and T5 env→mutation binding/enhancements (#297) have shipped. T6's first board-gated request/approve slice is in flight here. T4 Tier-2 agent and T7 capabilities/helper work remain follow-up/design unless code evidence proves otherwise.
- **Date:** 2026-05-29
- **Lives in:** this repo (`depre-dev/averray-reference-agent`) — the testbed/mission code is here.
- **Tests:** the platform product `averray-agent/agent` — the Polkadot Agent Platform ("Averray"): an agent-first job/treasury runtime on Polkadot Hub TestNet.
- **Roadmap fit:** matures the existing testbed missions into a real product tester. The Tier-2 agent is **Theme C's first specialized agent** (built on the P2 per-agent-runner pattern), and failed missions are a **Theme B2 self-healing trigger**.

> Honest starting point: the mission *pipeline* is ~80% built (queue, lifecycle, heartbeat, structured report, evidence/screenshots, board MissionDrawer, two executors, MCP entry). What's thin is the *brain* — the Playwright executor (`services/slack-operator/src/testbed-mission-runner.ts:265`) is a single-step heuristic smoke test; the `command` executor (`:191`, passes the mission + a `reportPath`) is an empty hook where the real agent belongs; missions run a clean browser with **no wallet**, so they can only see public pages.

---

## What's under test (the platform)

Averray's premise: *external agents claim jobs, do the work, get paid on-chain.* So the tester must cover:

- **Auth gateway (SIWE):** `/auth/nonce` → `personal_sign` → `/auth/verify` → JWT; roles `admin`/`verifier`. Everything protected is behind this.
- **The agent gold path (core loop):** onboard (`/onboarding`) → discover (`/jobs`) → claim → submit → verify → escrow payout + reputation SBT → receipt. (= `npm run demo:e2e:remote`: API + SIWE + wallet.)
- **Operator app (authed UI, `app/`):** overview, runs (+detail), sessions, receipts, treasury, disputes, policies, agents, audit-log, capabilities — each must render **real / degraded / empty** honestly.
- **Public surfaces:** `/`, `/onboarding`, `/jobs`, `/strategies`, `/agents/:wallet`, `/badges/:sessionId`, the public site, `agent-tools.json`, the SSE `/events` stream.
- **Chain/settlement** (EscrowCore, TreasuryPolicy, ReputationSBT, disputes/arbitration) — reflected in the receipts/treasury/disputes UI.

**Reframe:** the perfect tester *is a customer* — an external agent attempting the gold path, which is exactly what the mission prompt (`packages/averray-mcp/src/operator-testbed.ts:77`) already describes.

---

## Two-tier design  (decision #1)

### Tier 1 — surface smoke  ·  cheap, deterministic, every deploy
The existing heuristic Playwright path, broadened:
- Walk every operator page + public surface; assert it loads with no console errors / no 4xx-5xx / no failed requests.
- **Truth-boundary honesty check (distinctive):** assert each surface labels its state honestly — a degraded page says "degraded," empty says "empty," demo says "demo," local-simulation says so. This makes the tester enforce the project's truth-boundary discipline.
- Fast, broad, runs as the per-deploy gate.

### Tier 2 — agent gold-path missions  ·  deep, judged, scheduled/on-demand
A real LLM agent with a dedicated testnet wallet attempts the actual journeys like a customer, stops before anything not clearly testbed-only, and judges *"could an outside agent succeed, and was the product honest about its state?"* LLM-judged verdict + scores (the report shape already supports it). This is the real signal.

---

## Tier-2 executor  (decision #2): Claude Agent SDK + Playwright-MCP

- **Driver:** Claude Agent SDK driving a **DOM-aware Playwright MCP** for browser surfaces, **plus an HTTP/wallet tool** for the API gold path (claim/submit/verify are API calls, like `demo:e2e:remote`). The Agent SDK gives tool-scoping, permission modes, streamed progress, and **structured output** for the report.
- **Wiring:** runs through the existing **`command` executor hook** (`testbed-mission-runner.ts:191`) — the runner passes the mission + a `reportPath`; the agent writes its structured report there; the runner ingests it. No pipeline rewrite — bring the agent.
- **Reuse the P2 worker pattern:** the Tier-2 agent is a specialized per-agent runner (its own command + heartbeat), so it slots into the multi-agent model rather than being a bespoke thing.

> **Canonical queue path (don't get this wrong):** missions are queued via **`POST /monitor/testbed-missions`** (slack-operator, `:8790`) — that's the path that supports `mode` (e.g. `surface_sweep`) + `routes`. The `averray_testbed_agent_mission` MCP tool only returns a *prompt packet* (`targetUrl`/`goal`, no `mode`/`routes`, no queueing) — **do not use it to start a run.** (Confirmed while wiring the post-deploy sweep — platform PR #604.)

---

## Wallet & auth  (decision #3): real SIWE via a signer sidecar

- A **signer sidecar** holds the dedicated testnet key and signs SIWE nonces on request. The agent calls it; **the key never enters the model context** (matches `averray-agent/agent` → `docs/EXTERNAL_AGENT_WALLET_ONBOARDING.md`).
- The **auth mission** exercises the real flow end to end (nonce → sign → verify → Bearer); **broad surface missions** reuse a **pre-seeded session** (injected JWT / Playwright `storageState`) so they don't re-auth every run.
- This is the keystone unlock: it's what lets the tester reach the authed product (most of it), not just public pages.

---

## Environment & mutation profile  (decision #4: recommended)

**Environment dictates what a mission may mutate — enforced, not assumed.**

Implementation note (T5 slice): queued missions now carry `environment`,
`mutationMode`, `mutationScope`, and `mutationBindingReason`. `allowTestMutations`
is only honored for `local`, `testnet`, or `staging`; `mainnet`, `preview`, and
`unknown` are rebound to read-only even when a request asks for mutations. The
Playwright executor also records trace/video artifact references and attaches a
baseline comparison when a previous completed run exists for the same target,
goal, and environment.

- **Now (testnet-only):** target the **hosted testnet stack** with a dedicated, funded test-agent wallet. Mutating gold-path missions are safe *by construction* (testnet/mock DOT, no real value). Tag test data (dedicated wallet + recognizable test-job namespace) so it's filterable/cleanable. Optionally add a **local-Anvil tier** (`demo:e2e`) as a cheap per-PR smoke that never touches shared testnet.
- **Bind every env to a mutation profile now**, even with one env: tie the runner's `allowTestMutations` / `mutationMode` / `mutationScope` to the environment so a mutating mission against the wrong env is *structurally impossible*.
- **At mainnet:** mutating gold-path missions stay on **testnet/staging forever**; **mainnet gets read-only smoke + read-only `TBE2E` checks only** — never a real-funds mutation. A dedicated **staging deploy** becomes worth building then (don't mutate the env real users hit). Per-PR ephemeral envs: defer until that pain is real.

---

## Mission catalog (the concrete tests)

| Mission | Tier | Mutates | Notes |
|---|---|---|---|
| Public surfaces load + boundary-honesty | 1 | no | `/`, `/onboarding`, `/jobs`, site, `agent-tools.json` |
| Operator pages render (authed) | 1 | no | overview/runs/sessions/receipts/treasury/disputes/policies/agents/audit-log/capabilities — needs pre-seeded session |
| SIWE sign-in end to end | 2 | no (auth only) | nonce → signer sidecar → verify → Bearer; the real auth flow |
| Agent gold path | 2 | testbed | onboard → claim → submit → verify → payout + SBT → receipt, on testnet; stop before any non-testbed mutation |
| Dispute / arbitration path | 2 | testbed | exercise dispute reason-codes + arbitration UI on testnet |
| Receipts / treasury reflection | 2 | no | confirm on-chain settlement is reflected truthfully in the UI |

Each mission's verdict is LLM-judged (Tier 2) or rule-checked (Tier 1); both record the existing structured report (verdict, path, blockers, evidence, scores, mutation-boundary, recommendations).

## Enhancements (beyond wiring the brain)

- **Multi-step goal pursuit** (the agent actually completes the journey, not one safe click).
- **Playwright trace + video** evidence (today only screenshots) — richer debugging.
- **Regression baselines:** diff a mission's report against the prior run for the same target+env (runs are already persisted) → surface regressions automatically.
- **Self-healing hook (B2):** a failed mission auto-opens a routed fix task (UI regression → Claude; settlement/chain → Codex), gated by the dispatch guardrail + autonomy mode.

## Decisions (resolved)

| # | Decision | Resolution |
|---|---|---|
| 1 | Tester shape | **Two tiers** — deterministic surface smoke + LLM-agent gold-path missions |
| 2 | Tier-2 executor | **Claude Agent SDK + Playwright-MCP** (+ HTTP/wallet tool), via the `command` hook |
| 3 | Wallet & auth | **Real SIWE via a signer sidecar** (key isolated); pre-seeded session for surface missions |
| 4 | Environment | **Hosted testnet + dedicated wallet now; env→mutation-profile binding; mainnet read-only-by-design later; staging/ephemeral deferred** |

## Build sequencing

1. **Tier 1 hardening** — broaden the heuristic executor to all surfaces + add the boundary-honesty check + add a **pre-seeded session** so it can reach authed pages. (T2 pre-seeded session shipped in #293.)
2. **Signer sidecar + SIWE mission** — the keystone unlock for authed testing. (T3 role-gating mission shipped in #290; sidecar foundation shipped earlier in #283.)
3. **Tier-2 agent executor** (Agent SDK + Playwright-MCP + HTTP/wallet) via the `command` hook — the gold-path missions.
4. **Env→mutation-profile binding** (do before any mainnet exists). (T5 shipped in #297.)
5. **Enhancements** — trace/video, regression baselines, B2 self-healing hook.

## Invariants / safety

- Missions **stop before any mutation that isn't clearly testbed-only**; environment gates what's even attemptable.
- **Never run a mutating mission against mainnet** (read-only there, by design).
- The wallet **key never enters the model context** (signer sidecar).
- Tier-2 is a specialized agent under the same guardrail + `HALT_FILE` as every other agent; merge/deploy stays human.

---

*End of E2E tester design. Reconciled 2026-05-31: T2, T3, and T5 have shipped; T6 first slice is in flight; T4/T7 remain follow-up/design.*
