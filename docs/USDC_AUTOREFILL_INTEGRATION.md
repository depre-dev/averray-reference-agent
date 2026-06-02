# USDC Auto-Refill — Integration Contract (platform builds this; the tester relies on it)

- **Status:** Cross-repo integration spec. The **USDC auto-refill is built in the product repo (`averray-agent/agent`)**, not here. This doc pins the *contract* the tester (this repo) relies on, so the platform builds against a fixed target.
- **Date:** 2026-06-02
- **Companions:** [`HERMES_TESTER_UX.md`](./HERMES_TESTER_UX.md) §6.5 (autonomy + spend budget), [`HERMES_TESTER_AUTH_DESIGN.md`](./HERMES_TESTER_AUTH_DESIGN.md), [`AGENTS.md`](../AGENTS.md).
- **Platform reuse:** `mcp-server/.../inventory-replenishment.js` (the *jobs* replenisher — the pattern), `scripts/ops/fund-signer-usdc-deposit.mjs` (the deposit primitive), the `audit-launch-readiness` signer-liquidity check (#520, detection), parked task #20 (the 5-USDC top-up sub-agent).

> **Why this lives in the platform, not the reference-agent.** The platform owns the money plumbing (`AgentAccountCore`, the treasury reserve, the funding primitive, the liquidity detection). Auto-refill *spends treasury USDC and touches signers* — operator/treasury-privileged. The reference-agent is **worker-identity-only** and must never move treasury funds. So: the platform funds; the tester only *reads status*.

---

## 1. The boundary — three nested guardrails, two owners

| Layer | Owner | Job |
|---|---|---|
| **Spend cap** | reference-agent (✅ shipped, #393) | bound how much the tester *spends*/day — `TESTBED_GOLDPATH_MAX_USDC_PER_DAY` |
| **Liquidity refill** | **platform (build this)** | keep poster + worker accounts *funded* above a floor from the treasury |
| **Treasury cap** | platform | bound how much the *refiller* can move/period — so a bug/loop can't drain the treasury |

**Hard rule:** the reference-agent reads status only; **all funding moves are platform/treasury-privileged.** Refilling from the reference-agent would break the worker-identity-only invariant.

---

## 2. The contract — what the tester needs the platform to expose

The tester's autonomous loop runs a **preflight** (the claim-readiness smoke: wallet status + policy budget) *before* it claims. For unattended runs, the platform must expose two things:

### 2a. A liquidity STATUS the tester reads in preflight
A read-only endpoint returning, for each managed test account (poster + worker):

```jsonc
{
  "asOf": "2026-06-02T07:00:00.000Z",   // real on-chain read time (truth-boundary: never cached-stale)
  "chain": "testnet",                    // must be testnet for managed test accounts
  "accounts": [
    {
      "role": "poster",                  // "poster" | "worker"
      "account": "0x…",                  // AgentAccountCore address
      "liquidUsdc": 8.5,                 // AgentAccountCore.positions.liquid (USDC)
      "floorUsdc": 10,                   // refill triggers below this
      "targetUsdc": 50,                  // refill tops up to this
      "refillPending": false,            // a refill tx is in flight
      "lastRefillAt": "2026-06-02T06:40:00.000Z"
    }
  ],
  "treasuryReserveHealthy": true,        // false ⇒ treasury can't cover refills
  "treasuryReserveUsdc": 420             // optional, for the diagnostics panel
}
```

The tester's preflight decision from this status:
- **funded** (both accounts ≥ floor, or refillPending and reserve healthy) → **run.**
- **low + refill pending + reserve healthy** → **skip this tick, retry** (don't claim into a topping-up account).
- **`treasuryReserveHealthy: false`** (reserve can't cover) → **STOP + escalate** — never claim into a guaranteed under-funded run that reverts mid-flow.

### 2b. A "treasury low / refill failing" SIGNAL
When the treasury reserve drops below its own floor, or a refill *fails*, emit a signal the tester surfaces via the **D4 off-device alert bridge** (not just a log line) and **pauses** the autonomous loop until liquidity returns. The operator gets pinged off-device; the tester does not fail mid-run.

**That's the whole interface:** the platform keeps accounts funded + publishes a status + signals when it can't; the tester reads the status in preflight and pauses/escalates if the platform can't cover.

---

## 3. The refill logic (mirror what already exists)

- **Detect** — reuse the #520 `signer-liquidity` check: read `AgentAccountCore.positions.liquid` for poster + worker; below `floor` → `desired = target − liquid` (same shape as `inventory-replenishment.js`'s `desiredInventoryCreates`, but USDC not jobs).
- **Act** — top up from the treasury reserve via `fund-signer-usdc-deposit.mjs` (the deposit primitive), in-process-key pattern. Extends parked task #20.
- **Idempotent** — a refill tx in flight for an account → skip (no double-fund). Log every refill: `{ role, account, amount, tx, liquidBefore, liquidAfter }`.
- **Trigger** — a scheduled tick (or a preflight hook the tester *reads* — never a treasury move the tester *initiates*).

---

## 4. Safety invariants — must match the tester's

- **Testnet-only** for managed test accounts — bind on env/chain (same spirit as the tester's T5 mutation binding); never auto-refill a mainnet account.
- **HALT_FILE + D3 anomaly-pause interlock** — if `HALT` is set or an anomaly tripped, the **refiller pauses**; don't fund into a halted system.
- **Treasury reserve floor + alert** — never drain the treasury; alert (D4) when the reserve itself is low (signal 2b).
- **Per-period refiller cap** (the treasury guardrail) — separate from the tester's spend cap; bounds total auto-moved USDC/period so a bug can't drain.
- **Truth-boundary** — `liquidUsdc` / `treasuryReserveUsdc` reflect **real on-chain balances**, never optimistic or cached-stale; `asOf` is the real read time.

---

## 5. Sequencing — size it from real numbers

1. **Pre-fund** poster + worker manually (~10–20 USDC each) for the first runs. *(One docs-drift run needs ~10 USDC total — defer auto-refill.)*
2. **Run 20–30 real loops**, **measure the net burn** — reward + stake return on settle; the **protocol fee** is the per-loop net burn.
3. **Then** set `floor` / `target` / refiller-cap from that data, and build the threshold service. Don't pick thresholds before you've felt the rate.

---

## 6. Acceptance (for the platform PR)

- A read-only **liquidity status** endpoint returning the §2a shape (real on-chain balances, testnet, poster + worker).
- A threshold **refill** that tops poster/worker from the treasury when below floor → target, **idempotent + logged + per-period-capped**, reusing `fund-signer-usdc-deposit.mjs` + the #520 detection.
- **HALT/D3 interlock** + **testnet-only** binding + **treasury-low D4 signal** (2b).
- Tests: below-floor → one refill to target (not double); HALT set → no refill; mainnet account → never refilled; treasury below floor → signal + no over-draw.
- **The reference-agent change is read-only**: its preflight consumes the status (run / skip / stop-escalate) — it never initiates a treasury move.

---

*End. The platform funds and publishes status; the tester reads status in preflight and pauses/escalates. Cap (reference-agent) + refill (platform) + treasury cap (platform) = three nested guardrails, worker-identity boundary intact.*
