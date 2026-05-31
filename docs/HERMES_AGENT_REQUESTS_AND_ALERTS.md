# Agent-Requested Tester Runs + the Operator Alert Bridge

- **Status:** Reconciled 2026-05-31. D4 off-device alert bridge shipped earlier (#279) and D1 operator digest/reporting shipped in #294. T6 board-gated agent-requested tester runs and T7 capabilities/platform-helper work remain follow-up/design unless code evidence proves otherwise.
- **Date:** 2026-05-29
- **Companions:** [`HERMES_E2E_TESTER_DESIGN.md`](./HERMES_E2E_TESTER_DESIGN.md), [`HERMES_TESTER_AUTH_DESIGN.md`](./HERMES_TESTER_AUTH_DESIGN.md), [`HERMES_ROADMAP.md`](./HERMES_ROADMAP.md).
- **Problem:** the code-building agents (the ones opening `app:` PRs in `averray-agent/agent`) can't currently start a tester run, don't know the tester's capabilities, and there's no way to reach the operator for approval when they're away from the Mac.

> Three coupled capabilities: **(1)** an agent finishing a build can *request* hard-evidence e2e runs, **(2)** agents *always know* what the tester can do, **(3)** the request lands as a board approval that *reaches the operator off-device*. The alert bridge in (3) is the same signal O4 autopilot will need — build it once, reuse everywhere.

---

## 1. Agent-requested tester runs — board-gated

**Who/when:** a Codex/Claude agent in the platform repo, when a build is finished and it needs hard evidence (a new feature works / no regression).

**Flow (reuses the O3 `proposed → approve → run` gate, for missions):**
1. The agent submits a **run request** (mission type + target route(s)/feature + a one-line "why").
2. It lands on the board as a **proposed mission — needs approval** (a new pending state for agent-requested missions; operator-spawned + deploy-triggered missions stay auto).
3. The **operator accepts it on the board** (the gate you asked for).
4. The `testbed-mission-runner` runs it; the verdict + per-route findings + evidence come back as a mission card.

**Scope/safety:** agent-requested runs are **read-only by default** — surface sweep (T1) or a **targeted read-only mission** against the changed route/feature. Mutating/gold-path missions stay **operator-initiated** (an agent can't request a mutation). Testnet/preview env only; under `HALT_FILE`.

**Entry point (closes the interface gap):** the building agents work in `averray-agent/agent` and likely don't have the Averray MCP. So ship a thin **platform-repo helper** (e.g. `scripts/request-tester-run.sh` / an npm script) that POSTs the request to the canonical queue endpoint **`POST /monitor/testbed-missions`** (slack-operator `:8790`) and prints the board link — **not** the `averray_testbed_agent_mission` MCP tool, which only returns a prompt packet. The reference-agent adds the **proposed → approve gate** on top of that endpoint for agent-requested runs; the platform repo ships the helper so agents have it in-context.

## 2. Tester capabilities manifest — always known

So agents *at all times* know what's possible (no guessing):
- **A machine-readable manifest** the agent fetches at `GET /monitor/tester/capabilities` on the monitor. Contents: mission types (`surface_sweep`, `targeted_read_only`, `gold_path` [operator-only]), per-type **scope** (read-only vs mutating), supported **envs**, **how to request** (the helper/endpoint), the **approval gate**, and the **result shape** (verdict + findings + evidence links). The manifest is authenticated like the monitor and is intentionally honest about what is available now versus planned.
- **A human/agent-readable pointer in the platform `AGENTS.md`** ("How to get hard evidence for your change") so the building agents *discover* it without being told.

## 3. The operator alert bridge — off-device

Today the board only has **browser** notifications (#232: tab badge, desktop notify, audio) — all need the tab open. The gap is reaching you on your phone.

- **Trigger (decision):** the board's **ACTION-NEEDED count 0 → ≥1** — one unified rule covering approval requests (tasks *and* tester missions), blocked PRs, failures, and later **O4 autopilot escalations**.
- **Channel (decision):** **Slack now** (reuse `SLACK_WEBHOOK_URL`; the Slack mobile app gives phone push for free). Build it behind a **pluggable adapter** so a **dedicated push** (ntfy / Pushover / native) drops in later, once the **mobile monitor** exists.
- **Content:** what needs you + a **deep link to the board card**.
- **Controls:** quiet-hours / **mute** (reuse the board's existing mute control); **de-dup** — one alert per 0→≥1 transition, re-alert only on new distinct items or after a cooldown (no spam).

**Why it's foundational:** this is the same "you're needed" signal for the tester approval, the dispatch approvals, blocked PRs, and **O4 autopilot escalations**. Autopilot is unusable if "Hermes needs you" can't reach you off-device. So the alert bridge is a **safety-net + O4 prerequisite**, not a side feature.

---

## Decisions (resolved)

| Decision | Resolution |
|---|---|
| How agents start a run | **Request → operator approves on the board → runs** (per-run gate; agent-requested = read-only) |
| Alert channel | **Slack now; dedicated push later** (pluggable adapter; push lands with the mobile monitor) |
| Alert scope | **Any "action needed" (0→≥1)** — unified; with quiet-hours/mute + de-dup |
| Capabilities discovery | **Manifest endpoint + a pointer in the platform `AGENTS.md`** |

## Build sequence

1. **Alert bridge (Slack)** — highest leverage: unblocks "step away," and it's the O4 prerequisite. *(Shipped as D4 in #279; D1 operator reporting shipped in #294.)*
2. **Agent-requested run endpoint + the proposed-mission approval gate** on the board. *(reference-agent)*
3. **Capabilities manifest** + the **platform-repo helper** + the **platform `AGENTS.md`** pointer. *(manifest endpoint = reference-agent; helper + AGENTS.md = platform repo follow-up)*

## Roadmap fit

- Alert bridge → **D-stream** (operator trust) + safety-net / O4 prerequisite.
- Agent-requested runs + capabilities manifest → extend the **T-stream**.
- (Add IDs to `HERMES_ROADMAP.md` when these are scheduled.)

## Invariants / safety

- Agent-requested runs are **read-only + board-gated**; mutating stays operator-initiated.
- Alerts respect **quiet-hours/mute**; everything under `HALT_FILE`; merge/deploy stays human.
- The capabilities manifest is the **honest** contract — it lists only what the tester actually supports, per the truth-boundary discipline.

---

*End. Reconciled 2026-05-31: D4 and D1 are shipped; T6/T7 stay follow-up/design here.*
