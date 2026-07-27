# INT-2 finding — git-based acceptance criteria cannot run in the Docker provider

> **Status: product defect, proven by the §2.6 green-path ceremony of 2026-07-27.**
> A work order for a fix, not a fix. Run `4e04ebc1-ad49-530c-89ae-f953e11b9c83`,
> work item `ceremony-lint-format-green-001`.

## What happened

The green path executed **perfectly** up to verification, then failed on a
criterion that never ran.

The scripted model wrote exactly what the committed fixture specifies:

```
CapabilityCompleted  fs.write_file
  bytes_written: 90
  path: docs/harness-int2-green-path-proof.md
PolicyDecisionMade   allow — ["grant_matched", "path_conditions_satisfied"]
```

The produced patch is correct — one file, three insertions, inside the
allowlist:

```
--- /dev/null
+++ b/docs/harness-int2-green-path-proof.md
@@ -0,0 +1,3 @@
+# INT-2 green-path proof
+
+This deterministic change verifies the supervised handoff path.
```

Verification then failed:

```
VerificationCompleted
  id: format-command   passed: false   reason: exit_128   required: true
  detail: stderr:
    fatal: not a git repository:
    /private/var/lib/harness-dispatcher/workspaces/ceremony-lint-format-green-001-v1/
      .git/worktrees/agent-runtime-4e04ebc1-ad49-530c-89ae-f953e11b9c83
  verdict: failed
```

`git diff --check` **never executed**. Exit 128 is git refusing to start, not a
whitespace violation. The run ended `failed / verification_failed`, and the task
correctly produced **no handoff**.

## Root cause

The kernel provisions each run workspace as a **linked git worktree**:

```python
# environments/git_cli.py:84
def add_worktree(repository: Path, destination: Path, revision: str) -> None:
    prune_worktrees(repository)
    _git(["worktree", "add", "--detach", str(destination), revision], ...)

# environments/factory.py:37
workspace_path=root / f"agent-runtime-{spec.run_id}"
```

A linked worktree's `.git` is **a pointer file**, not a directory. It contains
`gitdir: <source-repo>/.git/worktrees/agent-runtime-<run_id>`. Git resolves
every command through that absolute path.

The run then executes in a Docker container where **only the worktree directory
is mounted**. The source repository's `.git/worktrees/…` is not present, so the
pointer dangles and every git invocation fails with exit 128.

The container mount is exactly one directory (`environments/docker_cli.py:136`):

```python
f"{workspace}:/workspace",
```

So the source repository is never visible to the container.

**The defect is the `GitWorkspace` × container-provider combination, and it is
structural** (`environments/workspace.py:119-135`):

```python
if isinstance(spec.workspace, GitWorkspace):
    ...
    git_cli.add_worktree(source, destination, spec.workspace.revision)   # .git = POINTER FILE
    ...
if not destination.exists():
    shutil.copytree(source, destination, symlinks=True)                  # .git = REAL DIRECTORY
```

The non-git path copies a real `.git` directory and would work inside a
container. The git path cannot. The kernel even asserts the pointer shape on
reattach — *"existing deterministic workspace is not a linked worktree"* — so
this is deliberate, not accidental.

**Why it survived:** under the `local` provider the pointer's absolute path
resolves normally, so every existing test passes. No kernel test runs a
git-based acceptance command under the `docker` provider.

**Consequence: no acceptance criterion that shells out to git can pass in the
Docker provider.** That includes `git diff --check` — the criterion used by the
`lint-format` family, and the only criterion in both ceremony fixtures.

## The more serious consequence — §2.5's negative proof is suspect

The negative proof (`ceremony-local-lint-20260727-003`, `finish.jsonl`) writes
nothing and was recorded `failed / verification_failed`. That was read as
*"a model that produces no work yields no handoff."*

But **if git worked, `git diff --check` on an unchanged tree exits 0** — the
criterion would have *passed*. The recorded failure is therefore much more
likely to be the same `exit_128` as this run, i.e. an environmental failure of
the acceptance command rather than a judgement about the model's output.

If so, §2.5 demonstrates *"the pipeline fails a run when the acceptance command
errors"* — not the §21.1 gate statement *"failed verification produces no
submission."* Both runs would have failed for one environmental reason, and the
ceremony would have learned nothing about verification semantics.

**This is not yet proven.** That run's database was disposable and is gone, and
the preserved evidence saved only run-level state (`harness-runs.txt`), not the
`VerificationCompleted` detail. It is testable: re-run the negative fixture once
the defect below is fixed and inspect `reason`. If it is `exit_128`, §2.5 must be
re-run to count.

**Evidence lesson:** the ceremony's §4 capture saves run state but not the
verifier's per-criterion detail. Add `harness run events` (or the verification
report artifact) to the required capture — without it a failure cannot be
distinguished from a *different* failure after the fact.

## The fix (shape, not implementation)

The run workspace must be a **self-contained git repository** inside the
container, or git must be able to resolve its gitdir there. Options, roughly in
order of preference:

1. **Provision by local clone.** `git clone --local <source> <dest>` then
   `git checkout --detach <revision>`. Self-contained by construction: a real
   `.git` directory, its own `objects/`, no `alternates`. `--local` hardlinks
   objects, and the hardlinks live *inside* the destination, so the cost is
   negligible and they survive a bind mount.
