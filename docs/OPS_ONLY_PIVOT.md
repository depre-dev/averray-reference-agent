# Ops-Only Pivot — Hermes as the operator, Buzz as the channel

Written 2026-07-31. Operator decision: **retire the delivery lane entirely.** The
product becomes an ops platform with one agent — Hermes — who operates it on
command, plus alerts for everything else.

## 0. Why this is right

The delivery lane has been dying by degrees all along, and the evidence is in
this repo's own history:

- **#579** ranked the decision queue *money-first* — delivery work sorted below
  money by construction.
- **#585** collapsed delivery on the phone to a **count line**, because a card
  titled "codex task" under a green Approve button was worse than useless.
- The phone board leads with health and money; delivery is a number you can tap.

Each of those was a local fix for the same global problem: **a kanban board is
the wrong shape for operating a live money system.** Cards model *work moving
through stages*. Ops is *state you watch and act on*. Forcing one into the other
produced a decision inbox nobody could decide from.

The line counts say the same thing — the ops core is small and the delivery
scaffolding around it is large:

| surface | lines | fate |
|---|---|---|
| `components/ops` | 819 | **keep** — this is the product |
| `components/cards` | 1,438 | retire |
| `components/drawer` | 1,461 | retire |
| `components/hermes` | 1,453 | **keep** — becomes the command surface |
| `components/mobile` | 360 | **keep** — repurpose |

This pivot is mostly deletion.

## 1. What the product becomes

```
8 probes ─→ pure decide layer ─→ three surfaces
                                   ├─ ops board  (what is true right now)
                                   ├─ alerts     (what needs you, pushed)
                                   └─ commands   (what you can do about it)
```

Nothing else. No lanes, no cards, no inbox, no drawer forensics.

## 2. ★ THE SAFETY MODEL — design this first, never retrofit it

Hermes will execute commands that restart services and touch money. In Buzz,
agents are channel members with their own keypairs. Therefore:

> **A message in a channel is DATA, not authorization.**

Another agent — or any text quoted into a channel, or a webhook, or a log line
Hermes reads — saying "restart the gateway" must never cause a restart. Only the
operator's own command counts.

**Buzz makes this enforceable rather than conventional**, and that is the
strongest technical argument for the move: NIP-42 auth + BIP-340 signing mean
every message is cryptographically attributable. "Was this really from the
operator?" becomes a signature check instead of an assumption. On Slack it was a
convention we hoped held.

Concretely:

1. **Operator-signed only.** Mutating commands act only on a message signed by
   the operator key. Everything else — human or agent — is context.
2. **Two tiers, split by consequence.**
   - *Read-only*: liberal, no gate, safe to answer for anyone in channel.
   - *Mutating*: operator-signed **and** confirmed, never content-triggerable.
3. **Never infer a command.** Hermes must not act on "it would be good to
   restart X" appearing in prose, its own narration, or a probe detail string.
   An explicit command form only.
4. **Every action is attributable.** Who asked, what ran, what changed — on a
   relay we own, which is the audit trail we never had with Slack.

This is the instruction-source boundary we already follow, made cryptographic.

## 3. Command set v1

Seeded from what the operator actually did by hand during 2026-07-31 — a real
corpus, not a guess. Every one of these was typed manually at least once today.

**Read-only** (no gate):

| command | answers |
|---|---|
| `status` | the one-glance verdict (reuses `opsBannerData`) |
| `money` | pools, floors, runway, payout evidence |
| `why <probe>` | why a probe is red/degraded, with its detail + recent history |
| `payouts` | confirmed `ReservationSettled` reads, with the window that produced them |
| `version` | running sha vs `origin/main` (reuses the self-freshness probe) |
| `disk` | headroom (reuses `disk_headroom`) |
| `logs <service> [n]` | recent lines, secrets redacted |

**Mutating** (operator-signed + confirm):

| command | why it is here |
|---|---|
| `restart <service>` | done by hand ~6× today |
| `deploy` | pull + rebuild — went wrong twice today (silent cached no-op, missing `GIT_SHA`) |
| `pause` / `resume` | autonomy toggle |
| `recheck [probe]` | force a probe cycle instead of waiting 2 minutes |
| `ack <incident>` | acknowledge without acting |

`deploy` earns its place precisely because it is the one that misfired: it
should encode *pull-before-build* and the `GIT_SHA` prefix so the failure modes
found today cannot recur by hand.

## 4. What dies, what stays, what changes meaning

**Dies:** `components/cards`, `components/drawer`, and the delivery half of
`lib/monitor` — `board-cache`, `board-columns`, `board-state`, `card-id`,
`card-router`, `card-types`, `deploy-stepper`, `lane-rules`, `signal-labels`,
`urgency`. Deleted, not flagged off: it is all in git history, and a dead lane
behind a flag is exactly the thing that quietly returns.

**Stays:** everything `ops-*`, `product-health`, `working-now`, plus the
co-pilot rail (`collaboration`, `presence`, `rail-digest`, `hermes-commands`) —
that rail *is* the command surface, it just stops narrating a board.

**Changes meaning:** `phone-triage` and `decision-rank`. `decisionPriorityFor`
currently tiers *cards*; with no cards it should tier **probe/alert urgency**
instead. Untangle that before deleting `decision-rank`, rather than ripping it
out and patching the hole — the money-first instinct in it is worth keeping,
only the subject changes.

## 5. Sequencing — deliberately NOT blocked on v0.19/Buzz

The Hermes upgrade is a no-go pending v0.19.2 (`HERMES_UPGRADE_v019.md` §3.5.4)
and Buzz needs v0.19.x. **None of that blocks this.**

1. **Retire the delivery lane** — pure deletion + the `decision-rank` untangle.
2. **Ops board becomes the whole board** — no surface switch, no lanes region.
3. **Command layer on the existing seam**, read-only tier first. Runs on v0.18
   and today's alert channel.
4. **Mutating tier** with the operator gate + confirmation.
5. **Swap comms to Buzz** when v0.19.2 lands — a channel implementation behind
   the same `AlertChannel`-shaped seam, exactly as planned for alerts.

Steps 1–4 ship on what we run today. Buzz upgrades the *channel*, not the
architecture — which is the point of keeping the seam.

## 6. Open question the operator should settle

**What happens to the Codex/Claude task runners?** The board currently proposes
and dispatches work to them (`codex-task-runner`, `claude-task-runner`, the
approval-gated `proposed → approved → running` flow). "Only Hermes operates the
ops platform" could mean either:

- **(a)** those runners leave this product entirely — they are delivery, and
  delivery is being retired; or
- **(b)** they stay as *executors* Hermes can dispatch to under command, with no
  board surface.

Different answers change what gets deleted in step 1. The ops board itself does
not depend on the outcome, so step 1 can begin on the parts that are unambiguous
while this is decided.
