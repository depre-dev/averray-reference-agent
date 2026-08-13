# Design handoff: the ops board and the phone board

**For:** a fresh Claude session doing a design pass. **From:** Claude (built the
recent panels). **Date:** 2026-08-06.
**Deliverable:** a design proposal for both surfaces — see §8.

You are redesigning two screens that already work and are already truthful. The
job is **composition**, not content: no figure changes, no string is invented,
no producer is touched. Everything in §6 is a hard constraint that a prettier
board may not trade away.

---

## 1. What these screens are

One operator (Pascal) runs a live money system — an agent marketplace that pays
workers in USDC on Polkadot Asset Hub. These boards are how he knows whether it
is healthy. There are no other users. The desk board runs full-screen on a wall
display; the phone board is read in bed and outdoors.

The governing rule, from `docs/AUDIT_REMEDIATION.md`, outranks every aesthetic
preference:

> every production surface must declare whether it is real, degraded, or
> example, and must enforce that declaration mechanically. No silent fallbacks.

---

## 2. The two media, and why they differ

Already written at the top of `packages/monitor-ui/src/lib/monitor/phone-spec.ts`
and worth reading in full. The short version:

- **Desktop hierarchy is SPATIAL.** Everything is on screen at once; importance
  is expressed by size and position. Nothing scrolls on the wall display.
- **Phone hierarchy is SEQUENTIAL.** The verdict is first and may never be
  scrolled past; anything below the fold has to have earned it.

This is why the phone is not a narrow desktop. It is the same facts, cut.

---

## 3. Desktop as it stands (`components/ops/OpsBoard.tsx`)

In render order:

| # | Band | What it is | Age |
|---|---|---|---|
| 1 | `ops-verdict` + `ops-trust` | The one-line verdict, plus trust rows (is the data fresh, is the stream up) | original |
| 2 | `ops-money` | **Two columns:** `SolvencyPanel` (46%) — pool meters, floors, burn, runway, payout evidence — and `FlowPanel` — the claimed→submitted→settled funnel, by-hour histogram, dispute clock | original |
| 3 | `ArrivalsPanel` | Two columns (MCP / HTTP API) — who arrived from outside and how far they got | **added later** |
| 4 | `BankLane` | The treasury's Hydration USDC venue position | **added later** |
| 5 | `DepositPoolTile` | The shared depositor pool — deposits, buffer/deployed, share price, cap, depositors, yield, last flows | **added later** |
| 6 | `PillarStrip` | Eight probes grouped into four pillars (AVAILABILITY / CHAIN / SOLVENCY / FLOW) | original |
| 7 | `ops-economics` | One line: per-job economics | original |

Bands 3–5 are each full-width and simply appended in the order they were built.

## 4. Phone as it stands (`components/mobile/MobileBoard.tsx`)

Sequential: status bar → stale fence (when untrusted) → verdict → trust line →
`BreachPanel` **or** `SolvencyPanel` → `FlowPanel` → `BankPanel` → **pool lane**
→ **arrivals lane** → "scroll for probes" → four pillar rollups → footer
(incidents, build).

The pool and arrivals lanes are one-line `<p>` elements (`.hm-ph-lane`) added
today. They are honest and they are cuts of the right size — but they are bare
text appended after a structured section, which is exactly what they look like.

---

## 5. What is actually wrong

Say this plainly because the boards are otherwise good, and a redesign that
misses it will just be a repaint.

**5a. The desktop's money story is interrupted.** Reading down: worker payouts
(2) → *outside demand* (3) → treasury venue (4) → depositor pool (5). Bands 2,
4 and 5 are all money; band 3 is not money at all. Demand was inserted into the
middle of the money narrative because that is where the code happened to be
appended.

**5b. One pillar, two visual languages.** `BankLane` and `DepositPoolTile` both
describe the Bank pillar, sit adjacent, and are built as different things — a
"lane" and a "tile", with different chrome and different heading weight. A
reader has no cue that they are two views of one subject.

**5c. Nothing expresses relative importance among the appended bands.** Six of
the seven bands are full-width and visually equal. On a wall display, an empty
depositor pool occupies the same commanding width as the funnel that proves
workers got paid.

**5d. The phone's new lanes are orphans.** Two unlabelled one-liners after a
titled section. They need to belong to something — probably grouped under the
bank, since one of them *is* a bank instrument.

**5e. Nobody has looked at the whole composition since three panels were
added.** That is the actual defect. Each panel was reviewed alone and is fine
alone.

---

## 6. Constraints a redesign MAY NOT trade away

Every one of these was paid for by a real incident. They are not preferences.

1. **One verdict system.** The headline comes from `deriveOpsVerdict`
   (`@avg/schemas`) and is quoted, never re-derived. Two verdict systems
   disagree eventually, and the first disagreement is the last time the operator
   believes either. Read `verdict.reason` (the contract), not the prose
   headline.
