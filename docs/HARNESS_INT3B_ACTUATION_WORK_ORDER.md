# INT-3b work order — sending the payload

> The seam. INT-3a computes a pull-request payload and **cannot** reach GitHub;
> INT-3b is the component that sends one, once, under supervision.
>
> This is the first outward-facing action the system takes under its own steam.
> It does not begin until the INT-2 evidence bundle is accepted and the operator
> signs off (§21.3).

## Why this is a separate packet

INT-3a proved the mechanism with something that cannot cause harm. Everything it
refuses, it refuses **for free**, before a credential exists:

```
approval_hash_mismatch        artifact_hash_mismatch        artifact_unavailable
base_drift                    base_revision_invalid         contract_invalid
eligibility_disagreement      halt_global                   halt_repository
halt_state_unavailable        handoff_check_not_passed      handoff_identity_mismatch
handoff_outcome_not_completed  handoff_unverified            patch_apply_failed
patch_empty                   patch_missing                 path_forbidden
path_not_allowed              payload_artifact_mismatch     repository_mismatch
repository_unavailable
```

All 22 are mutation-proven. 3b adds exactly one new variable — the network call —
and must not disturb any of that.

**Build on 3a; do not fork it.** `actuatePullRequestPayload` stays the thing
that decides *what* would be sent. 3b consumes its `PrPayloadActuationResult`
and decides whether to send it. A 3b that re-implements those checks will drift
from them, and the drift will be silent.

## 1. Deliverable D1 — the sender, and where it may not live

A component that takes a `PrPayloadActuationResult` and produces either exactly
one pull request or a named refusal.

- It is the **only** thing in the system holding GitHub write.
- It runs outside the agent container and shares nothing with it.
- `pr-payload-actuator.ts` and `pr-payload-local-ports.ts` **keep their current
  import surface** — `node:crypto`, `node:path`, internal packages, and for the
  ports `node:child_process` for `git`. No HTTP client is added to either. A
  test must assert this, so that "3a cannot reach GitHub" survives 3b existing.

That last point is the structural property from 3a's work order. It was easy to
hold when nothing in the tree could make a request; it needs a guard now that
something can.

## 2. Deliverable D2 — re-check base drift at *actuation* time

**The carry-forward from the 3a gate, and the reason this packet is not trivial.**

3a checks that the recorded base is current when it *builds* the payload. Between
building and sending, the base can move. A payload that was correct when
computed is not therefore correct when sent.

Re-run the same check immediately before the network call, against live
repository state, and refuse with `base_drift` if it has moved. Do not rebase —
a rebased head contains a merge result no verifier saw.

Prove it with a test that moves the base *between* payload construction and
send, and asserts no PR is opened.

## 3. Deliverable D3 — exactly one PR, checked against GitHub

3a derives the head branch deterministically from
`sha256(workItemId \0 taskVersion \0 approvedTaskHash)`. That gives idempotence
a *name*; 3b has to make it true against a system it does not control.

- Before creating anything, query GitHub for an existing PR with that head. If
  one exists for this payload, **adopt it and report success** — do not open a
  second, and do not error.
- The dangerous window is a crash **between** the API call succeeding and the
  result being recorded locally. A local-only check cannot see that; the remote
  query can. Order the work so a crash at any point leaves at most one PR and a
  re-run converges.
- Prove it by simulating a crash after the create call and re-running.

## 4. Deliverable D4 — `effects.mutates` must stop lying

`reconcile-run.ts:1084` hardcodes:

```ts
effects: { mutates: false, mutations: [], authorityChanged: false, budgetChanged: false }
```

That is correct today and becomes **false evidence** the moment a PR can be
opened. Compute it: `true` with the PR mutation ref when one was opened, `false`
otherwise. Add an invariant that fails if the literal is reintroduced on the
actuation path — the same shape as the exit-code-uniqueness guard, and for the
same reason: the instance is trivial to fix and invisible to reintroduce.

