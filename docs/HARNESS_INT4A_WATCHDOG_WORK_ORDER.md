# Work order — INT-4a: alerts that land somewhere, and a watchdog that isn't us

> Today, if the dispatcher dies, nothing anywhere notices. Alerts are appended
> to a JSONL file that nothing reads. That silence is the first drill.
>
> Charter: `docs/HARNESS_INT4_CHARTER.md`. Operator decisions taken 2026-08-05:
> **dual alert sinks (direct Slack webhook + the existing closed Buzz relay)**,
> watchdog as a standalone Compose service, burn-in started in parallel under a
> separate order.

## 0. Prove the silence first

Before building anything: against current `main`, kill a locally running
dispatcher mid-idle and stop the Harness Postgres. Record that **no alert fires
anywhere**. That record seeds the drill ledger's `absent` rows and is the red
this packet exists to turn green. Do not skip this because the outcome is
obvious — the ledger cites evidence, not obviousness.

## 1. Deliverable D1 — the watchdog process

A standalone service (`services/harness-watchdog/`), its own Compose entry with
a restart policy, **not** inside the dispatcher and **not** inside the Hermes
stack. It watches:

- **dispatcher heartbeat staleness** — `HARNESS_DISPATCH_HEARTBEAT_PATH` age
  against a threshold (env, default 90s)
- **the alert stream** — tails `HARNESS_DISPATCH_ALERTS_PATH` and forwards new
  entries to the sinks
- **Harness DB source age** — newest event timestamp vs now, read-only query,
  threshold env (default 15m when a run is live; no alert when idle — an idle
  system has an old newest-event by nature, and alerting on it would train the
  operator to ignore the channel)
- **reachability** of both Postgres instances

Structural independence, asserted the way INT-3a asserted its import surface: a
test reads the watchdog's imports and refuses anything from
`services/slack-operator` or Hermes-facing modules.

## 2. Deliverable D2 — Slack sink now; Buzz deferred to its own packet

> **Amended 2026-08-05, sixth stop.** The original D2 said to POST to the Buzz
> relay "with its auth token from `WATCHDOG_BUZZ_TOKEN`". The implementer
> checked the actual protocol before building: Buzz's relay accepts **signed
> Nostr events** (`POST /events`, NIP-98 HTTP auth). A bearer token cannot
> produce a signature — I specified a mechanism from memory of our deployment
> without verifying the protocol it speaks. The spec was wrong; the stop was
> right.
>
> Because the independence guarantee was deliberately placed on Slack alone,
> deferring Buzz changes nothing about this packet's acceptance. Buzz becomes
> **INT-4a.1** (§2.1) with a real mechanism instead of a hand-waved token.

- **Slack**: a plain incoming-webhook POST. URL from `WATCHDOG_SLACK_WEBHOOK_URL`.
  No Hermes, no slack-operator code, no shared client.
- **Buzz**: not in this packet. The sink interface must leave room for a second
  forwarder (a list of sinks, not a hardcoded pair), but no Buzz code, no Buzz
  credential, no Nostr dependency lands here.

### 2.1 INT-4a.1 — the Buzz sink, properly (follow-up packet, not this one)

The honest mechanism in Buzz's own model: the watchdog gets its **own Nostr
identity** and posts alert events to the closed relay as a first-class member —
membership *is* the allowlist, and alerts become events in the control plane.
That requires an operator decision (does the watchdog get an identity, and who
holds its key?), a signing dependency, and channel metadata. Each is a real
choice, none belongs smuggled into 4a. Drafted only after this packet lands.

Rules that make the sink layer honest:

- The local JSONL file is written **first** and is the source of truth; every
  sink is forward-only and best-effort.
- One sink failing must never block or delay another.
- **The independence property rides on Slack alone**: §11's drill is "Hermes
  unavailable → external alerts remain active." Any future sink (INT-4a.1's
  Buzz included) is additive, never the load-bearing path.
- Redaction guard on forwarded bodies: alert payloads pass a deny-list scrub
  (token/key/secret/authorization patterns) before leaving the machine. With a
  sentinel test, demonstrated failing, INT-3c style.

The env var is operator-provisioned, never committed, never logged. Absent
env → the sink is `disabled` in the watchdog's own status, stated plainly —
not silently skipped.

## 3. Deliverable D3 — the drills, red then green

| drill | inject | required green |
|---|---|---|
| dispatcher killed | `kill` the dispatcher mid-idle | staleness alert within threshold, delivered to file + Slack |
| Harness DB down | stop the harness Postgres container | unreachability alert; watchdog itself stays up |
| **Hermes unavailable** | stop every Hermes/slack-operator container, then run both drills above | **Slack delivery still fires** |

Mutation proofs, each seen red:

- set the staleness threshold to infinity → dispatcher-killed drill must fail
- break the redaction scrub → sentinel leak test must fail
- point the Slack URL at a black hole → the drill's delivery assertion must
  fail (proves the drill checks delivery, not just emission)

## 4. Deliverable D4 — the drill ledger

Create `docs/HARNESS_INT4_DRILL_LEDGER.md`: one row per §11 drill, seeded
exactly from the charter's verified table — nine `proven` rows with their suite
citations, the rest `mechanism-only`/`absent` as inventoried. On completion,
move this packet's rows to `proven` with evidence refs (drill transcripts under
`docs/evidence/`).

The ledger is append-and-amend: rows change status with a dated citation, never
by silent rewrite.

## 5. Deliverable D5 — watchdog's own observability, bounded

The watchdog writes its own heartbeat file and a one-line status JSON (sinks
configured/disabled, last alert forwarded, thresholds). The operator checks it;
a watchdog-for-the-watchdog is explicitly out of scope — that recursion ends by
operator runbook, and the runbook section ships in this packet.

## 6. What must not change

- `alerts.ts` and the dispatcher's alert emission — the watchdog **consumes**,
  it does not replace. No dispatcher behavior change of any kind.
- The fence, the suites (11 INT-2 cases + count sites, 12 INT-3b cases), the
  kernel, the ceremony docs.
- Compose dispatch profile gating stays exactly as is.

## 7. Out of scope

Auto-remediation of anything (INT-4b+) · quarantines (4b) · lease semantics
(4c) · the burn-in battery (separate order) · `rubric` · money rail · real
repositories · credentials beyond the one operator-provisioned sink env var ·
any Buzz/Nostr code or credential (INT-4a.1).

## 8. Decisions

1. **Dual sinks remain the goal; Slack ships first.** Slack is the §11
   witness. Buzz moved to INT-4a.1 when the relay's real protocol (signed Nostr
   events, NIP-98) surfaced — an additive sink that needs a new credential class
   is its own packet, not a footnote. (Operator amendment, 2026-08-05.)
2. **File first, forward best-effort.** The JSONL is the record; sinks are
   delivery. A sink outage loses no evidence.
3. **Idle source-age does not alert.** An alert channel that cries on quiet
   systems gets muted by humans; the threshold applies only while a run is
   bound and live.
4. **The silence is recorded before the fix.** Ledger rows move on evidence.

### Operator note

You provision one env value when the packet lands: the Slack incoming-webhook
URL, into the watchdog's environment only. The Buzz identity decision comes
with INT-4a.1, not now. Nothing else in this packet needs you.
