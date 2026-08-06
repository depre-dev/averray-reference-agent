# INT-4c fresh-UUID mutation contradiction — stopped 2026-08-06

Implementation stopped while designing D4's Harness-store proof. The work
order requires both of these conditions in the same takeover drill:

1. The holder crashes at `after-claim-before-submit`.
2. Mutating the retry to mint a fresh UUID produces two runs in the Harness
   store.

Those conditions are mutually exclusive. At the named crash point the first
process has not submitted a run, so the Harness store contains zero runs. The
takeover retry then submits once. With the correct derived ID the store contains
one run; with a fresh UUID it also contains one run. The UUID differs, but the
required failure signature (two stored runs) cannot occur.

This is not a kernel-idempotency finding. It follows from the ordered side
effects required by the work order:

```text
claim persisted -> injected crash -> no Harness submission -> zero runs
takeover -> one Harness submission -> one run
```

The mutation can become load-bearing in either of two coherent ways:

- apply it to the existing restart-resume drill, whose first process is killed
  after submit and therefore leaves one Harness run before the retry; or
- authorize an additional `after-submit-before-binding` crash point and use
  that point for the fresh-UUID mutation.

In both cases a correct replay converges on the existing run while the mutated
fresh UUID creates a second run. Choosing between those designs changes the D4
mapping/fault-injection scope and therefore remains an operator/architect
decision.

No acceptance check was weakened, and the mutation was not changed to inspect
dispatcher intentions or logs. All incomplete D1–D7 source edits were removed
before this evidence commit so the branch contains only the reproducible D0
probe/evidence and this stop record.

The resume prompt says `docs/CODEX_HANDOFF_PROTOCOL.md` now codifies the
one-attempt instrument-defect rule. The fetched exact-main checkout at
`4164549b146ec87e57d093a926588ea82e17b3e6` does not yet contain that section;
the prompt's explicit adjudication was nevertheless followed for the corrected
D0 rerun.
