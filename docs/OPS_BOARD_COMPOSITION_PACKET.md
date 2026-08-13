# Packet: ops board + phone board composition

**Status:** spec ready — **Codex handoff packet**; Claude gates the handback.
**Origin:** design handback `Board spec sheet review-handoff-4.zip` (Claude
Design, 2026-08-13), answering [OPS_BOARD_DESIGN_HANDOFF.md](./OPS_BOARD_DESIGN_HANDOFF.md).
**Author:** Claude (architect/gate). **Date:** 2026-08-13.
**Scope:** layout and grouping in `packages/monitor-ui`. **No producer is
touched, no figure is changed, no string is invented** except the two heading
re-splits in D-Q2 below.

---

## 0. READ THIS BEFORE THE BUNDLE — the bundle's README is wrong for us

The design bundle ships a `README.md` telling a coding agent to **"recreate them
pixel-perfectly"** and to treat the HTML prototypes as the source of truth.
**That instruction does not apply here and must not be followed.**

The prototypes contain sample money figures that are **not ours** — `3.10 USDC`
and `0.05 USDC` appear in `Hermes Ops Board v3 Viewports.dc.html` and match no
fixture in this repo. Copying the mockups literally would hardcode invented
money values into a live financial board. That is the precise failure the ten
constraints exist to prevent, arriving through the packaging rather than the
design.

**The rule for this packet:** the prototypes are a picture of *composition* —
band order, grouping, relative weight. Every value on screen keeps coming from
`ProductHealth` exactly as it does today. If a mockup shows a number, ignore the
number and copy the position. The proposal document itself is clean on this and
says so ("no figure is changed"); only its README contradicts it.

---

## 1. Decisions taken (do not re-open)

| # | Question | Decision | Who |
|---|---|---|---|
| Q1 | Does the desk keep two arrival doors? | **Keep both, condensed** at weight S. The phone keeps its single merged sentence. | operator |
| Q3 | May an overdue bank request take the phone's lead slot? | **Yes**, with the byte-identical-verdict test in §5 as a hard requirement. | operator |
| Q5 | Should the bank lane feed `deriveOpsVerdict`? | **Its own packet, after this one lands.** Not in scope here. | operator |
| Q2 | What does the bank group's heading say? | Group heading **`BANK`**; sub-headings **`HYDRATION USDC`** and **`DEPOSIT POOL`**. Re-splits existing words, invents none. | architect |
| Q4 | Is half a medium band right for the deposit pool? | **Yes** — sized by what it is doing today. It re-earns width when it has depositors. | architect |

**Q5 is deferred, not dismissed, and it is the most serious finding in the
handback.** `VerdictInput` (`packages/schemas/src/ops-verdict.ts`) takes
`enabled, checks, probes, pools, payout, runway` — verified 2026-08-13. There is
no bank input, so **an overdue Hydration request cannot move the headline on
either surface**. That is the unfixed half of the 2026-08-04 incident: the phone
was given the bank *panel* and the verdict was never given the bank *fact*. The
phone lead slot (Q3) is honest compensation, not a cure. A follow-up packet
against `@avg/schemas` owns the cure.

---

## 2. Desk composition

Weight is **height and frame, never width alone**. Four classes, in order:

| Weight | Band | Change |
|---|---|---|
| XL | `VERDICT` + `TRUST` | unchanged |
| L | **MONEY THAT PAYS WORKERS** — `SolvencyPanel` \| `FlowPanel`+proof | content unchanged; per-job economics moves *inside* this band, closing it |
| M | **BANK** — `HYDRATION USDC` \| `DEPOSIT POOL` | **new group**: one frame, one heading, two columns |
| M | `PROBES — 4 PILLARS` | unchanged |
| S | `NEXT` | unchanged, still text, still no button |
| — | *the fault line* | **nothing below here is ever red** |
| S | `OUTSIDE — ARRIVALS` | moves out of the money run; both doors kept, rows condensed |
| S | `INCIDENTS · LLM SPEND · READ-ONLY` | unchanged |

Two structural facts to preserve:

- **No total spans the bank group.** Venue position and deposit pool are
  separate instruments with separate tones and separate absence rules. A shared
  total would be the cross-window arithmetic constraint §6.7 forbids. The frame
  asserts *same subject*, never *same instrument*.
- **The funnel–evidence weld is untouched.** The funnel and its on-chain proof
  never separate, on either surface.

## 3. Phone composition

Sequential. Above the fold, unchanged in rank:
`status bar → stale fence → VERDICT → trust → LEAD SLOT → solvency → flow+proof
→ BANK`. Then the fold, then `probes → OUTSIDE → incidents/build`.

Two changes:

