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
| E1  | Inbox-first layout cutover (keystone)  | `components/BoardView.tsx`, lane/board layout            | —       | ☐ not started |
| E2  | Decision-card grammar                  | `components/cards/DecisionInbox.tsx` (+ `Card.tsx`)      | E1      | ☐ not started |
| E3  | Read-only pipeline cards + jump        | `components/cards/CardRouter.tsx` + new pipeline card    | E1      | ☐ not started |
| E4  | Decisions banner + most-urgent         | `components/BoardNowBanner.tsx`                          | E1      | ☐ not started |
| E5  | Deploy stepper                         | `components/cards/ChecksBar.tsx` / new `DeployStepper`   | E1      | ☐ not started |
| E6  | Rail two-tab (Digest / Agent room)     | `components/hermes/CoPilotRail.tsx`                      | E1      | ☐ not started |

Status legend: ☐ not started · ◐ in progress (PR #) · ✅ merged (PR #) · ⚠ blocked (reason)

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
