# Work order — the packet builder, one link earlier in the chain

> This gap is mine. The INT-3c work order specified the driver's input as
> `--handoff <path>` and never said what writes that file. The implementer built
> exactly what was asked, flagged the interpretation in the handback, and the
> missing producer only became visible when I went to write the ceremony steps.

## The chain

| link | state |
|---|---|
| dispatcher produces a `VerifiedHandoff` | exists — `ceremony-paid-glm-20260802-004` |
| something calls `actuatePullRequestPayload` (INT-3a) | **absent** |
| something assembles the `int3c_operator_handoff` envelope | **absent** |
| `scripts/ops/int3c-send.mjs` consumes it | merged in #699 |

`grep` for `actuatePullRequestPayload` finds its definition and three test files.
Nothing in `scripts/`, `services/`, or `packages/` calls it. The INT-3c test
builds its packet inline — canonicalizing, hashing, and assembling the envelope
by hand.

The operator cannot do that by hand. `loadAndValidatePacket` recomputes
`canonicalBytes` and refuses on mismatch, which is correct and makes the packet
unforgeable by a human with a text editor. It also means the packet must come
from a program.

## 1. Deliverable D1 — the builder

`scripts/ops/int3d-build-packet.mjs`:

> **Amended 2026-08-03.** The original D1 said to read the projection and handoff
> "from the dispatcher's store." They are not there. Neither appears in any
> migration; `buildVerifiedHandoff` is private and its result lives only in the
> reconciliation call frame, with the stored decision keeping evidence refs rather
> than the handoff. The ports I called "already wired" are used only by tests.
> See §8.5 for why reconstruction is the answer rather than persistence.

```
node scripts/ops/int3d-build-packet.mjs \
  --work-item <id> --repository-root <path> --base-ref <ref> \
  --patch-artifact-root <path> --payload-artifact-root <path> \
  --authorization <path> --out <path>
```

It reads the `AgentTaskV1` for one work item from the dispatcher's store — that
one *is* persisted — then **reconstructs** the rest from durable inputs:

1. read the bound Harness run through `HarnessReadPort`
   (`@avg/averray-mcp/harness-read-port`) to get a `HarnessRunReadSnapshot`;
2. build the `AgentRunProjectionV1` with the exported `projectHarnessRun`
   (`@avg/averray-mcp/harness-run-projection`) — the same function
   `reconcile-run.ts:437` uses;
3. build the `VerifiedHandoffV1` with `buildVerifiedHandoff`, then validate it
   with `assertVerifiedHandoffMatchesTaskAndRun`, which is already a shared
   export;
4. call `actuatePullRequestPayload` with ports built from the four path
   arguments above; and
5. write the `int3c_operator_handoff` envelope `loadAndValidatePacket` accepts.

**Reuse the dispatcher's own functions. Do not reimplement any of them.** A
second derivation of a handoff would be a second source of truth about whether
work is eligible to ship, and the two would drift.

Refuse unless the bound run is terminal. A non-terminal run's snapshot can still
change, and reconstruction is only sound over data that has stopped moving.

Non-overwriting, like the INT-3c evidence file. Re-running against an existing
`--out` path refuses rather than replaces.

## 2. Deliverable D2 — the builder must never hold a credential

This is the deliverable that shapes the design, not a detail of it.

The builder reads the database and the artifact store. The sender holds the
installation token. **Neither process may do both.** Split this way, the
token-holding process never opens a database connection, and the database-reading
process has nothing to leak.

Concretely:

- the builder must not read `GITHUB_INSTALLATION_TOKEN`, and must **refuse with a
  named exit code if that variable is set** — a set token means the operator is
  running it in the sender's environment, and that is the mistake worth catching;
- the builder makes no network call to GitHub; and
- `--authorization` points at the token-free issuance metadata the operator saved
  when minting, per `HARNESS_INT3B_CREDENTIAL_RUNBOOK.md`. Refuse if that file
  contains a `token` key at any depth, rather than trusting it was stripped.

## 3. Deliverable D3 — refuse early, on the same grounds