A decision record claiming it changed nothing, about a run that opened a pull
request, is worse than no record at all.

## 5. Deliverable D5 — the credential boundary

- write-scoped to **exactly one repository**; no organisation scope;
- never present in the agent container, the model environment, or any evidence
  artifact;
- never a CLI argument;
- evidence records the **identity and the repository it was scoped to**, never
  the token;
- rotation and revocation documented **before** first use.

Before the first real send, the token's actual permissions are read back and
recorded. "We requested a narrow scope" is not evidence that it is narrow.

## 6. Deliverable D6 — HALT covers sending

HALT already refuses payload construction. It must also refuse the send, checked
**immediately before** the network call rather than inherited from the earlier
check — an eligible payload sitting in hand when HALT is declared is exactly the
situation HALT exists for.

## 7. Deliverable D7 — the refusal ceremony, extended

Every 3a row must still refuse, now with a credential present and a live client
configured, proving the guards hold when there is something to guard. Plus the
rows that only exist here:

| Case | Must produce |
|---|---|
| base moved after payload construction | no PR, `base_drift` |
| HALT declared after construction, before send | no PR, naming HALT |
| a PR already exists for this head | **adopt it**, no second PR |
| crash after create, then re-run | still exactly one PR |
| token scope wider than one repository | refuse before sending |

Each proven able to fail. A refusal path that has never been seen refusing is
indistinguishable from one that cannot.

## 8. Deliverable D8 — what it must never do

Opens pull requests. Nothing else. Never merges, force-pushes, closes, reopens,
comments on unrelated issues or PRs, edits branch protection, pushes to a default
branch, or touches any repository other than the pinned one.

**Merge stays a human act.** A pull request is reversible and reviewable before
it changes anything, and that reversibility is the entire safety argument for
letting the system act. Preserve it.

## 9. The first real send is a ceremony, not a test run

Like §3, it is operator-run and single-shot, and its result is evidence whether
or not it is the result anyone wanted.

Before it: the full refusal ceremony green, the token's real scope recorded, and
a **dry run against the live API** that stops short of creating — proving
authentication, repository resolution, and branch-name derivation work, without
an outward effect. §3's lesson is that the cheap pre-flight is what makes a
one-shot run interpretable.

After it: capture before judging. Record the PR number, head sha, the payload
artifact hash it came from, and the decision record — and confirm the PR's head
tree matches the payload's `treeSha`. That last check is what proves the thing
that got sent is the thing that was verified.

## 10. Out of scope

Merging · away-mode or unattended actuation (INT-5) · widening the agent's
capability set · any change to the money rail, wallet, signer, claim or
submission paths · re-opening the recorded INT-2 proofs · changing the
`VerifiedHandoff` or `PullRequestPayload` contracts · adding cases to the INT-2
automated suite, whose count is asserted in four places and which is cited
evidence.

## 11. Decisions

1. **Build on 3a's actuator; do not re-implement its checks.** Re-implementation
   drifts, and drift here is silent.
2. **Re-check base drift and HALT immediately before the send.** Both were
   checked earlier; neither conclusion survives the gap.
3. **Idempotence is checked against GitHub, not locally.** The failure this
   guards is a crash between the API succeeding and the record being written,
   which local state cannot see by construction.
4. **Adopt an existing PR rather than erroring.** A re-run after a partial
   failure should converge, not require a human to clean up.
5. **`effects.mutates` computed and invariant-guarded.** A record that
   misreports its own effects is worse than none.
6. **PR-open only; merge stays human.** Through INT-4 at minimum.
7. **The token's real scope is read back and recorded before first use.**
   Intent is not evidence.

### Operator decisions required

**Which repository the first send targets**, unchanged from the INT-3 work
order and still not the architect's call.

**Who owns the credential and where it lives.** It must not be minted before the
refusal ceremony is green — a credential that exists is a credential that can be
used by accident.
