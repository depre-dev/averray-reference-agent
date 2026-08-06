# INT-4d drill run record — 2026-08-06

This file is append-only for the packet's disposable drill attempts. A failed
instrument run remains visible beside its corrected rerun.

## Run 1 — instrument failure before environment start

Command: `HARNESS_CHECKOUT=<detached exact-pin checkout> node
scripts/ceremony/run-int4d-drills.mjs`

Observed:

```text
Error: INT4D_HARNESS_PIN_UNAVAILABLE
```

No Postgres container or Harness worker started. Directly running the same
`git checkout --detach 3355f4906864b0f0e0fe5fd5eb5220172e174206` in the
supplied checkout exited 0. The instrument defect was that the runner always
issued a redundant checkout even when the supplied worktree was already clean
and exactly pinned, then discarded Git's error detail. The correction first
reads and accepts an exact HEAD; checkout is attempted only when HEAD differs,
and any checkout failure now retains bounded stderr. The correction is
committed before Run 2 under the protocol's instrument-defect rule.
