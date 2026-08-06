# Work order — INT-4b: quarantines and orphan detectors, detection-only

> Charter: `docs/HARNESS_INT4_CHARTER.md` §3. The rule this packet inherits and
> must not soften: **no auto-remediation.** Detect, alert, mark, stop — and then
> a human decides. "No recovery silently expands authority" begins as no
> recovery at all until detection is proven.
>
> Division of authority, fixed up front: **the watchdog detects read-only; every
> durable write belongs to the dispatcher.** The watchdog's import-surface
> independence is a tested invariant from INT-4a and must survive this packet
> unchanged.

## 0. Record the silences first

Three silences, each demonstrated against current `main` before building, each
seeding a ledger row:

1. **Poison read.** *(Amended 2026-08-06, seventh stop — my premise was wrong
   for one of two failure classes, found by recording against exact main.)*
   There are two classes and only one is silent:
   - **Read failures** (`HarnessReadError` before projection — malformed status,
     store read errors): these DO retry every cycle forever, `unhealthyCount`
     steady, no escalation, no quarantine. The silence is real; record it with
     the liveness proof. D1 quarantines this class.
   - **Projection/containment failures** are ALREADY fail-closed on main
     (`reconcile-run.ts:443-471`): a terminal projection with no resolvable
     outcome refuses with a critical `terminal_projection_unresolved`; anything
     else force-cancels with `lifecycle: "blocked"` and a critical
     `containment_expansion` alert. Not silent, not looping, already parked for
     operator review. No D1 change applies; recording a "silence" here would be
     false. One nit filed separately: plain data corruption receives the
     authority-expansion message, which overstates what happened.
2. **Conflicting binding.** In a disposable reference DB, tamper a binding row so
   `harness_run_id` no longer equals the hash-derived intended run id. Record
   that nothing anywhere notices.
3. **Orphan pair.** Leave a non-terminal task whose bound run does not exist,
   and a live Harness run whose task is terminal. Record that both sit
   indefinitely with no alert.

The kernel-side silence is already on the record: agent-harness#33's thirteen
accumulated containers, oldest 8 days. Cite it; do not re-produce it.

## 1. Deliverable D1 — poison-read quarantine (dispatcher)

When reading or projecting a bound run fails, fingerprint the failure
(error class + stable message hash — **no timestamps, no counters in the
fingerprint**). After `N` consecutive cycles with the same fingerprint
(`HARNESS_DISPATCH_POISON_THRESHOLD`, default 5):

- write a **durable quarantine marker** for the binding (survives restart —
  a table or column, implementer's choice, but it must be visible in
  `harness-pilot status` output);
- raise **one** critical alert naming the work item, fingerprint, and cycle
  count — not one per subsequent cycle;
- stop re-reading that binding each loop. Reconciliation continues for
  everything else.

**Transient failures must not quarantine.** A connection refused, a timeout, a
DB restart — different fingerprint classes, and the threshold resets on any
successful read. The drill in D4 asserts this negative explicitly.

Un-quarantine is an operator verb: `harness-pilot unquarantine --work-item <id>
--version <n> --operator <id> --confirm`, mirroring approve/cancel. Nothing
clears a marker automatically.

## 2. Deliverable D2 — binding-integrity and orphan sweeps

**Watchdog side (read-only, alert-only):** two new probes in the existing
poll loop, using its own SQL — no imports from `services/harness-dispatcher`:

- *binding integrity*: every binding's `harness_run_id` equals the
  UUIDv5-shaped digest derived from (work item, version, approved hash); and no
  two bindings share one run id. Violation → critical alert with both ids.
- *orphans*, age-gated (`WATCHDOG_ORPHAN_AGE_MS`, default 10 minutes):
  non-terminal tasks whose bound run is absent from the Harness store, and
  non-terminal Harness runs bound to terminal tasks. Violation → warn alert
  per orphan, deduplicated by id across cycles.

**Dispatcher side (the write):** the same binding-integrity check runs in the
reconciliation loop; on violation it writes the durable quarantine marker and
stops downstream actions for that work item — §11's own words: *"Quarantine
work item, stop downstream actions, require operator reconciliation."*

Two layers on purpose: kill the dispatcher and the watchdog still detects;
start the dispatcher and the marker appears. The drills exercise both.

