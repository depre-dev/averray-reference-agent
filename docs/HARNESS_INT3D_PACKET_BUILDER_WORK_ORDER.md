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

```
node scripts/ops/int3d-build-packet.mjs \
  --work-item <id> --authorization <path> --out <path>
```

It reads the `AgentTaskV1`, `AgentRunProjectionV1`, and `VerifiedHandoffV1` for
one work item from the dispatcher's store, calls `actuatePullRequestPayload` with
the artifact and repository ports the dispatcher already wires for its own use,
and writes the `int3c_operator_handoff` envelope that `loadAndValidatePacket`
accepts.

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

### Operator note

After this lands, the ceremony is runnable end to end. It still does not
authorise the send. Choosing the repository, minting the token, and deciding to
run it remain yours, in that order.
