# Work order — INT-4d: the full §11 matrix, and the honest close of INT-4

> This is the gate-closer. The INT-4 gate reads: *every drill has deterministic
> detection, containment, recovery, audit evidence, and an owner; no recovery
> silently expands authority or duplicates execution.* This packet makes the
> ledger say that truthfully — which means some rows close as **drilled** and
> some close as **deferred with a named prerequisite**, and the difference is
> never blurred. A faked drill against an unwired seam would be the one sin
> that invalidates the whole ledger.

## Census at order time (verified against main)

15 `proven` · 5 `mechanism-only` · 2 `absent`. The seven non-proven rows
resolve as:

**Drillable now (D2):** Duplicate webhook/event · Harness worker killed
mid-run · Board unavailable · Policy changes after approval ·
Malicious/oversized event.

**Deferred with prerequisite (D3):** Verifier outage *(prerequisite: the
parked `rubric` review — the deterministic verifier runs in-process with the
worker and cannot be "unavailable" separately; only an LLM judge can)* ·
Averray control-plane outage and Settlement replay *(prerequisite: the
economic seam is not wired into harness dispatch at all — the packet that
wires it inherits both drills)* · Direct fallback after Harness failure
*(prerequisite: §9.1's own fallback-retirement ceremony, INT-5 — an operator
decision by construction)*.

## 1. Deliverable D1 — the uniform record and the matrix runner

Every row — proven, newly drilled, or deferred — gets the §11 record:
**detection (what fires, how fast) · containment · recovery · audit refs ·
owner**, plus a `source` field with exactly three values:

- `executed` — this packet's runner ran it, evidence attached
- `cited-ci` — a named, currently existing automated case runs it continuously
  (stronger than a one-shot drill, and said so)
- `deferred` — reason + named prerequisite packet

`scripts/ceremony/run-int4d-matrix.mjs`: executes the executable, **verifies
every citation still resolves** (the cited case name exists in the current
suite file — anti-drift), refuses any row missing a field or a reason, and
renders the ledger. The matrix is the gate's bookkeeper; D4 makes it scream.

Owners are assigned per row (dispatcher operator / actuation operator /
kernel / watchdog / operator-ceremony), confirmed by the operator at merge.

## 2. Deliverable D2 — the five new drills, red-then-green

| drill | inject | required green |
|---|---|---|
| duplicate/out-of-order event | replay the same run reads/events repeatedly and out of order into reconciliation | projection idempotent and monotonic; one binding, one lifecycle transition per real change; no duplicate decisions or alerts |
| worker killed mid-run | `kill -9` the real Harness worker after a durable step; restart it | run resumes or reconciles to a terminal state; **no duplicate protected effect** (capability calls not re-executed twice — count them); watchdog alerted the gap |
| board unavailable | stop every board/UI consumer during a live run | execution continues durably; on restart, projections replay **without any control mutation** (zero writes from the read path, asserted) |
| policy change after approval | change the active policy hash after approval, before dispatch | pre-submit refusal naming the hash mismatch; the already-running manifest stays immutable and is flagged for review, not cancelled |
| malicious/oversized event | feed an oversized payload carrying a secret-shaped string through the read path | 4b quarantine parks it; the sentinel never reaches an alert sink (scrub) or the status output; the watchdog and pilot status stay available throughout |

Mutation proofs, each seen red then restored, at the executed seam:

- make projection non-idempotent (append instead of upsert on one field) → the
  duplicate-event drill must fail on decision count
- let the restarted worker re-execute a completed capability call → the
  worker-kill drill must fail on effect count — this is the *no duplicate
  protected effect* clause and the packet's hardest assertion; say in the
  handback exactly how effects are counted
- let the board's replay path perform one write → the board drill must fail
- skip the policy-hash recheck at dispatch → the policy drill must fail
- disable the oversized-payload size gate → the malicious-event drill must
  fail on sink content

## 3. Deliverable D3 — the deferrals, written like they'll be read in anger

Each deferred row carries: the reason in one paragraph, the named prerequisite
packet, the date, and — where partial mechanism exists — what IS proven today
(e.g. settlement replay: Averray-side idempotency evidence exists outside this
integration; cite it as context, never as the drill). A deferral that
oversells partial evidence is the same sin as a faked drill.

## 4. Deliverable D4 — the matrix must scream

- rename a cited suite case → matrix red (citation drift)
- delete a deferral's reason → matrix red
- drop the owner from any row → matrix red
- mark a `deferred` row `proven` with no evidence ref → matrix red

## 5. Deliverable D5 — the INT-4 exit summary

`docs/HARNESS_INT4_EXIT.md`: the gate's sentence quoted, then the verdict per
clause — which rows closed `executed`/`cited-ci`, which deferred and against
what prerequisite, the drill-count arithmetic (18 proven-or-executed + 4
deferred = 22, or whatever D0's re-census says), measured detection times
where captured, and the operator sign-off block. INT-4 closes when the
operator signs; the summary must be readable by someone who was not here.

## 6. What must not change

Everything shipped: the suites (INT-2 at 14, INT-3b at 29, 4b/4c drills), the
watchdog and its import test, quarantine semantics, lease/claim semantics,
`deriveIntendedRunId`, the kernel (worker-kill drill uses the pinned checkout
exactly as the suite does — if it needs a kernel change, stop), the burn-in
battery and production ledger, fixtures and budgets, Compose gating, fence.

## 7. Out of scope

Wiring economic seams · `rubric` · INT-5 anything · auto-remediation · new
alert channels · fixing #764 or #773 (their own issues) · retire-or-consume
(operator's open decision).

## 8. Decisions

1. **`cited-ci` is a first-class drill source.** A case that runs on every PR
   is stronger evidence than a one-shot drill; the record says which it is.
2. **Deferred-with-prerequisite is a terminal 4d status.** INT-4 closes
   honestly with four deferrals named, or it does not close. Faking a drill
   against an unwired seam is the one unforgivable move.
3. **The worker-kill drill counts effects, not logs.** "No duplicate protected
   effect" is measured in the store the effect lands in.
4. **The matrix runner is itself mutation-proven.** The gate's bookkeeper gets
   the same treatment as everything it books.

### Operator note

Two things become yours at the end: confirming the per-row owners, and signing
the exit summary. The sign-off closes INT-4 — after it, the roadmap's next
stage is INT-5, whose first dependency is the burn-in evidence already
accumulating on your one-command cadence.
