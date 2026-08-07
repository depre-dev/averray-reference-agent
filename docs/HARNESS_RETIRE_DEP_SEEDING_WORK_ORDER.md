# Work order — retire the unreachable dependency-seeding path

> Operator decision, 2026-08-07: **retire.** The recommendation was delivered
> in INT-4b's handback with evidence; this order executes it.

## Why

The dispatcher seeds a prepared `node_modules` from a cache into the approved
checkout. The Harness kernel then creates a **clean git clone** as the run
workspace, and `node_modules` is gitignored — so the seeded dependencies never
cross into the container. The dispatcher places them somewhere the run never
looks.

That was #737's root cause (`tsc: not found`), and the real fix went elsewhere:
the toolchain is baked into the pilot **image** at `/opt/toolchain`, outside the
bind mount, pinned by image id and verified at build time.

So the seeding path is **correct code on a structurally unreachable route** —
including #726's workspace-symlink preservation and its mutation-proven
containment guard. Left in place it reads as a control: a reviewer sees
dependency provisioning with a security guard and concludes the system works
that way. It does not. That is a truth-boundary defect in the codebase, and the
same class this integration has spent weeks removing from its surfaces.

## 1. Deliverable D1 — prove it unreachable before deleting it

Do not delete on the strength of this order's reasoning. Demonstrate it:

- with `HARNESS_DISPATCH_DEP_CACHE_DIR` set to a **populated, valid** cache,
  run one supervised task through the real dispatcher and kernel, and show
  that the container's workspace contains **no** `node_modules` from that cache
  — while the same task still passes, because the image supplies the toolchain;
- capture the dispatcher's own `dependencySeedOutcome` for that run.

If seeding turns out to reach the container in some path we have not seen,
**stop** — that is a finding that reverses the decision, and it is worth more
than the deletion.

## 2. Deliverable D2 — remove it, wholly

From `services/harness-dispatcher/`: `seedWorkspaceDependencies`,
`DependencySeedOutcome`, `DependencySeedDeps`, their call site in the dispatch
path, and the three refusal reasons `dependency_cache_missing`,
`dependency_cache_stale`, `dependency_seed_failed`.

Also: `scripts/ops/build-dispatch-dep-cache.mjs`, the
`HARNESS_DISPATCH_DEP_CACHE_DIR` exports in the three ceremony scripts, and the
tests that exercise only the removed behaviour. Tests that assert *other*
things through the seeding path get rewritten against what remains, never
deleted to make a diff clean.

**Refusal reasons are a shared vocabulary.** `dispatch-attempt.ts` maps them to
alert severities and the pilot surfaces them. Removing three reasons is a
contract change: confirm no consumer parses them, and say so in the handback.

## 3. Deliverable D3 — leave a signpost, not a silence

A comment where the seeding call site was, and a line in the ceremony runbook:
dependencies come from the pinned pilot image (`ops/Dockerfile.pilot`,
`/opt/toolchain`), because the kernel's clean clone is the run workspace and a
dispatcher-side copy cannot reach it. Cite #737.

Someone will ask "how do dependencies get in?" — the answer must be one grep
away, or this retirement creates a different confusion than the one it fixes.

## 4. Deliverable D4 — prove nothing depended on it

- INT-2 suite 14/14, INT-3b 29, 4b 5/5, 4c 6/6, 4d 6/6 — all green **without**
  the cache dir configured anywhere
- one burn-in batch green through the real path
- full suite, typecheck, build, both Compose configs
- the deleted symbols appear **nowhere** outside historical docs and evidence
  (which are the record and stay untouched)

## 5. What must not change

The pilot image and its toolchain · the fence · lease/claim/quarantine/policy
semantics · `deriveIntendedRunId` · the watchdog · the burn-in battery, its
ledger, and its production evidence · the drill ledger's existing rows ·
historical work orders and evidence files, which record what was true when
written and are never retro-edited.

## 6. Out of scope

Any other cleanup · the pilot image's build · INT-5 · `rubric` · money rail.

## 7. Decisions

1. **Demonstrate unreachability before deleting.** The reasoning is strong and
   the evidence is stronger; a deletion justified only by argument is how a
   real path gets removed by mistake.
2. **A signpost replaces the code.** Removing a wrong answer without leaving
   the right one relocates the confusion.
3. **History is not edited.** The work orders and evidence that describe the
   seeding path stay exactly as written; this order is the entry that
   supersedes them.

### Operator note

Nothing to provision, nothing to decide. After this, `ops/Dockerfile.pilot` is
the single answer to "where do dependencies come from", and the ceremony
scripts stop exporting a variable that never did anything.
