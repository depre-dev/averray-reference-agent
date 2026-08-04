# Work order — dependency seeding cannot seed an npm-workspaces repository

> Third wall on the task-family packet, and the third real finding. The
> implementer stopped before dispatch each time; each stop was worth more than
> the implementation would have been.
>
> This one is a defect in a **production path**, not a fixture.

## The failure

```
name=WorkspacePrepError
reason=dependency_seed_failed
message=Cached dependencies could not be copied into the prepared workspace
```

Reached with a cache the builder reported as successful.

## Why it has never been seen

The dependency-seeding path has never run in a passing case.
`workspace-prep.ts:167` returns `"skipped"` when `HARNESS_DISPATCH_DEP_CACHE_DIR`
is unset, and the only wired task family's sole criterion is `git diff --check` —
which needs no `node_modules` at all.

So this is the same shape as `search` and `baseline_comparison`: a mechanism
that exists, sits in the production path, and has never executed. Three of them
in one packet.

## The mechanism

`workspace-prep.ts:265-279`:

```js
await resolved.cp(cachedNodeModulesReal, staging, {
  recursive: true,
  dereference: true,                                  // (1)
  filter: async (source) => {
    const sourceReal = await resolved.realpath(source);
    assertContainedOrEqual(cachedNodeModulesReal, sourceReal, …);   // (2)
    return true;
  },
});
```

npm workspaces link each local package into `node_modules`:

```
node_modules/@avg/mcp-common -> ../../packages/mcp-common
```

Both options reject that link, independently:

1. **`dereference: true`** copies the link's *target*. The cache holds only
   `node_modules`, so the target is absent and `realpath` throws.
2. **The containment filter** asserts every entry resolves *inside the cached
   `node_modules`*. A workspace link leaves `node_modules` **by design**, so even
   with the target present it reads as an escape attempt.

(2) is the one that matters. Fixing only (1) leaves the seam broken.

## What the guard is actually for — do not delete it

`assertContainedOrEqual` stops a **poisoned cache** from copying arbitrary host
paths into the prepared workspace. A cache directory is attacker-influenceable in
a way the repository is not: anything that can write a symlink there could
otherwise pull in `/etc`, a wallet keystore, or a signer file.

That threat is real and the guard is right. It is simply also rejecting a link
that npm legitimately creates.

## 1. Deliverable D1 — preserve workspace links as links

Stop dereferencing. Copy a symlink whose target is a workspace-relative path
**as a symlink**, unchanged.

This is safe because of *where* it lands: in the prepared workspace,
`node_modules/@avg/mcp-common -> ../../packages/mcp-common` resolves to
`<workspace>/packages/mcp-common`, which exists — the workspace is a checkout of
the repository at the pinned base revision. The link is broken only inside the
cache, and the cache is not where it is used.

## 2. Deliverable D2 — re-base the containment guard, do not remove it

The guard must keep refusing escapes while accepting workspace links. The
question it asks is currently *"does this resolve inside the cache?"*. It should
ask, for a symlink:

**does its target resolve inside the prepared workspace root?**

- resolves inside the workspace → accept, copy as a link
- resolves outside both the workspace and the cache → **refuse**, unchanged
  reason `dependency_seed_failed`
- absolute target, or a target containing `..` that escapes the workspace →
  **refuse**

Resolve without following the link off-workspace: a dangling or escaping link
must be classified by its *declared* target, not by calling `realpath` on it and
seeing what the host happens to have.

## 3. Deliverable D3 — prove the guard still bites

This is what I will gate hardest, and it is the whole risk of this packet: a
relaxed guard that no longer refuses anything looks exactly like a fixed one.

Three tests, each shown failing when the guard is removed:

| cache contains | must |
|---|---|
| `@avg/mcp-common -> ../../packages/mcp-common` | **seed**, and land as a symlink |
| a link to an absolute host path (`/etc/passwd`, a temp file outside both roots) | **refuse**, `dependency_seed_failed` |
| a link with enough `..` to escape the workspace root | **refuse**, `dependency_seed_failed` |

Do not use a real sensitive path in the test. A temp file outside both roots
proves the same thing.

**Report the deliberate red for the two refusal cases**, not only the green. A
containment guard that has only ever been seen accepting is not evidence of
anything — and this repository has now found that same defect shape three times
in one packet.

## 4. Deliverable D4 — the seam runs end to end

After the fix, a task whose criterion is `npm test` or `npm run typecheck` must
reach a terminal lifecycle through the real dispatcher, with dependencies seeded
from cache. Report the in-container elapsed time; the task-family packet needs
that number and has never been able to measure it.

## 5. What must not change

- **The refusal reasons.** `dependency_seed_failed` and its siblings are mapped
  to alert severities in `dispatch-attempt.ts`. Adding a reason is fine; renaming
  or repurposing one is not.
- **The lockfile and manifest verification** ahead of the copy.
- **`reconcile-run.ts`**, the payload actuator, the sender, the eleven existing
  cases, their fixtures and budgets.
- **The kernel.**
- The fence: eight vetted capabilities, `network: deny`, non-delegating.

## 6. Out of scope

Wiring the three task families — that packet resumes after this lands · changing
what the cache builder produces, unless D1/D2 prove the cache itself is
malformed, in which case stop and say so · the INT-3 send · the money rail.

## 7. Decisions

1. **Preserve links; do not dereference.** The link is valid where it is used and
   broken only where it is stored.
2. **The guard is re-based, never removed.** Its threat model — a poisoned cache
   reaching outside itself — is real and survives this change intact.
3. **A symlink is classified by its declared target, not by `realpath`.** Asking
   the host what a dangling link points at is how the workspace case became
   indistinguishable from an attack.
4. **The refusal tests are the deliverable.** The seeding success is easy; proving
   the guard still refuses is the part that can silently be got wrong.

### Operator note

Nothing here touches a credential or a real repository. It unblocks the task
families and, separately, is the reason no task requiring `node_modules` has ever
completed through supervised dispatch.