- **The lead slot generalises** from *breached floor | nothing* to *breached
  floor | overdue bank request | nothing*, ranked by cost of inaction. It
  carries the promoted panel's own label and its own server-decided lines.
- **The pool lane is adopted into the bank group** (it is a bank instrument);
  **the arrivals lane moves below the fold** into the register with the probes.
  Arrivals is deliberately *not* adopted into the bank group: putting a demand
  fact inside a money group would assert it is money, which constraint §6.5
  exists to deny.

Both lanes stay one line. Neither gains a figure it did not have.

---

## 4. Diff surface

| File | Change | Kind |
|---|---|---|
| `components/ops/OpsBoard.tsx` | Band order: Arrivals below `NEXT`. `BankLane` + `DepositPoolTile` wrapped in one `<section class="ops-bank-group">`. Economics line moves inside `.ops-money`. | JSX order + one wrapper |
| `components/ops/BankLane.tsx` | `h2` → `h3` under the group heading. **No row, tone or string logic touched.** | heading level |
| `components/ops/DepositPoolTile.tsx` | Same demotion; six-fact `dl` goes 3 → 2 columns inside the half-width cell. `UNAVAILABLE` / `FAULT` / `BORN EMPTY` branches untouched. | heading level + grid |
| `components/ops/ArrivalsPanel.tsx` | Row density only. **Both doors, both series, every caveat kept verbatim.** | CSS-driven |
| `components/mobile/MobileBoard.tsx` | Lead slot generalised; pool `LanePanel` moves inside `BankPanel`; arrivals `LanePanel` moves into `.hm-ph-below`. | sequence + one conditional rank |
| `styles/hermes4-ops.css` | New `.ops-bank-group`; `.ops-bank`/`.ops-deposit-pool` lose standalone band borders; `.ops-arrivals` row height; `.ops-economics` reparented. | 4 blocks + 1 new |
| `styles/hermes4-mobile.css` | `.hm-ph-lane` gains nested-in-bank and below-fold variants. **No new colour tokens.** | 1 block |

---

## 5. Tests

**Two new, both required:**

1. **Nothing below the fault line is ever red.** Under `OPS_FIXTURE_RED` *and*
   `OPS_FIXTURE_STRESS`, no element at or below `NEXT` carries
   `data-tone="red"`. This makes the colour vocabulary positional and testable.
2. **A promoted bank group leaves the verdict byte-identical.** Render the phone
   with and without an overdue request; `mobile-verdict` textContent must be
   **identical**. This is the guard on Q3 — promotion changes reading order,
   never words. **Without this test the lead-slot change does not ship.**

**Must still pass, unchanged** (these encode truth rules; if one breaks, the
test is right and the layout is making a claim it should not):

- `BankLane.test.tsx` document-order check — subject precedes the numbers it
  qualifies. Nesting under a group heading must not reorder the lane's children.
- `OpsBoard.test.tsx` "every pool still renders" + the 3-meter count. The group
  is a wrapper, not a filter.
- `MobileBoard.test.tsx:388` — `mobile-bank-subject` precedes
  `mobile-bank-requests`. The bank group moves as a unit; internal order fixed.
- The phone's new lane tests (`mobile-pool`, `mobile-arrivals`) — moving a lane
  must not change its text or its tone rules.

Anything asserting `ops-deposit-pool` or `ops-bank` is a **direct child** of
`.ops-content` may legitimately need updating — but only if it was pinning
*presence*. If it was pinning *rank*, stop and ask.

---

## 6. Acceptance gate (Claude, on handback)

1. `npx vitest run packages/monitor-ui/src` green, including both new tests, and
   `npx tsc -b packages/schemas packages/monitor-ui services/slack-operator`
   clean.
2. **Diff contains no changed figure and no new string** beyond the D-Q2 heading
   re-split. I will read the diff for literals specifically.
3. Deleting either new test makes the suite fail for the right reason — a
   passing test that cannot fail is not a guard.
4. `git grep "3.10 USDC"` and `"0.05 USDC"` in `packages/monitor-ui` return
   **nothing**. The mockup's sample figures must not have travelled.
5. Both surfaces still render with `OPS_FIXTURE_NOMINAL`, `_LIVE`, `_RED` and
   `_STRESS` without an absent block producing a placeholder row.

---

## 7. Non-goals

- **The verdict/bank question (Q5)** — its own packet, after this lands.
- **Any producer change.** If a composition needs a value that does not exist,
  raise it; do not compute it in markup.
- **Restyling.** No new tokens, no new tones, no type changes. Red still belongs
  to the money path alone; grey still means we cannot see.
- **The two stale treatments.** Desk dims to 72%, phone fences at full contrast.
  They differ because the rooms differ. A "consistency" pass here breaks the
  outdoor case.
