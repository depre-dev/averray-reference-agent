# Ops Auto-Remediation — Design Spec

**Status:** Draft for review. Not implemented. This is the one ops capability that
crosses the standing *"Hermes suggests, never executes"* boundary, so it is
deliberately **opt-in, allowlisted, audited, and reversible-only**. Nothing here
ships without explicit sign-off on the allowlist.

---

## 1. Goal

Let the monitor **act** on a narrow, safe set of failures so transient/infra issues
self-heal without waking the operator — **without ever** touching funds or any
high-blast-radius action. Everything else stays *suggest* (prepare-task) or *alert*.

## 2. Non-goals (never auto-remediated)

Moving funds (signer/treasury top-up) · rolling back a deploy · resetting the
testnet chain · creating jobs or anything touching settlement (Codex's domain) ·
restarting production services. These remain **operator-only**, surfaced as a
prepare-task or a page.

## 3. Eligibility — the bright line

An action qualifies only if **all four** hold. If any is false, it is *not*
auto-remediated:

| Test | Meaning |
|---|---|
| **Reversible** | Undo is trivial (rotate back, re-enable). |
| **Non-financial** | No money moves, ever. |
| **Deterministic** | Exactly one obvious fix for the condition. |
| **Safe-on-misdiagnosis** | If the diagnosis is *wrong*, the action is a no-op, not damage. |

Governing question: *"if the monitor is wrong about the problem, does doing this
make anything worse?"* If yes → it is never eligible.

## 4. Action allowlist (proposed)

Ship **v1 = RPC failover only** to prove the harness on the lowest-risk action;
the rest are one allowlist entry each, added later.

| Action | Trigger | What it does | Reversibility | Risk |
|---|---|---|---|---|
| **`rpc_failover`** *(v1)* | Primary eth-RPC unhealthy (timeout / `1006`) N cycles | Rotate the monitor's read RPC to the next configured backup | Rotate back on recovery | **Low** — pure monitor read path; documented dwellir flakiness |
| `transient_retry` | Single `/health` or RPC hiccup | Retry once before declaring degraded | Inherent | Low |
| `breaker_reset` | A crashed routine left a lock / circuit-breaker stuck past cooldown | Clear the lock/breaker so polling resumes | Re-trips if still broken | Low |
| `worker_redispatch` | A monitor sub-agent crashed / timed out mid-task | Re-run it (idempotency-guarded) | Re-run | **Medium** — needs idempotency; ships last |

> Note: these are all **monitor / infra self-healing**, never product-fund actions.
> `rpc_failover` recovers *our own* read path so a flaky endpoint stops throwing
> false `degraded` — it does **not** fix the product's chain.

## 5. Architecture

Assembles existing parts — the decide/execute split from
`decideProductHealthAlert` / `decideRunwayAlert`, the `autonomy-mode` gate
(PR3a), the autopilot audit/alert plane (PR3b), `self-healing.ts` (B2), and the
D4 `alertChannel`.

```
probe signal ──▶ decideRemediation() ──▶ [gate] ──▶ execute ──▶ audit + alert + narrate
   (detect)         (pure, tested)       │  │  │      (effect)          │
                                         │  │  │                        ▼
                       autopilot ON? ────┘  │  │              verify next cycle
                       not rate-capped ─────┘  │                  │        │
                       breaker not tripped ────┘             resolved   still failing
                                                                 │           │
                                                              log ok    ESCALATE (page a human)
```

- **Decide / execute split.** `decideRemediation(signal, state, cfg)` is **pure**
  and unit-tested; it returns an allowlisted action or `none`. A separate
  effect-injected executor performs it. The monitor can never invent an action —
  only pick from the allowlist.
- **Gate.** Runs only when **autopilot is ON** (`autonomy-mode`, which is
  off-by-default and **auto-expires**). Off → decide still runs but downgrades every
  action to a *suggestion* (the prepare-task path) instead of executing.
- **Edge-triggered + idempotent.** One action per condition, keyed by
  `{action, target}`, not one per poll (mirrors the alert dedup).
- **Circuit-breaker + rate cap.** If the same remediation fires `maxAttempts`
  times without the condition clearing → **stop and page a human**. Global rate cap
  of `maxPerWindow` auto-actions; beyond it → halt + page. It never loops.
- **Verify-loop.** The next probe cycle checks whether the condition cleared →
  resolve + log success, or escalate: *"failed over and it's still down — needs you."*
- **Audit + alert on every action.** A co-pilot narration + an audit record for
  each. **Never silent.**
- **Truth-boundary preserved.** The board still shows *"primary RPC down, reading
  backup"* — not fake-green. The remediation **and** the underlying issue stay visible.

## 6. Data model (sketch)

```ts
interface RemediationSignal { kind: string; target: string; detail: string; confident: boolean; }
type RemediationAction =
  | { type: "rpc_failover"; from: string; to: string }
  | { type: "none"; reason: string };
interface RemediationState {           // persisted per {action,target}, like the alert state
  lastActedAtMs: number;
  attempts: number;                    // consecutive, resets on clear
  breakerTripped: boolean;
}
interface RemediationDecision { action: RemediationAction; nextState: RemediationState; escalate?: string; }
```

## 7. Config / knobs

`OPS_AUTOREMEDIATE_ENABLED` (master, default **off**) · requires autopilot ·
`maxAttempts` before breaker (default 3) · `maxPerWindow` (default 5/h) ·
`cooldownMs` · `PRODUCT_HEALTH_RPC_BACKUPS` (csv of failover endpoints).

## 8. Safety invariants (must always hold)

1. **Off by default**; executes only under autopilot, which expires.
2. **Only allowlisted actions** — never invented, never outside the list.
3. **Never funds.** No action moves money, full stop.
4. **Every action audited + alerted** — never silent.
5. **Circuit-breaker → escalate to a human**; never loops.
6. **Truth-boundary:** the remediation is visible and the underlying issue is not
   masked. Frequent auto-remediation is itself surfaced as an escalation signal.
7. **Fail-safe on uncertainty:** an ambiguous / low-confidence signal degrades to a
   *suggestion*, it does not auto-act.

## 9. Known risk & mitigation

| Risk | Mitigation |
|---|---|
| Masks a real problem (papers over a long outage) | Surface every action + track frequency; frequent remediation escalates |
| Acts on a wrong diagnosis | High-confidence deterministic conditions + reversible actions only |
| Runaway loop | Circuit-breaker + rate cap |
| Scope creep toward funds/prod | Hardcoded allowlist; funds never; high-blast-radius stays human |
| Trust erosion | Off by default, time-boxed, audit everything |

## 10. Rollout

- **Phase 1 — `rpc_failover`.** Proves the whole harness (gate → decide → allowlist
  → execute → audit → verify → escalate) on the safest action.
- **Phase 2 — `transient_retry` + `breaker_reset`.** Allowlist entries + tests.
- **Phase 3 — `worker_redispatch`.** Adds idempotency guards.

Each phase: a pure `decide` extension + effect-injected executor + unit tests
(decide, breaker, verify-loop, gate-off-downgrades-to-suggestion). No path is
live-verifiable until a real trigger occurs — covered by unit tests until then.

## 11. Open questions (for review)

1. **v1 allowlist** — start with `rpc_failover` only? (Recommended.)
2. **Gate** — ride the existing `autonomy-mode`/autopilot switch, or a *separate,
   narrower* `autoremediate` switch so infra self-healing is independent of board
   auto-approval?
3. **Escalation target** — D4/Slack page only, or also a board incident card?
4. **Thresholds** — `maxAttempts` (3?) and `maxPerWindow` (5/h?).
