# Work order — the operator driver for the first real send

> Everything gating the first live pull-request send is met. The seam is built
> and tested, the credential boundary is documented, the budget defect is proven
> fixed end-to-end, and a real-model run produced a verified handoff with
> `eligible_for_pr_open=true`.
>
> What is missing is the smallest part: nothing wires them together. There is no
> process an operator can invoke.

## The gap

`docs/HARNESS_INT3B_CREDENTIAL_RUNBOOK.md` §"Free pre-flight" instructs the
operator to *"construct the INT-3a payload and call `preflightPullRequestPayload`
from the operator-owned process with the live client."*

That process does not exist.

| piece | state |
|---|---|
| `actuatePullRequestPayload` (INT-3a) | built, tested, **no caller outside tests** |
| `createGitHubPrClient` (live adapter) | built, 566 lines, holds the token |
| `preflightPullRequestPayload` | built, tested against the fake |
| `sendPullRequestPayload` | built, 10 refusal/adoption cases |
| **an operator entry point** | **absent** |

`grep` for `createGitHubPrClient` finds the definition and one test. No script in
`scripts/ops/` constructs a `PrPayloadActuationResult`.

Without this packet the operator's only route is a hand-written throwaway script —
unreviewed, untested, holding a live write credential, on the one run where
being wrong is expensive. That is the worst possible place for ad-hoc code.

## 1. Deliverable D1 — two commands, never one

`scripts/ops/int3c-send.mjs`, with two subcommands that are separate
invocations:

```
node scripts/ops/int3c-send.mjs preflight --handoff <path> --repo <owner/name>
node scripts/ops/int3c-send.mjs send      --handoff <path> --repo <owner/name> --confirm <owner/name>
```

**Not a `--dry-run` flag.** A flag that defaults to safe is one deleted word from
a live send; a separate verb cannot be reached by editing the previous command.
The `send` verb additionally requires `--confirm` to repeat the target repository
back, and must refuse when it does not match `--repo` exactly.

`preflight` calls only `preflightPullRequestPayload`. It must be structurally
incapable of creating: do not import `sendPullRequestPayload` into the preflight
path.

## 2. Deliverable D2 — the token never touches argv, output, or disk

The installation token is read from **one** channel: the `GITHUB_INSTALLATION_TOKEN`
environment variable. Never a CLI argument — `argv` is world-readable through
`ps`. Never a file path, never prompted, never echoed.

The driver must:

- refuse with a named exit code when the variable is absent or empty;
- pass it only into `GitHubPrClientConfig.installationToken`;
- strip it from the issuance metadata before that metadata reaches the sender, as
  the runbook requires; and
- **never** place it in the evidence record, stdout, stderr, decision record, or
  any artifact.

## 3. Deliverable D3 — prove the token cannot leak, don't assert it

A test that runs the driver end-to-end against the existing `FakeGitHubClient`
with `GITHUB_INSTALLATION_TOKEN` set to a known sentinel, then asserts the
sentinel appears in **no** captured stdout, stderr, or written evidence file.

Show it failing: add the token to the evidence record on purpose and confirm the
test goes red. A leak check that has never been seen failing is not a check.

This is the deliverable I will gate hardest. The rest is plumbing; this is the
one that matters if it is wrong.

## 4. Deliverable D4 — refuse before GitHub, not after

Before any network call, the driver refuses, each with a distinct named exit
code and a message naming what failed:

| condition | why |
|---|---|
| `GITHUB_INSTALLATION_TOKEN` unset | nothing to authenticate with |
| `--confirm` absent or ≠ `--repo` (send only) | muscle memory must not reach a send |
| handoff `eligibleForPrOpen !== true` | the gate the whole seam exists to enforce |
| global or repository HALT declared | HALT wins over everything |

The sender re-checks HALT and authorization itself; that is correct and stays.
This is a second gate in front of it, so an obvious mistake costs nothing.

## 5. Deliverable D5 — the evidence record

`preflight` and `send` each write a JSON evidence file to an operator-specified
path, containing exactly what the runbook §"Free pre-flight" lists: GitHub App
identity, repository, `repositorySelection`, Contents and Pull requests
permission levels, the extra-write-scope list, live base SHA, derived head ref,
and outcome. `send` additionally records PR number, head commit SHA, payload
artifact hash, and confirmation that the remote head tree equals the payload
`treeSha`.

Never request headers. Never the token. Never the App private key.

## 6. What must not change

- **The sender.** `pr-payload-sender.ts` and its ten cases are gated and merged.
  This packet adds a caller, not a behaviour. If you believe the sender needs a
  change, stop and say so in the handback instead of making it.
- **The fence.** Eight vetted capabilities, `network: deny`, non-delegating. This
  driver is operator-side and outside the agent container; it must not become
  reachable from a profile, a capability grant, or the dispatch profile.
- **The INT-2 suite** — eleven cases, count asserted in four places.
- **No retry.** A process loss after GitHub accepts the create is resolved by one
  operator re-run, which adopts the existing PR. Never loop, never auto-retry.

## 7. Out of scope

Creating, requesting, or installing a real credential · performing a real send ·
choosing the target repository · wiring this into Compose, CI, a profile, or the
agent container · merge, close, comment, force-push, or branch protection ·
anything touching the money rail, wallet, signer, claim or submission paths.

## 8. Decisions

1. **Two verbs, not a flag.** The failure mode of a flag is silent and total.
2. **One token channel, environment only.** `argv` is readable by any process on
   the host; a file is one `cat` from a transcript.
3. **The leak check must be seen failing.** Every defect this repository has
   found in six weeks was a check that could not fail.
4. **The driver refuses before the network, and the sender refuses again.** Two
   independent gates, because the expensive mistake happens exactly once.

### Operator note

This packet does not authorise the first send and does not touch a credential. It
builds the thing that makes the send *possible to perform carefully*. Choosing the
repository, minting the token, and deciding to run it remain yours, in that order,
after this lands and is gated.
