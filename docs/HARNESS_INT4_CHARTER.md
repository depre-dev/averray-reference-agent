# INT-4 charter — hardening as drills, not deliverables

> INT-4's deliverable list is a dozen mechanisms. INT-2 taught us exactly how a
> list like that fails: mechanisms get built, wired to nothing, and accepted on
> paper — then three of four criterion types turn out never to have executed.
>
> So INT-4 is chartered around one rule: **a mechanism does not exist until its
> drill has been seen red without it and green with it.** The drill comes first.

## 1. What the gate actually demands

Plan §17 INT-4 gate: *every drill has deterministic detection, containment,
recovery, audit evidence, and an owner; no recovery silently expands authority
or duplicates execution.*

Plan §11 lists **22 drills**. That table — not the deliverable list — is the
acceptance artifact. The deliverables exist only to make drills pass.

## 2. The drill ledger

`docs/HARNESS_INT4_DRILL_LEDGER.md` (created by packet INT-4a) holds one row per
§11 drill: **status · mechanism · evidence · owner**. Status vocabulary:

- `proven` — a merged suite case or ceremony run demonstrates the required
  outcome, with a citation
- `mechanism-only` — code exists, no drill has ever exercised it
- `absent` — neither mechanism nor drill

INT-4 closes when every row is `proven`. Nothing else closes it.

### Where the 22 rows start (verified against main, 2026-08-05)

Roughly nine drills already have proven mechanisms from the INT-2/INT-3 suites —
the ledger's first job is to cite them honestly rather than rebuild them:

| §11 drill | today |
|---|---|
| Crash after submit, before binding | `proven` — restart suite case (exactly-once held) |
| Approval/task hash mismatch | `proven` — suite case |
| Capability expansion | `proven` — narrow/over-broad + memory.propose cases |
| Budget/deadline exhaustion | `proven` — budget-overrun case; live-cancel additionally proven by CI run 30980968234 |
| Global HALT during run | `proven` — HALT suite case |
| Verifier rejects output | `proven` — negative fixture case |
| PR head changes after handoff | `proven` — identity-mismatch + head_conflict (#740) |
| PR API failure | `proven` — crash-after-create convergence case |
| Verification timeout | `proven` — kernel #35 bounded `command_timeout_seconds` + suite |

And the load-bearing absences, grep-verified:

| mechanism | reality on main |
|---|---|
| durable lease expiry | **column exists, written `null`** — `dispatch-claim.ts:155`. Schema-present, semantics-absent |
| alert channel | JSONL file sink only (`alerts.ts:8`); no consumer, no off-device path |
| external watchdog / source-age | nothing dispatcher-side; all hits are Hermes-stack files — the thing alerts must NOT depend on |
| poison-event quarantine | kernel run-state `quarantined` is handled (`reconcile-run.ts:576`), but no dispatcher-side event quarantine |
| duplicate-binding quarantine | refusal exists at claim time; no detector for divergence after the fact |
| queue backpressure | absent |
| orphan detectors | absent both sides; kernel half is filed as agent-harness#33 |

## 3. Packet sequence

One packet, one gate, one merge — same loop as INT-2/3. Order chosen so
detection exists before anything needs detecting:

**INT-4a — alerts that land somewhere, and a watchdog that isn't us.**
The alert file gains a consumer: a standalone watchdog process (not the
dispatcher watching itself, not Hermes) that tails the alert JSONL, watches the
dispatcher heartbeat for staleness, and watches Harness DB source age. Ships the
drill ledger seeded with the table above. *Drill-first:* kill the dispatcher →
today nothing anywhere notices; the watchdog's first red is that silence.

**INT-4b — quarantines and orphan detectors, detection-only.**
Poison-event quarantine (an event that repeatedly fails projection is parked
with an alert, never infinite-looped), duplicate/conflicting-binding detector,
dispatcher-side orphan sweep (bound runs whose task went terminal, tasks
`running` with no live run), and the kernel container reaper (#33) as its kernel
half. **No auto-remediation in this packet** — detect, alert, stop. The gate's
"no recovery silently expands authority" starts as "no recovery at all until
detection is proven."

**INT-4c — lease expiry, takeover, and backpressure.**
Give `lease_expires_at` semantics: heartbeat-extended leases, expiry on a dead
dispatcher, takeover that provably cannot double-submit (the idempotent run id
already guarantees the Harness side; the drill proves the claim side). Queue
backpressure with a named refusal. *Drill-first:* two dispatchers, kill one
mid-claim.

**INT-4d — run the whole §11 table.**
The drill harness executes all 22 with a uniform evidence record: detection
time, containment, recovery, audit refs, owner. Ledger goes all-`proven` or the
gate stays open. Any drill that cannot be run gets a written reason on its row —
never a silent skip.

## 4. Parallel track — start the burn-in now

§21.2 burn-in (≥3 task families × ≥20 work items) gates INT-5, not INT-4 — but
it accumulates calendar time and is unblocked as of #737. The scripted battery
can run a family rotation whenever the operator has a machine idle. Waiting for
INT-4 to finish before starting it serializes two things with no dependency.

## 5. Deliberately out of INT-4

- **`rubric` criterion review** — the one remaining never-executed mechanism. No
  §11 drill uses it; it needs a design review (an LLM judging acceptability is a
  different trust posture), not a drill. Parked with its own future slot.
- **The unreachable seeding path** — `HARNESS_DISPATCH_DEP_CACHE_DIR` seeding
  cannot reach a kernel-cloned workspace (#737 root cause). Retire-or-consume is
  a cleanup decision, not hardening; folded into INT-4b's handback as a
  recommendation, decided by the operator.
- INT-5 away mode, INT-6 routing, anything touching the money rail.

## 6. Operator decisions needed before INT-4a

1. **Alert channel.** Proposal: the watchdog posts directly to a Slack webhook —
   the org already lives in Slack, and a direct webhook bypasses Hermes, which
   is the §11 requirement (*"alerts remain active while Hermes is unavailable"*).
   File-only stays the dev default. Decide: Slack webhook, or something else?
2. **Watchdog residence.** Proposal: a small standalone process under the
   existing Compose stack with its own restart policy — visible, restartable,
   and not inside the thing it watches. Decide: acceptable?
3. **Burn-in cadence.** Decide: start the §21.2 battery now in parallel (my
   recommendation), or hold until INT-4d?

### Operator note

Nothing in INT-4 touches a credential, the money rail, or a real repository.
Every drill runs against disposable environments, per §11's own first line.
