# INT-3 work order — the actuated handoff

> Work order, not an implementation. Written **before** the §3 paid run, so that
> run's evidence is captured against what INT-3 actually needs rather than
> reconstructed afterwards.
>
> INT-2 proves the machine **refuses correctly and stops before acting**. INT-3
> is where it acts. That is a different class of risk and deserves its own
> contract.

## Why this exists

Everything proven to date is *refuse-and-stop*. Nine — now ten — suite cases,
and every one of them ends with the system declining to do something, or
producing a handoff that deliberately actuates nothing:

```
services/harness-dispatcher/src/reconcile-run.ts:1084
    effects: { mutates: false, mutations: [], … }
    next.action: "Operator reviews the verified handoff; no PR is opened automatically."
```

INT-3 makes that `mutates` true for the first time. The system stops being a
thing that judges and becomes a thing that *does*, outward, where other people
can see it.

Three facts frame the whole design:

1. **The agent cannot open a PR and must never be able to.** The vetted
   capability set is eight entries — `fs.read_file`, `fs.write_file`,
   `fs.list_files`, `shell.run`, `git.status`, `git.diff`, `artifact.put`,
   `artifact.get` — with `network: deny`. No GitHub write, no network.
2. **No PR-open path exists anywhere in this repository today.** INT-3 is
   net-new outward authority, not the wiring-up of something already present.
3. **The boundary is already a contract.** `verifiedHandoffV1Schema` gates
   `eligibleForPrOpen` on `outcome === "completed" && verification.verified &&
   every check passed`, and carries an optional `pullRequest` slot waiting to be
   filled. INT-3 implements the seam that contract was written for; it does not
   redesign it.

## 1. The central decision — the agent never gets GitHub write

The PR is opened by a **separate actuator**, outside the agent's authority,
consuming a typed `VerifiedHandoff`. The agent's fence does not change.

This is not caution for its own sake. It is what preserves the property the plan
already ratified (PLAN:236-242): *no single agent may request, execute, finally
approve, and settle the same action*, and *verifier and executor identities must
be distinct for the same run*. If the executing agent could open the PR, it
would author, verify, and actuate its own work.

It also has a practical consequence worth stating plainly: **because the agent's
capability set is unchanged, every INT-2 proof still holds after INT-3 ships.**
Widening the fence instead would invalidate the entire evidence bundle we are
about to assemble.

The actuator takes typed IDs and artifacts, never an unrestricted shell string —
the same rationale that produced a dedicated dispatcher rather than a replayed
prompt (PLAN decision 3).

## 2. Staged: INT-3a produces the payload, INT-3b sends it

**INT-3a — the payload, with zero outward effect.** The actuator computes the
complete PR payload (base, head branch, title, body, and the exact patch) and
writes it as an artifact. It opens nothing. No credential is required to run it.

**INT-3b — the same payload, actuated once, supervised.**

The staging is the same discipline that produced the scripted pair before the
paid run, and it buys something specific: **a payload artifact can be diffed
byte-for-byte against what actuation would send. A PR you have already opened
cannot be.** Every refusal path below is provable in 3a, for free, before any
credential exists.

Do not collapse the stages. 3a is where the mechanism is proven; 3b is one
supervised action whose only new variable is the network call.

## 3. Deliverable D1 — the actuator boundary

A component that consumes a `VerifiedHandoff` and produces either a PR payload
(3a) or exactly one pull request (3b).

- runs **outside** the agent container and never shares its filesystem,
  environment, or credential;
- accepts the typed handoff plus content-addressed artifacts — never a shell
  string, never a branch name supplied by the model;
- is the only component in the system holding GitHub write.

## 4. Deliverable D2 — re-verify at actuation time; the stored flag is a cache

`eligibleForPrOpen` is a **recorded** boolean. Do not trust it.

At actuation time, independently recompute eligibility from `outcome`,
`verification.verified`, and every entry in `checks`, and re-run
`assertVerifiedHandoffMatchesTaskAndRun`. Re-check the approval hash against the
task exactly as dispatch does. If the recomputed value disagrees with the stored
one, **refuse and escalate** — a disagreement means something upstream is wrong,
and it is precisely the case where acting is worst.

This is the approval-hash-mismatch lesson pointed at the other end of the
pipeline. A stored flag that is read but never re-derived is a check that has
stopped checking.

## 5. Deliverable D3 — content identity: the PR contains exactly what was verified

Bind the PR to the verified artifact by hash, not by re-deriving it:

- the head commit's tree must equal the result of applying `deliverables.patchRef`
  to the task's `baseRevision`;
- every path the patch touches must still satisfy `repository.allowedPaths`,
  re-checked at actuation, not inherited from verification;
