# Bank deposit and withdrawal evidence — proposal only

No code in this change, and no pull request in `averray-agent/agent`.
The monitor should not grow a second chain reader. The bank lane already
has one rule: the backend observer reads, Hermes renders.

## What the watch already stores

The durable XCM balance watches in
`averray-agent/agent` (`mcp-server` `xcm-balance-observer.js`) already
record a wrapper movement as the chain names it:

| Stored field | What it is |
| --- | --- |
| `kind` | `deposit` or `withdraw`. Not a balance-delta guess, and not "top-up" / "withdrawal". |
| `requestId` | The wrapper request this watch belongs to. |
| `stagingTxHash` | Hash of the staging extrinsic. |
| `lastDispatchTxHash` | Hash of the latest leg dispatch. |
| `lastDispatchFeeAmountRaw` | Fee of that dispatch, raw decimal. |

[averray-agent/agent #1403](https://github.com/averray-agent/agent/pull/1403)
made the ingest of those extrinsics reliable. It is read-only: it does not
submit, sign, or move funds. `system.events` is decoded first, and only a
`RequestQueued` from the configured wrapper pulls a block. The selected
extrinsic is hashed with blake2-256 over the complete SCALE bytes. A failed
block hash stays failed until it has been ingested. That path is already
shipping. It is not the gap.

The evidence event on a row is the chain event that produced it:
`RequestQueued` for the request, and the leg-dispatch event for
`lastDispatchTxHash`. The Polkadot Hub USDC precompile emits no `Transfer`
logs, so a movement log cannot be built by scanning ERC-20 `Transfer`
events. There is nothing there to scan.

## What the feed already returns

The bank feed already returns the 10 most recent terminal requests, and the
monitor renders that snapshot (`services/slack-operator/src/bank-feed.ts`):
id, kind, phase, age, deadline, status, reason, finalization, and terminal
reconciliation amounts.

`requestFromWatch` (`bank-lane-feed.js` lines 499–560 in
`averray-agent/agent`) is the projection that drops the hashes. The watch
has `stagingTxHash` and `lastDispatchTxHash`. The feed object the monitor
normalizes does not. That is why the board cannot show them. It is not
because the observer failed to store them.

## The gap

Three decisions, in this order. Only (a) is a small, already-specified
backend change. This repo does not make it.

### (a) Project the stored hashes

A separate pull request in `averray-agent/agent`, not opened here.
`requestFromWatch` should copy the fields the watch already has onto each
feed request:

- `kind` (`deposit` or `withdraw`, unchanged)
- `requestId`
- `stagingTxHash`
- `lastDispatchTxHash`
- `lastDispatchFeeAmountRaw`

Name the evidence event beside the hash it came from: `RequestQueued` for
the staging hash, and the leg-dispatch event for `lastDispatchTxHash`.
After that feed shape exists, the monitor change is render-only: show the
hash that was served, and say when it was not. Do not reconstruct it from
balance snapshots, Blockscout, or a second RPC walk.

### (b) Widen or paginate terminal history

Ten terminal requests is a window, not a ledger. A deposit that falls off
that list leaves the board even though the watch still has the row. Decide
whether the feed grows a higher cap, a cursor, or a dedicated history read.
The monitor should render whichever of those the feed actually returns. It
should not keep its own copy.

### (c) Movements that are not wrapper requests

Direct operator transfers, and any other balance change that never became a
wrapper request, are not in the watch. `requestId` does not exist for them,
and the USDC precompile will not supply a `Transfer` log to hang them on.
Decide explicitly whether those movements are in scope, and if they are,
which extrinsic the observer is allowed to read. Until that decision, the
board must not invent a row from a balance delta.

Out of scope here: payout on an unmerged PR, signer gas top-ups already
covered by the overnight ledger, and any change to how the watch submits
or signs.