2. **Absent is not zero.** A probe, pool or feed that did not report contributes
   **no row**, never a `—` placeholder. A placeholder claims a measurement
   nobody took.
3. **`unavailable` ≠ `fault`.** "We cannot see it" and "it reported nonsense"
   are different operator moves and must stay visually distinct.
4. **Unreadable is grey, never red.** A blind instrument is not a money problem.
   Red belongs to the money path alone. The bank lane's `UNVERIFIED` position
   and the pool's `unavailable` both follow this.
5. **Demand outcomes are never coloured as faults.** Nobody arriving is a
   business fact. Painting it red puts it in the same visual language as a
   broken settlement.
6. **Self / external / ambiguous traffic stay apart.** Traffic under a client
   name we also use ourselves cannot be counted as outside demand (that
   manufactures it) nor as ours (that erases a possible stranger).
7. **Never add series measured over different windows.** HTTP arrivals are
   counted only from a cut-over with no backfill; MCP has a longer history.
   Summing them is arithmetic across unlike spans. Combine on *furthest stage*,
   which survives the mismatch. Same reason the payout evidence carries an
   explicit window-fit line.
8. **Stale data is fenced, not dimmed.** The phone is read outdoors; dimming
   every value to 72% is illegible in sunlight. Untrusted data keeps full
   contrast and is fenced by a hatched band, a re-captioned verdict and explicit
   as-of times.
9. **Detail only when not ok** (phone). A probe spends a second line only when
   it has something to say.
10. **No figure is computed in markup.** Numbers arrive from producers as
    strings the board quotes. If a layout needs a new derived value, it belongs
    in `ops-spec.ts` / `phone-spec.ts` and must be shared by both surfaces —
    see `formatPoolAmount` for the pattern.

---

## 7. The data you have

Do **not** work from this list — read the source, because it is the only current
statement. `packages/monitor-ui/src/lib/monitor/product-health.ts` defines
`ProductHealth`, whose blocks are: `probes`, `chain`, `solvency`, `flow`
(incl. `flow.payout`), `gas`, `lifecycle`, `externalFunnel`, `history`, `bank`,
`depositPool`, `arrivals`, `remediation`, `buzz`, `buzzInbound`.

View models (where derivation belongs, and where both surfaces must share):
`lib/monitor/ops-spec.ts` (desktop), `lib/monitor/phone-spec.ts` (phone),
`lib/monitor/ops-gloss.ts` (hover definitions — definitions only, never data),
`@avg/schemas/ops-verdict` (the verdict), `@avg/schemas/ops-next-step` (the
remediation phrase shared with the #Ops alerts).

Fixtures to design against, including the ugly states:
`lib/monitor/ops-fixtures.ts` (`OPS_FIXTURE_NOMINAL`, `_LIVE`, `_RED`).

---

## 8. What to send back

A **design proposal**, not a merged rewrite:

1. **A composition for the desk board** — the bands, their order, their relative
   weight, and which (if any) should share a row. Say what each grouping
   asserts. If Arrivals moves out of the money sequence, say where it goes and
   why that is where an operator would look for it.
2. **A composition for the phone** — the sequence, what sits above the fold,
   and where the pool and arrivals lanes belong. If they should be a group,
   name the group.
3. **A written rationale per decision**, in the register of the existing
   comments in these files: what the choice asserts, and what it refuses to
   assert.
4. **The diff surface**: which components and which CSS blocks change. Layout
   and grouping only — if the proposal needs a string or a figure to change,
   flag it as a question instead of doing it.
5. **Explicitly: what you chose NOT to change, and why.** A design pass that
   touches everything is not a design pass.

Two things worth knowing about how this repo works. Every non-obvious decision
is written down beside the code as a comment explaining what it refuses to
claim; match that. And the tests encode the truth rules — 471 of them in
`packages/monitor-ui` — so if a layout change breaks one, the test is probably
right and the layout is probably making a claim it should not.

---

## 9. Open questions the operator has already raised

- **"What's MCP and HTTP?"** (2026-08-06) — resolved on the phone by combining
  into one plain sentence with no transport names. The desktop still shows two
  columns, now with hover glosses explaining each door. **Open:** whether the
  desk board should keep two columns at all. The argument for keeping them is
  forensic — one door dead while the other thrives is a thing you want to see.
  The argument against is that the operator has said twice that the split does
  not serve him.
- **Deposit pool prominence.** It is currently a full-width band showing a pool
  that is deliberately near-empty (10 USDC, born empty, 0 depositors, not yet
  earning). It is strategically important and operationally quiet. Those two
  facts pull its visual weight in opposite directions.