- **if the base has moved, refuse. Do not rebase.** A rebased PR contains a
  merge result that no verifier ever saw. Re-verification is a new run, not an
  actuation concern.

This is the same failure that made `af9f133` dangerous: work shipped that nobody
had reviewed, because the thing that moved was not the thing that was checked.

## 6. Deliverable D4 — exactly one PR, across restart, retry, and replay

INT-2 solved run identity with a deterministic id derived from
`sha256(workItemId \0 taskVersion \0 approvedTaskHash)`. Actuation needs the
equivalent, and it must be checked against **GitHub's** state, not only local
state — a crash between "opened the PR" and "recorded that we opened it" is
exactly when a local-only check fails.

- derive the head branch name deterministically from the same inputs;
- before opening, query for an existing PR with that head and adopt it if found;
- prove it by replaying the same handoff after a simulated crash at each step.

## 7. Deliverable D5 — the effects record must stop lying

`effects.mutates: false` is hardcoded at `reconcile-run.ts:1084` and is correct
today. The moment a PR can be opened it becomes false evidence.

Compute it: `true` with the PR mutation ref when a PR was opened, `false`
otherwise. Add an invariant that fails if the literal `mutates: false` is
reintroduced on the actuation path — the same shape as the exit-code-uniqueness
guard, for the same reason: **the instance is easy to fix and invisible to
re-introduce.**

A decision record that says `mutates: false` about a run that opened a PR is
worse than no record. It is the truth-boundary rule applied to our own audit
trail.

## 8. Deliverable D6 — HALT covers actuation

Global and repository HALT already override dispatch. They must also refuse
actuation. Prove it directly: HALT set, eligible handoff present, **no PR
opened**.

An eligible handoff sitting in the queue when HALT is declared is the exact
situation HALT exists for.

## 9. Deliverable D7 — the credential boundary

- write-scoped to **exactly one repository**; no organisation-level scope;
- never present in the agent container, the model's environment, or any
  evidence artifact;
- never passed as a CLI argument;
- evidence records the **identity** used and the repository it was scoped to,
  never the token;
- rotation and revocation documented **before** first use, not after.

## 10. Deliverable D8 — the refusal ceremony, before any real PR

Mirroring §2.5/§2.6, and entirely runnable in 3a:

| Case | Must produce |
|---|---|
| unverified handoff | no PR, named refusal |
| ineligible — one failed check | no PR, named refusal |
| patch touches a path outside `allowedPaths` | no PR, naming the path |
| `baseRevision` no longer current | no PR, naming the drift |
| HALT active | no PR, naming HALT |
| stored `eligibleForPrOpen` disagrees with recomputed | no PR, escalation |
| eligible and clean | **exactly one** payload / PR |
| the same handoff replayed | still exactly one |

Each must be **proven able to fail** — broken deliberately and confirmed to
scream. That discipline has now caught nine un-fireable checks in this effort,
including two I wrote myself. A refusal path that has never been seen refusing is
indistinguishable from one that cannot.

## 11. Deliverable D9 — what INT-3 must never do

Opens PRs. Nothing else. Specifically it never: merges, force-pushes, closes or
reopens, comments on unrelated issues or PRs, edits branch protection, pushes to
a default branch, or touches any repository other than the pinned one.

**Merge stays a human act** through INT-4 at minimum. The reason INT-3 is
tolerable at all is that a pull request is reversible and reviewable before it
changes anything. Preserve that property; it is the entire safety argument.

## 12. Out of scope

Merging · away-mode or unattended actuation (INT-5) · widening the agent's
capability set · any change to the money rail, wallet, signer, claim or
submission paths · re-opening the §2.5/§2.6 recorded proofs · changing the
`VerifiedHandoff` contract itself.

## 13. Decisions

1. **The agent never gets GitHub write.** Actuation lives outside its authority.
   This keeps authority separation intact and — decisively — keeps every INT-2
   proof valid after INT-3 ships.
2. **Stage 3a before 3b.** A payload artifact is diffable; an opened PR is not.
   Every refusal path is provable before a credential exists.
3. **Recompute eligibility; never trust the stored flag.** A cached authorization
   that is read but not re-derived has stopped being a check.
4. **Refuse on base drift rather than rebase.** A rebase produces content no
   verifier saw.
5. **`effects.mutates` must be computed and guarded by an invariant.** A record
   that misreports its own effects is worse than no record.
6. **PR-open only; merge remains human.** Reversibility is the safety argument,
   not a convenience.

### Operator decision required

**Which repository the first 3b actuation targets.** A scratch repository proves
the mechanism but not the real credential's scope; the pinned repository proves
both, and a PR there is reversible by closing it. My recommendation is the pinned
repository, once, with the token's permissions documented by inspection
beforehand — but this is the first outward-facing action the system will take
under its own steam, and that call is the operator's, not the architect's.
