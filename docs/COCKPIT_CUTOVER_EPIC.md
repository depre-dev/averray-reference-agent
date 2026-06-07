# Hermes-4 Cockpit Cutover — Build Epic (PR-E wave)

> **Coordination contract** for the inbox-first "decision cockpit" cutover.
> This doc is the source of truth for slice scope, file ownership, ordering,
> and status. **Only edit your own PR's status row.** Do not re-scope another
> slice or merge out of order.

## Goal

Make the live monitor board **look and function like the literal Claude Design
handoff**: an **inbox-first decision cockpit** where one **DECISION INBOX** is
*the* place to act, and the lanes are demoted to **read-only tiered pipeline**
(WATCH / DECIDE / HIDE). This is *kanban **and** inbox* — the lanes are kept (as
read-only mirrors), the inbox is added as the hero. Nothing about the kanban
layout (#427) is reversed.

The end-state (look + behaviour) is the Claude Design mockup — treat its
screenshot as the acceptance bar.

## Design reference (pixel spec — read before coding)

In-repo at `docs/design/hermes-4/project/` (merged in #429):

- Read **`Hermes.html` first**, then follow its imports:
  `app.jsx` · `board.jsx` · `kanban.jsx` · `parts.jsx` · `drawer.jsx` ·
  `rail.jsx` · `room.jsx` · `utilities.jsx` · `data.jsx` · `hermes.css`.
- Recreate the **visual output** faithfully in `packages/monitor-ui` (React/TS).
  Don't copy the prototype's internal structure unless it happens to fit.

`kanban.jsx` header states the core model verbatim:
> DECIDE inbox = union of all `waitingOn==='operator'` cards (the ONE place to
> act). WATCH/HIDE lanes show the same cards in pipeline position, READ-ONLY.

## What already exists (reuse — do not rebuild)

The Hermes-4 D-wave (#429–#438) already shipped the primitives:

- **Tier model** `tierFor` — `needs-attention → decide` (the inbox),
  `done → hide`, every other lane → `watch`. Tested.
- **Most-urgent** selection logic (5 files).
- **Inbox-union** concept (`waitingOn==='operator'`, 23 files).
- **Rail digest** (#436) and the **`--h4` profile/token system** fully applied
  to cards + lanes (#438). The visual layer is done — **this wave is structure,
  not reskin.**

## What's missing (this wave builds it)

- The **inbox-first layout** — `BoardView.tsx` still renders flat, actionable
  lanes (`<LanesBar/>` + lanes), not the inbox hero + read-only tiers.
- **"Why you're seeing this"** reason grammar (0 files today).
- **"Awaiting your decision in inbox · jump ›"** read-only mirror (0 files).
- The **deploy stepper** (CI queued → … → ready) (0 files).
- The **two-tab rail** (Digest / Agent room).

## Hard rules (every PR)

- **Truth-boundary:** render only real board state; degraded = `?` not `0`;
  honest-empty; any value not wired to a real backend shows an explicit
  **"awaiting data"/preview** slot, **never a fabricated number** (the design
  itself does this: *"advanced counts … honest until wired"*).
- **Tokens:** extend the #430 theme engine + 6 profiles + the #438 `--h4`
  card/lane system — **do NOT fork** the token layer.
- **Tests:** unit-test every new component; keep existing tests green.
  Layout-structural tests you intentionally change get **updated, not deleted**.
- **Workflow:** fresh worktree · **one narrow PR** · CI green ·
  **do NOT push to main** (human merges) · frontend → Claude runner.
- **File scope:** each slice owns a distinct component file (table below) to
  avoid collisions. **Rebase on E1 before merge.**

## Ordering

**E1 is the keystone — dispatch + merge it FIRST** (it restructures
`BoardView.tsx`). Then **E2–E6 in parallel**, each rebased on merged E1.

## Status board

| PR  | Slice                                  | Primary files (confirm against code)                    | Depends | Status        |
|-----|----------------------------------------|---------------------------------------------------------|---------|---------------|
| E1  | Inbox-first layout cutover (keystone)  | `components/BoardView.tsx`, lane/board layout            | —       | ✅ merged #440 |
| E2  | Decision-card grammar                  | `components/cards/DecisionInbox.tsx` (+ `Card.tsx`)      | E1      | ✅ merged #444 · ⚠ grammar partial → F3 |
| E3  | Read-only pipeline cards + jump        | `components/cards/CardRouter.tsx` + new pipeline card    | E1      | ✅ merged #445 · ⚠ applied to done cards → F2 |
| E4  | Decisions banner + most-urgent         | `components/BoardNowBanner.tsx`                          | E1      | ✅ merged #441 · ⚠ not wired into top slot → F2 |
| E5  | Deploy stepper                         | `components/cards/ChecksBar.tsx` / new `DeployStepper`   | E1      | ✅ merged #442 · ⚠ shadowed by dedupe → F3 |
| E6  | Rail two-tab (Digest / Agent room)     | `components/hermes/CoPilotRail.tsx`                      | E1      | ✅ merged #443 · ⚠ count not filtered → F1 |

Status legend: ☐ not started · ◐ in progress (PR #) · ✅ merged (PR #) · ⚠ blocked (reason)

> **E-wave shipped + deployed (main `76b0555`), but the cockpit is not yet
> correct.** All six structural slices merged, but a post-deploy review found
> the inbox, rail count, and banner disagree on what "an operator decision" is —
> done/verified release-history leaks into the inbox and inflates the count (9
> shown vs ~3 real), violating truth-boundary. The **PR-F correctness wave**
> below fixes it. Read it before touching the board further.

## Slice detail

### E1 — Inbox-first layout cutover (KEYSTONE — merge first)
Replace the flat 8-lane render in `BoardView.tsx` with the design's inbox-first
columns (`board.jsx`/`kanban.jsx`): a hero **DECISION INBOX** column
("Your decisions" + count + eyebrow "EVERYTHING WAITING ON YOU") holding the
union of `tierFor==='decide'` cards (the one actionable surface), then the
**read-only tier lanes** with the design's eyebrows — WATCH ("Builder tasks",
"Runs needing review", "Deploying"), HIDE ("Done"). Reuse `tierFor` + the
design's lane→column mapping. Match column widths, rounded lanes, tier eyebrows,
collapse chevrons. Keep `CoPilotRail` (E6 tabs it) and the Utilities bar.
Update the layout-structural tests that assumed flat lanes — that change is the
point. **Acceptance:** board renders as `Hermes.html` (inbox hero + read-only
tiers), real cards only, non-structural tests green.

### E2 — Decision-card grammar (rebase on E1)
Build the inbox card body per `parts.jsx`/`kanban.jsx`: identity → title → repo →
status badges (FAILED/BLOCKED · risk · INFRA) → **"Why you're seeing this"**
(reason *derived from real card state*: timed-out / policy-store 503 / blocked
Nh — never invented) → **"What happens next"** → **recommended primary action**
button (label from the card's recommendation, e.g. "Rerun once with 45s nav
budget") → **"Choices ↓"** disclosure. Honest fallback when a reason can't be
derived. Unit-test the reason-derivation. **Acceptance:** matches `parts.jsx`;
reasons trace to real fields.

### E3 — Read-only pipeline cards + jump-to-inbox (rebase on E1)
Lane cards become compact **read-only mirrors** (`kanban.jsx` "read-only
pipeline card"): identity + title + repo + status, plus
**"Awaiting your decision in inbox · jump ›"** that focuses/scrolls to the same
card in the DECISION INBOX; HIDE/Done cards show the "VERIFIED" mirror. **No
actionable buttons in lanes** — actions live only in the inbox. **Acceptance:**
lanes non-actionable; "jump ›" focuses the matching inbox card.

### E4 — Decisions banner + most-urgent (rebase on E1)
Top banner per `app.jsx`: **"N decisions waiting on you"** + **"Most urgent:
&lt;title&gt; — suggests &lt;action&gt;"** + the **MOST URGENT BECAUSE** chips
(blocked Nh / blocks N tasks / risk / safe — from real signals) +
**"Review most urgent ↵"** focusing the top inbox card. Reuse the existing
most-urgent logic; honest when signals absent. **Acceptance:** matches design;
traces to real selection.

### E5 — Deploy stepper (rebase on E1)
In the Deploying (WATCH) lane, the **stepper** per `kanban.jsx`: "Current deploy:
verifying" + CI queued → install → unit tests → browser replay → Hermes review →
ready, each with real state (done ✓ / in-progress ⟳ / pending). Any step not
wired to a real source renders explicit **"awaiting data" pending — no fake ✓.**
**Acceptance:** matches design; zero fabricated green steps.

### E6 — Rail two-tab: Digest / Agent room (rebase on E1)
Tab `CoPilotRail` per `rail.jsx`/`room.jsx`: a **Digest** tab (stat tiles
NEEDS YOU / RUNNING NOW / ADVANCED(session) / PROD CHANGES with the "honest until
wired" note for unbacked deltas; the "N WAITING ON YOU" list with per-card rec +
risk/grants chips + "Open ›"; "Open agent room →" / "Who's who") and an
**Agent room** tab (existing collaboration view). Reuse #436's rail-digest; keep
the pinned Ask-Hermes composer. **Acceptance:** matches `rail.jsx`; session
deltas honest-until-wired.

## Common preamble (paste atop each agent handoff)

> Repo `depre-dev/averray-reference-agent`, package `packages/monitor-ui`
> (React/TS). Implement part of the **literal Hermes-4 "decision cockpit"** —
> see `docs/COCKPIT_CUTOVER_EPIC.md` for the full wave + your slice. The pixel
> spec is in-repo at `docs/design/hermes-4/project/` — read `Hermes.html` first,
> then follow its imports. Recreate the design's visual output faithfully using
> the existing token system (#430 theme engine + 6 profiles + #438 `--h4`
> card/lane system — **extend, don't fork**). **Truth-boundary (hard):** real
> board state only; degraded = `?` not `0`; honest-empty; unwired values show an
> explicit "awaiting data"/preview slot, **never a fabricated number**.
> Unit-test every new component; keep existing tests green (structural tests you
> intentionally change get *updated*, not deleted). Fresh worktree, **one narrow
> PR, CI green, do NOT push to main** (human merges). Frontend → Claude runner.

---

# PR-F wave — Cockpit Correctness (follow-up)

> The E-wave shipped the cockpit *structure*; this wave makes it *correct*.
> Same hard rules + common preamble as above. **Verified deployed** (main
> `76b0555`) before this review, so every item below is a real bug in merged
> code, not a deploy lag.

## Root cause (read first)

There is **no single shared definition of "an operator decision."** Three
surfaces compute it differently and disagree:

- `lib/monitor/board-state.ts:255` has the *correct* predicate:
  `card.waitingOn?.actor === "operator" && (card.lane === "operator-review" || card.isAction === true)`.
- `lib/monitor/rail-digest.ts` has **no done/verified/closed exclusion** — so the
  rail "WAITING ON YOU" count and the inbox union pull in release-history cards.
- The banner still renders the **old** string `board-state.ts:229`
  (*"No operator decision needed…"*) — E4's banner (#441) isn't wired into the
  top slot.

**Symptom:** the inbox + rail show **9 "waiting on you"** when only **~3** are
real decisions (the rest are codex release-history cards that literally say
*"keep as release history; no board action needed"*). That inflates the decision
count — a **truth-boundary violation** and the opposite of "one place to act."

## Ordering

**F1 is the keystone — merge it FIRST** (the shared predicate). Then **F2 + F3
in parallel**, rebased on merged F1.

## Status board

| PR  | Slice                                         | Primary files                                                  | Depends | Status        |
|-----|-----------------------------------------------|----------------------------------------------------------------|---------|---------------|
| F1  | Single source of truth: operator-decision     | `lib/monitor/rail-digest.ts`, `lib/monitor/board-state.ts`, inbox membership | —  | ☐ not started |
| F2  | Banner cutover + done passive state           | `components/BoardNowBanner.tsx`, `components/cards/CardRouter.tsx` (done mirror) | F1 | ☐ not started |
| F3  | Deploy stepper visibility + finish card grammar | deploy lane render, `components/cards/DecisionInbox.tsx`       | F1      | ☐ not started |

Status legend: ☐ not started · ◐ in progress (PR #) · ✅ merged (PR #) · ⚠ blocked (reason)

## Slice detail

### F1 — Single source of truth for "operator decision" (KEYSTONE — merge first)
Make **one** predicate the only definition of a card that's waiting on the
operator — reuse/centralise `isDecision` (`board-state.ts:255`). Then make
**all three** consumers use it and **exclude done / verified / closed**:
(1) the **Decision Inbox membership** (the hero column must contain only real
decisions, not release-history); (2) the **rail "WAITING ON YOU" list + count**
(`rail-digest.ts` — add the exclusion it's missing); (3) the count the banner
reads. After this, "N waiting" must equal the real operator-decision count
(≈3 today), and no card that says "no board action needed" appears in the inbox
or the count. Unit-test the predicate + each consumer with a done/verified card
that must be excluded. **Acceptance:** inbox, rail count, and banner agree; zero
release-history in the inbox; truth-boundary restored.

### F2 — Banner cutover + done passive state (rebase on F1)
(a) **Retire the old banner string** (`board-state.ts:229`) and render E4's
(#441) **"N decisions waiting on you · Most urgent: …"** banner in the top slot,
driven by the F1 count (so it can never again contradict the inbox). When the
real count is 0, show an honest "nothing waiting" state — not a fabricated
urgency. (b) **Done/verified cards** in the HIDE lane must show a **passive
"VERIFIED" mirror** — remove the wrongly-applied *"Awaiting your decision in
inbox · JUMP ›"* affordance from cards that have no live decision. **Acceptance:**
banner matches the design + agrees with the inbox; Done cards are passive, no
"awaiting decision" on finished work.

### F3 — Deploy stepper visibility + finish decision-card grammar (rebase on F1)
(a) **Deploy stepper:** ensure E5's stepper (CI queued → install → unit tests →
browser replay → Hermes review → ready) actually renders for the active deploy —
the dedupe "N SIMILAR … Expand" grouping is currently shadowing it. Decide the
rule (e.g. the current/active deploy shows the stepper; *older* near-identical
verifications may still group) and wire it; honest "awaiting data" for any
unwired step — no fake ✓. (b) **Decision-card grammar:** the inbox cards show
"Why you're seeing this" but are missing **"What happens next"**, the
**recommended primary action** button, and **"Choices ↓"** (E2 #444 left these
partial) — complete them per `parts.jsx`, derived from real card state.
**Acceptance:** the active deploy shows the stepper; inbox cards carry the full
grammar; nothing fabricated.

---

# PR-G — Cockpit Polish (refinement)

> The E + F waves made the cockpit *correct*. This is true polish — visual
> discipline, not behaviour. Same hard rules + common preamble. **Verified
> deployed** (main `402fb26`) before this review.

## Why (post-F review of the live board)

The cockpit is correct, but a close look found the **accent color is
over-applied**, which both looks noisy and slightly misleads (read-only
surfaces wearing the "act" color look actionable). `--act` (coral) is the
single *"needs-you / act"* signal and should mark **only the one primary
action**.

## Status board

| PR  | Slice                                                         | Primary files                                                                  | Depends | Status        |
|-----|---------------------------------------------------------------|--------------------------------------------------------------------------------|---------|---------------|
| G   | Accent discipline + button consistency + honest stepper label | `styles/hermes4-cards.css`, `styles/hermes4-kanban.css`, deploy-stepper render  | —       | ☐ not started |

Status legend: ☐ not started · ◐ in progress (PR #) · ✅ merged (PR #) · ⚠ blocked (reason)

> Note: the **"gate" badge is intentional** (`KanbanBoard.tsx:124`,
> `.hm-col-gate`, title "Operator gate") — do **not** remove it.

## Slice detail

### PR-G — Accent discipline + button consistency + honest stepper label
Three small, visual-only fixes (no behaviour change):

1. **Quiet the read-only JUMP affordance.** The *"Awaiting your decision in
   inbox · JUMP ›"* control on the read-only WATCH mirror cards is currently
   painted in `--act` coral, so it shouts like an action. Restyle it as a
   **quiet/ghost** navigation affordance (neutral/`--tel` tone). Reserve `--act`
   coral for genuine primary actions only. (Mild honesty win: read-only must not
   look actionable.)
2. **Consistent inbox primary buttons.** The inbox "Approve & dispatch" buttons
   render inconsistently — the top (most-urgent) card's button looks muted while
   the others are bright. Make them consistent, and ensure the **most-urgent
   card's CTA is the strongest**, never the weakest. One coherent primary-button
   style across inbox cards.
3. **Honest deploy-stepper label.** The stepper currently shows every step
   "pending" because per-step deploy/CI telemetry isn't wired. That's honest —
   keep it — but add a small explicit **"awaiting deploy telemetry"** affordance
   so it reads as intentional, not broken. **Do NOT fabricate ✓ steps.** (Wiring
   real per-step state is a separate future data task, out of scope here.)

**Acceptance:** `--act` coral appears only on real primary actions; read-only
JUMP is a quiet affordance; inbox primary buttons are consistent with the
most-urgent strongest; the all-pending stepper carries an honest "awaiting
telemetry" note. No behaviour change; truth-boundary preserved; existing tests
green.
