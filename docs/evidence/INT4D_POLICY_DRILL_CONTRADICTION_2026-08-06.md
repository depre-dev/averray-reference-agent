# INT-4d policy-change drill contradiction — stopped 2026-08-06

INT-4d was started from `origin/main` at `6a67650`. The §11 ledger was
re-counted before implementation. Current main contains **13 `proven`, 7
`mechanism-only`, and 2 `absent` rows**, not the work order's stated 15/5/2.
The nine unresolved rows still partition consistently into the order's five
new drills and four deferrals, so this census difference alone did not block
the packet.

The policy-change drill did block it. Its required green has two independent
claims:

1. changing the active policy hash after approval but before dispatch is
   refused by name; and
2. changing it after a run is bound leaves the immutable run manifest intact
   while flagging the run for operator review instead of cancelling it.

Neither claim is reachable from current production wiring:

- `services/harness-dispatcher/src/dispatch-attempt.ts` re-runs
  `agentTaskApprovalHashMatches`. That detects mutation of an approved
  `AgentTask`, including mutation of the policy hash stored inside that task,
  but `DispatchDeps` has no active-policy input and cannot compare the approved
  policy identity with current policy state.
- `services/harness-dispatcher/src/reconcile-run.ts` likewise has no
  active-policy input. `buildProjectionBinding` populates the projected
  manifest policy hash from `task.approval.policyHash`, so reconciliation
  cannot independently observe a later policy change or emit the required
  review flag.
- `createProductionDispatcher` loads neither a dispatch policy nor a live
  policy hash, and the Compose dispatcher service does not mount the policy
  document. This confirms the missing input is a production seam, not merely
  an unexported test helper.

Treating stored-task tampering as the requested active-policy change would make
only the first half appear green through `approval_hash_mismatch`; it would
leave the bound-run review assertion un-fireable. That would weaken the
criterion and is therefore rejected.

Resolution requires one of two explicit architecture decisions:

- authorize a production, read-only active-policy identity seam for dispatch
  and reconciliation, including its configuration/mount boundary and the
  audit behavior for already-bound runs; or
- amend the policy drill to cover approved-task tampering only and remove the
  claim that an independently changed active policy is detected after binding.

No dispatcher, reconciliation, Compose, suite, fixture, budget, kernel pin,
watchdog, burn-in ledger, or production ledger change was made. No drill was
run after this contradiction was confirmed.