## 3. Deliverable D3 — the kernel half (agent-harness#33, detection-first)

A separate kernel PR, same loop as #35:

- containers gain **labels at creation** (run id, created-at) so sweeps match
  precisely instead of by name prefix;
- `harness containers audit` lists non-running `harness-run-*` containers with
  age, run id, and label state — **read-only by default**;
- `--remove` exists but is manual, explicit, and never invoked by any loop,
  timer, or test-teardown-by-accident; the audit's output is the operator's
  evidence for running it;
- the `docker-lifecycle` tests reap their own containers in `finally` — the
  largest contributor (10 of 13) stops accumulating.

Automatic reaping is **out of scope**; if the audit proves a policy is wanted,
that is an operator decision for a later packet.

## 4. Deliverable D4 — drills red-then-green, and the negative drill

| drill | inject | required green |
|---|---|---|
| poison quarantine | malformed bound-run state | quarantine marker within N cycles, exactly one critical alert, other bindings still reconciled |
| quarantine survives restart | restart dispatcher after quarantine | marker still honored, no retry storm resumes |
| **transient is not poison** | stop the Harness DB for a few cycles, then restore | **no quarantine**, reconciliation resumes cleanly |
| conflicting binding | tampered `harness_run_id` | dispatcher marker + watchdog critical alert, both |
| orphan pair | terminal-task/live-run and live-task/absent-run | watchdog warn alerts, deduplicated, age-gate respected |
| kernel audit | containers from a lifecycle test run | audit lists exactly them, with labels; `finally` reap leaves zero |

Mutation proofs, each seen red then restored:

- put a timestamp into the poison fingerprint → the quarantine drill must fail
  (threshold never accumulates)
- skip the marker write → the restart drill must fail
- count transient fingerprints toward the threshold → the **negative** drill
  must fail — the drill that asserts nothing happens must be able to detect
  something happening
- drop one orphan class from the sweep query → the orphan drill must fail

## 5. Deliverable D5 — ledger, runbook, and the seeding recommendation

- Move **Conflicting run binding** to `proven` with drill citations; update the
  mechanism rows for poison quarantine and orphan detectors; add the kernel
  audit as the #33 row's citation. Dated amendments, never rewrites.
- Runbook section: reading quarantine state, the un-quarantine ceremony, the
  audit command, and the thresholds.
- **The seeding-path recommendation**, promised into this handback: with the
  cache/seed path structurally unreachable for kernel-cloned runs (#737 root
  cause), recommend retire-or-consume with evidence. The decision stays the
  operator's; the handback carries the recommendation, not the change.

## 6. What must not change

- **The watchdog's import surface** — its independence test must pass
  unmodified. New probes use the watchdog's own SQL.
- **Lifecycle projection semantics** in `reconcile-run.ts` — quarantine is a
  guard in front of reading, not a change to how terminal runs project. The
  INT-2 suite (14 cases, count sites) and INT-3b suite (29) stay green and
  untouched; 4b's drills live in their own script like 4a's.
- The fence · the burn-in battery and its ledger · ceremony docs · the
  Compose dispatch-profile gating.

## 7. Out of scope

Auto-cancel, auto-reap, auto-unquarantine — any remediation without an operator
verb · lease expiry semantics and takeover (INT-4c) · backpressure (INT-4c) ·
`rubric` · money rail · real repositories · credentials.

## 8. Decisions

1. **Reads detect everywhere; writes live in one place.** The watchdog alerts,
   the dispatcher marks. Two independent detectors, one authority.
2. **Fingerprints are content-stable.** A fingerprint that includes time cannot
   accumulate; the mutation proof exists because this failure is silent.
3. **The negative drill is a drill.** "Transient outages do not quarantine" is
   an assertion that must itself be shown capable of failing.
4. **The kernel half detects before it deletes.** #33's reaper becomes an
   audit; removal is a human action informed by it.

### Operator note

Two new thresholds with defaults (`POISON_THRESHOLD=5`,
`WATCHDOG_ORPHAN_AGE_MS=600000`) — change them only by env. One new pilot verb,
`unquarantine`, gated by `--confirm` like approve and cancel. Nothing else
needs you, and nothing in this packet acts on its own findings.
