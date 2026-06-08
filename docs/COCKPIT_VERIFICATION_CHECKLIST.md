# Hermes-4 Cockpit — Verification Checklist

> Goal: turn "probably done" into **confirmed**. Walk every surface, every
> control, and every data boundary against the Claude Design handoff, on the
> **live deployed board** — not from memory, not from a single screenshot.
>
> Reference (the source of truth for "what it should look/do"):
> `docs/design/hermes-4/project/Hermes.html` (+ its imports: `app/board/kanban/
> parts/drawer/rail/room/utilities/data.jsx`, `hermes.css`).
>
> Deployed at time of writing: `monitor.averray.com/monitor`, main `1eee53d`
> (#452). If main has moved, re-confirm the deploy first.

## How to run this

**Two modes — pick one:**
1. **Human walk.** Open the live board and `Hermes.html` side by side. Go item
   by item; mark `✅` / `❌` / `⚠️ partial`; add a note + screenshot for any
   non-✅. ~20 min.
2. **Browser agent.** Hand this file to an agent that has the Cloudflare Access
   credential for `monitor.averray.com`. It drives the live board, screenshots
   each region, clicks each control, and fills the Result column. Frontend →
   any browser-capable runner.

**Rule:** an item is ✅ only if *observed working on the live board*, not
inferred from code. A real-data board may legitimately show fewer cards than the
mockup — judge **structure + behaviour + honesty**, not identical *content*.

---

## A. Visual fidelity (live board vs `Hermes.html`)

| # | Surface | Expected (per handoff) | Result |
|---|---------|------------------------|--------|
| A1 | **Shell / viewport fill** | Board fills the viewport top-to-bottom — **no dead-space void**, **no desktop/wallpaper bleed** at the bottom; header → banner → utilities → board → footer; footer pins to the bottom. | ☐ |
| A2 | **Top decisions banner** | "N decisions waiting on you" + "Most urgent: … — suggests …" + `MOST URGENT BECAUSE` chips + `Review most urgent` + `Open review checklist`. N matches the real inbox count. | ☐ |
| A3 | **Filter row** | search box · "focus on the lane that needs you" · sorted by next-action urgency · All / Blocked / Review / Ready / Running / Done with live counts. | ☐ |
| A4 | **Utilities bar** | **Warm-dark, not gray** (the #452 fix). "Utilities · LLM usage · suites · tester launcher · … tester ready". | ☐ |
| A5 | **DECISION INBOX hero** | Warm, coral-accented hero column: "Your decisions" + count + `GATE` + "EVERYTHING WAITING ON YOU". Reads as *the* place to act. | ☐ |
| A6 | **Decision card grammar** | Each inbox card: agent identity → title → repo → badges (FRESH / NEEDS YOU / risk / INFRA) → **Why you're seeing this** → **What happens next** → primary action (e.g. "Approve & dispatch") → **Choices ↓**. | ☐ |
| A7 | **Primary-button consistency** | `Approve & dispatch` consistent across inbox cards; the **most-urgent** card's CTA is the **strongest**, not muted (PR-G). | ☐ |
| A8 | **Tier lanes (read-only)** | `WATCH` (Builder tasks, Runs needing review, Deploying) + `HIDE` (Done) with tier eyebrows + collapse chevrons. | ☐ |
| A9 | **Pipeline mirror cards** | Lane cards are read-only mirrors with a **quiet** "Awaiting your decision in inbox · JUMP ›" (PR-G: *not* loud coral). No action buttons in lanes. | ☐ |
| A10 | **Done = passive VERIFIED** | HIDE/Done cards show passive `VERIFIED` — **no** "awaiting decision · jump". | ☐ |
| A11 | **Deploy stepper** | Deploying lane shows "Current deploy: verifying" + CI queued → install → unit tests → browser replay → Hermes review → ready, with an honest "awaiting deploy telemetry" note (not fake ✓). | ☐ |
| A12 | **Rail — Digest tab** | **Warm, not gray** (#452). Stat tiles (NEEDS YOU / RUNNING NOW / ADVANCED / PROD CHANGES) + "honest until wired" note + "N WAITING ON YOU" list (rec + risk/grants chips + Open ›) + Open agent room / Who's who. | ☐ |
| A13 | **Rail — Agent room tab** | **Warm, not gray** (#452). Room presence / "No agent chatter yet" empty state + Board current summary + "Referenced card" pin (warm, not gray). | ☐ |
| A14 | **Composer** | Pinned at bottom: TO @everyone · SCOPE board · SUPERVISED · "Ask Hermes /task …" input · Send. Box **above** it (follow-ups) is warm, not gray. | ☐ |
| A15 | **Accent discipline** | `--act` coral appears **only** on real primary actions — not on JUMP mirrors, not splattered. Everything else warm-neutral. | ☐ |
| A16 | **No gray patches anywhere** | Sweep the whole board: utilities, rail, room, composer-area, cards — **zero** light-gray surfaces left. | ☐ |

## B. Functional behaviour (click each — does it do the right thing?)

| # | Control | Expected action | Result |
|---|---------|-----------------|--------|
| B1 | `Approve & dispatch` (inbox) | Dispatches the task to its agent (operator gate fires); card moves out of "waiting". | ☐ |
| B2 | `Choices ↓` (inbox) | Expands the alternative actions for that decision. | ☐ |
| B3 | `JUMP ›` (lane mirror) | Focuses/scrolls to the **same** card in the DECISION INBOX. | ☐ |
| B4 | `Review most urgent` (banner) | Focuses the top inbox card. | ☐ |
| B5 | `Open review checklist` (banner) | Opens the review checklist (confirm it does something real, not a no-op). | ☐ |
| B6 | Lane collapse chevrons | Collapse / expand the lane; collapsed gate lanes show as reachable rails. | ☐ |
| B7 | Filter chips (Blocked / Review / …) | Filter the board to that subset; counts match. | ☐ |
| B8 | Search box | Filters by PR / repo / correlation. | ☐ |
| B9 | Rail tab switch (Digest ⇄ Agent room) | Switches panels; state preserved. | ☐ |
| B10 | Utilities expand | Reveals LLM usage / saved suites / tester launcher. | ☐ |
| B11 | `Start a mission` (tester) | Launches a real browser run from the board. | ☐ |
| B12 | Composer `Send` | Sends the `/task` … `/mission` … command to Hermes; appears in the room. | ☐ |
| B13 | Click a card | Opens the detail drawer for that card variant. | ☐ |
| B14 | `Open ›` (rail waiting item) | Opens / focuses that decision. | ☐ |
| B15 | Done card | **No** action affordance — passive (confirms A10 behaviourally). | ☐ |

## C. Data-wiring boundaries (is each honest — and do you want it live?)

These are **deliberately unwired** today and show honest "awaiting data". For
each: confirm it reads honestly (not a fabricated value), then decide if it
should be wired (a **backend task**, separate from the design).

| # | Boundary (code ref) | Today | Want it live? |
|---|--------------------|-------|---------------|
| C1 | Session deltas — "since you last looked" (`CoPilotRail.tsx:362`) | "honest until wired — not wired yet" | ☐ keep / ☐ wire |
| C2 | `risk · not recorded` (`CoPilotRail.tsx:469`) | honest-empty | ☐ keep / ☐ wire |
| C3 | `grants · not recorded` (`CoPilotRail.tsx:474`) | honest-empty | ☐ keep / ☐ wire |
| C4 | Deploy stepper per-step state | all "pending" / "awaiting telemetry" | ☐ keep / ☐ wire |
| C5 | Follow-ups (`planner-only · read-only`) | no tasks created | ☐ keep / ☐ wire |
| C6 | ADVANCED / PROD CHANGES stat tiles | blank (no session backend) | ☐ keep / ☐ wire |

## D. Truth-boundary (the paramount rule — must all pass)

| # | Check | Result |
|---|-------|--------|
| D1 | The decision count is **real** (e.g. 3, not 9 padded with release-history) — the F1 fix holds. | ☐ |
| D2 | Degraded/disconnected shows `?`, never `0`. | ☐ |
| D3 | Empty states are honest ("No agent chatter yet", "No follow-up suggestions right now") — not fake-populated. | ☐ |
| D4 | No fabricated numbers anywhere; every unwired value is an explicit "awaiting data" slot. | ☐ |

## E. Regression / health

| # | Check | Result |
|---|-------|--------|
| E1 | CI green on `main` (full monitor-ui test suite). | ☐ |
| E2 | DOM contracts intact — lane aria-labels, the kanban grid, mini-rail (existing tests still pass). | ☐ |
| E3 | Keyboard shortcuts + drawer still work. | ☐ |

---

## Sign-off

- [ ] **A — Visual** all ✅ (or deviations logged below)
- [ ] **B — Functional** all ✅
- [ ] **C — Boundaries** all confirmed honest; wiring decisions recorded
- [ ] **D — Truth-boundary** all ✅ (non-negotiable)
- [ ] **E — Regression** all ✅

**Only when A + B + D + E are ✅ is it a confirmed 1-to-1 working cockpit.**
"C live" is a separate backend track, not a design defect.

### Deviations found (fill in)

| Item | What's wrong | Screenshot | Fix PR |
|------|--------------|-----------|--------|
|  |  |  |  |
