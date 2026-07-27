# INT-2 ceremony replay — work order (local, disposable)

> **This is a work order for one operator-run replay, not a new runbook.** It corrects the
> environment of the failed attempt and pins the identifiers. The procedure itself remains
> `docs/HARNESS_INT2_CEREMONY_RUNBOOK.md`; every section reference below is to that document.

## Why this replay exists, and what changed

The first attempt (`ceremony-vps-lint-20260726-001`, run `c5f3ac8e-758b-5342-82c7-e33d97043d1d`)
failed with `environment_provisioning_failed`. Two root causes were proven:

1. workspace ownership mismatch — the dispatcher prepared the workspace as `10001:10001` while
   the Harness worker ran as root, so git rejected the repository as dubious ownership;
2. dispatcher read timeout — cross-container reads took ~6.3–6.4 s against a 5 s default,
   leaving the projection stuck at `running` (fixed by #550, merged and deployed).

**Both root causes are artifacts of running the ceremony on the VPS, and this ceremony is
specified to run locally.** The runbook mentions the VPS exactly three times, all prohibitions
(§ preamble "stays dormant", §1.6 "Never enable the VPS Compose profile", §5 "Confirm the VPS
dispatch profile was never started"); everything else binds to `mktemp -d` and `127.0.0.1`. The
operator decision of 2026-07-25 likewise specified dispatcher, worker, and both Postgres
instances local and disposable, exactly as INT-1 was run.

**The correction for this replay is therefore the environment, not the code.** Running locally:

- the worker and the workspace share the operator's own UID, so root-vs-10001 cannot arise and
  **no `safe.directory` exception, UID override, or Docker-socket group membership is needed**;
- reads do not cross a contended production host, so the #550 timeout should not be approached.

**Do not apply the VPS-specific corrections** (running the worker as 10001, adding the Docker
socket group, chowning an isolated runtime directory). They are remedies for a problem this
replay removes by construction, and applying them would preserve the defect they mask.

**Standing rule for this replay: no code change unless the replay proves a NEW product defect.**
The environment change is not a code change, and a green replay is not evidence that #550 was
unnecessary — see "What this replay also settles".

## Identifiers (use exactly these)

| Item | Value |
|---|---|
| Ceremony root | `$(mktemp -d -t harness-int2-replay.XXXXXX)` — **local**, never `/srv` |
| Work item | `ceremony-local-lint-20260727-002` |
| Fixture | `lint-format` |
| Harness pin | `be55b348d365e7939b51ea979cee61d7cb210d15` |
| Reference agent | `9ff2d56340542652544049c9ef1218c58a01ac6a` (current `main`, includes #550) |
| Pilot profile SHA-256 | `a52960538f655a50727d8317809d7211df70ef39df826bb6a7af754453b24b6c` |

Do not reuse the failed work item, its task version, or its databases. The previous evidence at
`/srv/int2-ceremony-20260726-001/evidence` and its `HALT` are retained and are not touched by
this replay.

**Hold the Harness pin.** The kernel is now 14 merges ahead of `be55b34` (PKT-034…039 plus the
Phase-7 records). That drift is safe for a consumer — `control/run_workflow.py` is byte-identical
throughout, the default compiled context is byte-identical, and everything else is additive and
operator-invoked — but a ceremony does not bump its pin mid-flight.

## Procedure

Follow the runbook sections in order. This work order only fixes what they parameterise.

1. **§1.1 preflight and pinned checkout** — verify `HARNESS_DISPATCH_ENABLED` is unset, clone the
   kernel into the ceremony root, detach at the pin, assert the commit and a clean tree, record
   it to `evidence/harness-commit.txt`.
2. **§1.2 two disposable Postgres instances** — volume-free, bound to `127.0.0.1:55432` and
   `127.0.0.1:55433`. Apply Harness migrations to the first and `ops/migrations/*.sql` to the
   second. They must not share a database, and neither may be a production DSN.
3. **§1.3 pilot profile** — verify the SHA-256 above and export it as `HARNESS_PROFILE_SHA256`.
   A mismatch is `profile_hash_mismatch` and aborts.
4. **§1.4 local-only artifact and observation paths**, then **§1.5 deterministic worker** with the
   scripted-model seam. Wait for `worker ready`. **Run the worker as yourself** — no UID override.
5. **§1.6 propose → status → approve, dispatch still disabled.** Inspect before approving:
   repository revision, path allowlist, deny-all network, the eight grants, budgets, deadline,
   template hash, verifier hash. Record `approvedTaskHash` and `intendedRunId` from the approve
   output; it does not submit.

```sh
node scripts/ops/harness-pilot.mjs propose --fixture lint-format \
  --work-item ceremony-local-lint-20260727-002
node scripts/ops/harness-pilot.mjs status --work-item ceremony-local-lint-20260727-002
node scripts/ops/harness-pilot.mjs approve --work-item ceremony-local-lint-20260727-002 \
  --version 1 --operator <approved-operator-id> --confirm
```

## The pre-dispatch gate (stop here and show the operator)

Before enabling dispatch, print and have the operator confirm, in one block:

- work-item id and task version;
- `approvedTaskHash` and the intended run id;
- `HALT` state and `HARNESS_DISPATCH_ENABLED` state (must still be false);
- worker UID/GID and the workspace path owner (**they must be the same identity**);
- both DSNs, confirmed disposable and distinct from production;
- the Harness commit and the pilot profile SHA.

**Only after explicit operator confirmation**, start one local dispatcher terminal with
`HARNESS_DISPATCH_ENABLED=true` (§1.6), allow **exactly one** dispatch attempt, and monitor to a
terminal state. **Do not retry blindly.** If it refuses, capture the reason and stop — the
refusal reasons are typed (`approval_hash_mismatch`, `binding_conflict`, `claim_conflict`,
`deadline_expired`, `not_approved`, `executor_not_harness`) and each means something specific.

## Verification

- exactly one Harness run, `attempt=1`, no duplicate run id;
- the AgentTask projection reaches the same terminal lifecycle as the run;
- exactly one dispatch approval/decision record;
- no production database writes; no production Compose dispatcher started;
- no unintended pull request or GitHub mutation;
- no secret or DSN in any output or captured evidence.

Capture per §4: `agent_tasks`, `agent_task_dispatch_claims`, `agent_task_run_outbox`,
`hermes_decision_records` (ordered), the `HARNESS_DISPATCH_ALERTS_PATH` tail, and the dispatcher
heartbeat — all for the exact work item and version.

## What this replay also settles

**Record the observed dispatcher read latency**, whatever the outcome. If local reads land well
under a second, that is evidence the ~6.3–6.4 s figure was host contention rather than a product
characteristic — which does not make #550 wrong (a bounded, configurable timeout is defensible on
its own terms) but does mean the 5 s default was never demonstrated to be too small. Note it in
the evidence bundle either way; do not revert #550 on the strength of one local run.

## Teardown

Disable dispatch immediately, stop the dispatcher and worker, capture evidence, restore `HALT`,
and remove **only** the disposable containers, databases, workspaces, and the ceremony root. The
retained VPS evidence and `HALT` from the failed attempt stay as they are.

## Abort

Runbook §6 governs. An abort is a failed ceremony, not a reason to weaken the proof or retry under
the same task version. If anything is ambiguous, **stop and preserve evidence rather than
retrying** — and if the failure looks like a product defect rather than an environment or
procedure problem, say so explicitly and stop, so it can be specced rather than patched in place.

## Known seam note (not a blocker for this replay)

The approved-task hash does not cover the Harness **profile identity**: the `harness` executor
variant is `{kind, selectionReason}` only, and the profile is pinned separately by
`HARNESS_PROFILE_SHA256` and verified at load. Both are checked, but the two pins are not
cryptographically linked, so "what was approved" does not include "which profile ran".
`bindings.runManifestHash` records what ran after the fact. Acceptable under one operator with a
disposable environment; it should be bound before any real pilot, and belongs in the INT-3 scope
discussion rather than here.