The sender already refuses an ineligible handoff. The builder must refuse to
*emit a packet at all* for one, so an unusable packet never reaches the process
that holds the credential:

| condition | exit |
|---|---|
| `GITHUB_INSTALLATION_TOKEN` set | named code, before anything else |
| `--authorization` file contains a token key | named code |
| handoff `eligibleForPrOpen !== true` | named code |
| global or repository HALT declared | named code |
| `--out` already exists | named code |

## 4. Deliverable D4 — prove the round trip

A test that builds a packet through the real builder and feeds it to the real
`loadAndValidatePacket` from `int3c-send.mjs`, asserting it is accepted and that
the recomputed `canonicalBytes` matches.

This is the deliverable that would have caught the present gap. Two halves that
were each individually tested, and no test that ran one into the other.

Then break it: perturb one byte of the payload after canonicalization and confirm
the validator rejects it. A round-trip test that has only ever agreed with itself
proves nothing about whether it would notice disagreement.

## 5. What must not change

- **`pr-payload-actuator.ts` and `pr-payload-sender.ts`.** Both are gated and
  merged. This packet adds a caller. If either needs a change, stop and say so.
- **`int3c-send.mjs`.** Merged in #699. If `loadAndValidatePacket` needs to be
  exported to make D4 possible, that is an acceptable and expected change; adding
  a behaviour to it is not.
- **`reconcile-run.ts` — with one exception.** Adding `export` to
  `buildVerifiedHandoff` is authorised and expected: D1 must call the dispatcher's
  own function rather than reimplement it. Widening its visibility is the whole
  change. Altering what it computes, when reconciliation calls it, or what the
  decision record stores is not, and the eleven INT-2 cases must stay green
  without amendment.
- **The fence.** Operator-side, outside the agent container, not reachable from a
  profile, capability grant, or the dispatch profile.
- **The INT-2 suite** — eleven cases, count asserted in four places.

## 6. Out of scope

Creating, requesting, or installing a credential · performing a real send ·
choosing the target repository · wiring any of this into Compose, CI, or the
agent container · anything touching the money rail, wallet, signer, claim or
submission paths.

## 7. Decisions

1. **Two processes, split on the credential boundary.** The builder touches the
   database and never a token; the sender holds the token and never a database.
   A single tool doing both would be more convenient and strictly worse.
2. **The builder refuses when a token is present in its environment.** The
   likeliest operator error is running the wrong tool in the wrong shell, and
   that error should be loud and free.
3. **The round trip is the deliverable, not the builder.** Both halves already
   worked in isolation. What was missing was anything that ran one into the
   other — which is exactly why this gap survived a passing gate.
4. **Reconstruct the handoff; do not persist it.** *(added 2026-08-03)* The
   dispatcher stores the task and the decision record's evidence refs. The
   projection and handoff are derived, and every input they derive from is
   durable: the task in the dispatcher, the run in Harness behind
   `HarnessReadPort`. Persisting a derived value means a migration, a write path,
   and a stored copy that can drift from the run it describes. Reconstruction
   over a terminal run costs one `export` keyword.
5. **Reconstruction does not weaken the truth boundary.** `verifiedAt` comes from
   `read.status.updatedAt` — the Harness run's own timestamp — so it stays
   accurate however long afterwards the packet is built. `generatedAt` becomes
   the reconstruction time, which is exactly what that field claims to mean. No
   field asserts something that did not happen when it says it did.

   This holds *because* the run is terminal, which is why D1 refuses otherwise.
   Rebuilding from a live run could produce a handoff describing a state that has
   since moved, and no timestamp field would reveal it.

### If this becomes routine

Reconstruction is right for a one-shot operator ceremony. If the send is ever
automated, persisting the handoff at reconciliation time becomes the better
answer — a durable record of what was accepted beats re-deriving it, and the
audit trail stops depending on Harness retaining the run. That is a separate
decision, and this packet does not foreclose it.

### Operator note

After this lands, the ceremony is runnable end to end. It still does not
authorise the send. Choosing the repository, minting the token, and deciding to
run it remain yours, in that order.
