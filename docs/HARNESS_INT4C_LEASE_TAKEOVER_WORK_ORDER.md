# Work order — INT-4c: claim expiry, proven takeover, backpressure

> Charter: `docs/HARNESS_INT4_CHARTER.md` §3. Detection was 4b; this is the
> first packet since #653 allowed to add a *recovery* — and the gate's words
> bind it: **no recovery silently expands authority or duplicates execution.**
>
> Corrected inventory, verified in source before this order was written (the
> charter's own row was half-wrong): the **global dispatcher lease already has
> full expiry-and-steal semantics** — `acquireDispatchLease` steals on
> `expires_at < now()`, renewal and release exist, and the dispatcher wires all
> three (`index.ts:432-434`). What it has never had is a **live two-process
> drill**. The genuinely absent semantics are the **per-work-item claim**
> (`lease_expires_at` written `null`, `dispatch-claim.ts:155`) and
> **backpressure**.

## 0. Record the silences and the unproven

1. **Crash between claim and submit** (§11's first drill, ledger `absent`).
   Against exact main: persist a claim, kill the dispatcher before submit,
   restart it. Record what happens to that work item — expectation: stuck
   forever, no expiry, no retry, no alert. Liveness proof for the loop that
   ignores it.
2. **Global-lease takeover has never been watched.** Two real dispatcher
   processes, kill the holder, record whether and when the second acquires —
   the mechanism exists; the record does not. Also record the converse: with
   the holder ALIVE and renewing, the second process must never acquire.
3. **No backpressure.** With max in-flight already bound, record that dispatch
   attempts produce no named refusal and no operator-visible signal.

## 1. Deliverable D1 — claim expiry and bounded takeover retry

Give the claim's `lease_expires_at` meaning:

- a claim is written with an expiry (env `HARNESS_DISPATCH_CLAIM_TTL_MS`,
  default 10 minutes) and is **renewed only by progress** — binding written,
  run submitted;
- an **expired claim with no binding** becomes retryable: the dispatch loop
  (whichever process holds the global lease) re-attempts it **exactly once**,
  with the **same derived run id** — the idempotent id is the whole safety
  argument, and this packet must not touch its derivation;
- a second failure marks the task `blocked` with a critical alert naming the
  claim generation. No third attempt, ever — bounded means bounded;
- an expired claim **with** a binding is not retryable — reconciliation already
  owns bound runs. The expiry path must check the binding *after* winning the
  claim, not before.

## 2. Deliverable D2 — backpressure, named and quiet

`HARNESS_DISPATCH_MAX_INFLIGHT` (default 1): when non-terminal bound runs reach
the bound, dispatch attempts refuse with decision reason `backpressure` —
visible in `harness-pilot status` — and **one** warn alert on the transition
into backpressure, not one per cycle. Auto-clears when below the bound; a
clearing transition logs but does not alert. Proposal intake and approval are
untouched — the queue may grow; execution is what is bounded.

## 3. Deliverable D3 — fault injection, loud and fenced

The takeover drills need a dispatcher that dies at a precise point. That wants
a crash hook in production code, which is a truth hazard, so it is fenced:

- `HARNESS_DISPATCH_CRASH_POINT` (e.g. `after-claim-before-submit`) is honored
  **only** when `HARNESS_DISPATCH_FAULT_INJECTION=enabled`;
- when armed, the dispatcher logs it at startup at error level and stamps it
  into its heartbeat payload — a watching operator cannot miss it;
- the drills assert the stamp is present during the drill and absent from a
  normally started dispatcher.

## 4. Deliverable D4 — the drills

| drill | inject | required green |
|---|---|---|
| crash before submit → takeover | two processes, holder crashes at `after-claim-before-submit` | second process steals the global lease after TTL, wins the expired claim, submits **the same run id**; Harness holds **one run, attempt 1**; one binding; task proceeds |
| no takeover while alive | holder healthy and renewing | second process never acquires across ≥3 TTL windows |
| restart-resume (existing behavior) | kill after submit, restart | the already-proven exactly-once path still holds with claim expiry in place |
| bounded retry exhausts | crash the retry attempt too | task `blocked`, critical alert, **no third submit attempt** |
| backpressure | fill max in-flight, propose+approve one more | `backpressure` refusal in status, exactly one warn alert, clears when a run terminates |

Mutation proofs, each seen red then restored:

- disable renewal in the healthy holder → the *no-takeover-while-alive* drill
  must fail — a takeover under a live dispatcher is the disaster case, and the
  drill must be able to see one
- make the retry path mint a fresh uuid instead of the derived id → the
  takeover drill must fail **by counting runs in the Harness store**, not by
  inspecting dispatcher intentions — two runs is the signature
- remove the retry bound → the exhaustion drill must fail
- remove the alert-transition dedup → the backpressure drill must fail on
  alert count

## 5. What must not change

- **`deriveIntendedRunId` and the approval-hash guard** — the exactly-once
  anchors. If either needs touching, stop.
- The INT-2 suite (14, count sites), INT-3b (29), the 4b drills, the burn-in
  battery and its ledger.
- The watchdog — untouched entirely this packet; the fault-injection stamp
  rides the heartbeat the watchdog already reads.
- Lifecycle projection semantics; the quarantine marker's meaning.
- The fence; the Compose dispatch-profile gating; ceremony docs.

## 6. Out of scope

Concurrency above 1 (INT-5 territory) · multi-host clock skew (single-host
assumption, stated in the runbook) · auto-unblocking an exhausted task ·
kernel changes — Harness-side idempotency already exists and is the thing the
drill leans on · `rubric` · money rail · credentials.

## 7. Decisions

1. **The takeover proof counts runs in Harness, not intentions in the
   dispatcher.** The mutation that mints a fresh uuid exists precisely to show
   the drill measures the store.
2. **Claims renew by progress, not by heartbeat.** A claim that heartbeats
   while stuck would defeat its own expiry; only binding/submit advance it.
3. **Retry is once.** The §9.1 duplicate-dispatch incident definition is the
   thing a retry loop would eventually violate; one bounded attempt, then a
   human.
4. **Fault injection is stamped into the heartbeat.** A crash hook that can be
   armed silently is a planted lie; one that announces itself is a tool.

### Operator note

Three new env values with defaults (`CLAIM_TTL_MS`, `MAX_INFLIGHT`, and the
fault-injection pair that must never be set outside drills). One behavior
change you will notice: a work item whose dispatcher died mid-claim now heals
itself once, or blocks loudly — instead of sitting silent forever.
