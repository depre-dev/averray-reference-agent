# Bank top-up and withdrawal log — proposal only

No code in this change. The monitor should not grow a second chain reader.
The bank lane already has one rule: the backend observer reads, Hermes renders.

## What the bank watch already records

[averray-agent/agent #1403](https://github.com/averray-agent/agent/pull/1403)
is read-only. It does not submit, sign, or move funds. It makes the wrapper
watch able to ingest the extrinsics it already cares about:

- `system.events` is decoded first. Only `RequestQueued` from the configured
  wrapper pulls a block.
- That pull is `chain_getBlock` raw JSON. The selected extrinsic is hashed
  with blake2-256 over the complete SCALE bytes. Unrelated extrinsics are
  not decoded.
- A failed block hash stays failed. A later successful block does not clear
  it. Staging stays closed until every failed block has been ingested.
- Failed hashes are retried on a short interval. Offline and restart
  recovery stay on the existing in-process queue and the explicit backfill.
- Header, timestamp, event phase, and a same-extrinsic
  `RequestParametersStored` are part of that read (see
  `docs/BANK_WATCH_BLOCK_READS.md` in the platform repo).

That is a reliability fix for request ingest. It is not a ledger of every
top-up and every withdrawal.

## What the bank feed already records

The monitor's read-only feed (`services/slack-operator/src/bank-feed.ts`)
renders the observer's snapshot. It already carries:

- Position, float, and postage, each as a sourced read: raw decimal, source
  ledger, observer `readAtMs`, and `lastError`.
- In-flight wrapper requests: id, kind, phase, age, overdue, deadline,
  status, failure reason, finalization attempts, and terminal reconciliation
  amounts (staged, fees, write-off, unexplained).
- Which deployment generation the readings came from.

It does not carry a transaction hash on a request, and it does not keep a
history of completed movements. A request that leaves the in-flight table
leaves the board. A balance that changed between two snapshots does not say
which transfer caused it.

## What is missing

One append-only record, produced by the observer that already reads the
chain, with one row per bank top-up and one row per bank withdrawal:

| Field | Why |
| --- | --- |
| `kind` | `top-up` or `withdrawal`. Do not infer this from a balance delta. |
| `txHash` | The hash of the extrinsic or transaction that moved the funds. |
| `amountRaw` | Decimal string, same unit rule as the feed's other amounts. |
| `asset` | Which balance moved (position, float, or postage). |
| `at` | Observer timestamp of the movement, not the monitor's poll time. |
| `requestId` | Set when the movement belongs to a wrapper request; null when it does not. |

The monitor change, after that exists, is render-only: show the row, including
the hash, and say when the log could not be read. Do not reconstruct the log
from balance snapshots, and do not add Blockscout or a second RPC walk to
find the hashes.

Out of scope here: payout on an unmerged PR, signer gas top-ups already
covered by the overnight ledger, and any change to how the watch submits or
signs.