2. **Mount the source `.git/worktrees/<name>`** at the exact absolute path the
   pointer names. Fragile — it depends on host/container path identity, which on
   macOS already differs (`/var` vs `/private/var`).

**Rejected: "absorb the gitdir" into a real `.git` directory.** I proposed this
first and it does not work. A linked worktree keeps **no object database of its
own** — it shares the source's. Verified directly: with the source removed, a
worktree stops working while a `--local` clone keeps working. Absorbing the
metadata without the objects yields a `.git` directory that still cannot resolve
a single commit, so the fix must copy objects, which is a clone.

**Do NOT use `--shared`, `--reference`, or `objects/info/alternates`.** Each
recreates precisely the external dependency being removed, and each looks correct
on the host while failing inside the container.

Whichever is chosen, the acceptance step must fail **loudly and distinctly** when
the workspace is not a usable git repository. Right now that condition is
indistinguishable from a legitimate criterion failure, which is precisely how it
went unnoticed through the first ceremony.

**Independent of the fix, provisioning must refuse the broken combination
up front.** A `GitWorkspace` bound to a container provider whose mount cannot
resolve the worktree pointer should raise `EnvironmentProvisioningError` at
provision time — cheap, immediate, and attributable — rather than surfacing three
minutes later as an opaque `exit_128` inside a verifier. Fail at the boundary
that knows why.

**The fix belongs in the kernel, not the ceremony.** Do not work around it by
switching the pilot profile to a non-git workspace: `add_worktree(..., revision)`
is what pins the run to the approved `baseRevision`, and `copytree` would silently
drop that guarantee to make the ceremony green. That is the trade the ceremony
exists to refuse.

## Tests this needs

- A verification run in the Docker provider whose acceptance command is
  `git status`, asserting exit 0 — this fails today.
- A guard asserting the provisioned workspace's `.git` is resolvable **inside**
  the execution environment, not on the host.
- A regression asserting `git diff --check` passes on a clean provisioned
  workspace and fails on one containing trailing whitespace — proving the
  criterion discriminates rather than always erroring.

## What this run DID prove — keep these

- **PR #554 is live-verified.** The run reached `learning_processed` (the real
  terminal state) and the AgentTask advanced to `failed`. It did **not** stick at
  `running` — the exact defect that stranded the previous ceremony. Terminal
  projection now resolves from outcome, live.
- **Approval binding is exact.** `intendedRunId`
  `4e04ebc1-ad49-530c-89ae-f953e11b9c83` was re-derived independently as
  `sha256(workItemId \0 taskVersion \0 approvedTaskHash)` shaped as UUIDv5 —
  exact match.
- **Containment held.** Eight grants, all `delegable: false`, `network: deny`,
  policy allowed the write with `grant_matched` + `path_conditions_satisfied`,
  and the write landed inside `docs/**`.
- **Failure is fail-closed.** One `dispatch_approval`, **zero** `handoff`
  decisions, no PR, no GitHub mutation, lifecycle `failed`.
- **The green fixture itself is correct** and needs no change: 90 bytes at the
  intended path, producing exactly the predicted patch.

## Secondary finding — the §21.1 `maxChildren:0` evidence does not exist

`§21.1` requires reviewing *"the compiled run manifest, with `delegable:false`,
`maxChildren:0`, `maxConcurrentChildren:0`"*, and the runbook says *"Review the
manifest, not just the profile source."*

The compiled manifest contains **no** `maxChildren` / `max_children` field at
all, and the compiled TaskIntent says `max_children: 1`, because:

```ts
// packages/schemas/src/task-intent.ts:98
max_children: z.number().int().positive().safe(),      // 0 is unrepresentable

// packages/averray-mcp/src/task-intent-mapping.ts:68
// Zero-child authority is enforced structurally by a direct-execution-only profile.
// The TaskIntent contract requires these numeric fields to be positive.
max_children: 1,
```

**This is a deliberate, documented decision with a real compensating control, not
an authority escape.** The manifest grants no delegation capability whatsoever
and marks every one of the eight grants `delegable: false`, so no child can be
spawned. Nothing was widened in practice.

But an operator following the runbook literally **cannot verify what the gate
asks them to verify** — the field is not in the artifact they are told to review.
Fix one of the two: reword the gate statement to name the actual structural
control (no delegation capability in the manifest, `delegable:false` on every
grant, direct-execution-only profile), or allow `0` in the schema so the approved
value survives into the compiled contract. The second is preferable: an approval
that says 0 should appear as 0 in the artifact the kernel receives.

## Evidence

Retained at `$CEREMONY_ROOT/evidence/ceremony-lint-format-green-001/`:
`harness-status.txt`, `harness-events.txt`, `harness-deliverables.txt`,
`workspace.patch`, `verification-report.json`, `agent-tasks.json`,
`decision-records.json`, and `../lint-format-green-script.sha256`.

## Operator hygiene note

Two `harness worker` sessions were alive during this run (PIDs 49757 from an
earlier session and 58822 from this one). The correct script ran — the events
show the green fixture's exact bytes — but a stale worker carrying a previous
`HARNESS_TEST_MODEL_SCRIPT` could silently claim a future run and produce a
result attributed to the wrong fixture. The runbook should require proving
exactly one worker before approval, and teardown should assert zero.
