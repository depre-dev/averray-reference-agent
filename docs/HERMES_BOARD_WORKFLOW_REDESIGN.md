# Hermes Monitor Board — Operator Workflow Redesign Plan

- **Status:** Plan / handoff. Grounded in a code-level audit (4 parallel auditors + adversarial critique) of the live board, anchored on the operator's stated vision.
- **Date:** 2026-06-01
- **Companions:** [`HERMES_ROADMAP.md`](./HERMES_ROADMAP.md), [`HERMES_GO_LIVE.md`](./HERMES_GO_LIVE.md), the v2 design handoff (`hermes-v2`).

> **Method note:** the P0–P2 fix items below cite **verified** code seams. An earlier draft cited several wrong/nonexistent locations; those were corrected against the source (see each item's file:line). Re-confirm a seam before cutting its handoff prompt.

---

## 0. The operator's vision — the board is TWO closed loops

The board exists to run two self-closing loops with **three agents** (Hermes = review + route, Codex + Claude = fix). The **operator is the merge gate and the last-resort escalation — not the dispatcher.** As trust builds, the operator is pulled in less.

**Loop 1 — the PR heartbeat**
```
PR opens → Hermes reviews
   ├─ PASS → operator lane: "all good, merge when ready"   ← operator's only routine job
   └─ FAIL → Hermes assigns to Codex or Claude
              → fixer returns a fix (new commits / PR)
              → Hermes re-reviews → (repeat until PASS) → operator lane
   reaches the operator to DECIDE only when the agents genuinely can't resolve it
```

**Loop 2 — the tester loop**
```
Tester invoked (operator OR an agent can invoke)
   → runs
   ├─ PASS → loop closes ✓
   └─ FAIL → report back → Hermes reads it → assigns fix to Codex/Claude
              → fixer fixes → RE-RUN tester → (repeat) → PASS → closes
```

**Build this simple loop running smoothly first; extend later.** Every redesign decision below serves these two loops and nothing else.

---

## 1. Honest verdict — is the board usable today?

**No.** It renders, and the bones are right (good lane taxonomy, real LLM wiring behind it), but every loop the operator runs dead-ends. Four reasons:

1. **Internal machinery masquerades as operator work.** Capacity backstops — `dispatch_budget_exhausted`, `open_fix_cap_reached`, `retry_budget_exhausted` — are emitted as handoff events with `status: needs_review` (`index.ts:2651-2653`, `intent: self_healing`) and classified onto the board by `monitor-hermes-board.ts`. The operator is asked to "decide" on things that are not decisions. This is the **worst** violation of the vision: the board's one job is to separate *needs-me* from *automation*, and it does the opposite.
2. **Primary actions silently dead-end.** "Investigate" → drawer whose "Open on github" hits the **repo root** (default/task variant uses `githubUrlForCard()` fallback) because proposed/self-heal cards carry no PR. "Ask Hermes" posts but gives **zero feedback**, so it reads as broken.
3. **Self-heal proposes impossible work — and auto-approves it.** The self-heal `propose` path calls `proposeCodexTask` then **`autoApproveProposedTask` immediately** (`index.ts:2621/2634`). The testbed disposition hands a `fixPrompt` even for *environment/auth* failures (e.g. an **HTTP 401** loading the page — `monitor-testbed-missions.ts:716-718`). Result: un-fixable "Self-healing fix: testbed-mission-*" cards auto-flow onto the board and dispatch into failure, eroding trust in every other card — **and bypassing the operator gate.**
4. **The co-pilot is buried, capped, and possibly mute.** Fixed ~420px with a `44vh` stream cap (`monitor.css:1166`); the LLM is **skipped entirely** when `OLLAMA_API_KEY` is unset (`monitor-hermes-voice.ts:162`) with no signal that the operator is getting templates, not answers.

Recoverable — the fixes are surgical, not a rewrite. But today it fails the blunt test.

---

## 2. The board as the two loops — what the operator should actually see

Map the eight lanes to **loop stages**. The operator-facing lanes are only the two ends of Loop 1 plus triage; everything else is the loops *running themselves* — calm, watch-only, no buttons.

| Lane | Loop stage | Operator meaning | Action? |
|------|-----------|------------------|---------|
| **operator-review** | Loop 1 · PASS | **"Ready — merge when you're comfortable."** | ✅ Approve merge / Send back |
| **needs-attention** | Loop 1/2 · STUCK | **"We couldn't resolve it — your call."** + failed-mission triage | ✅ Decide / Re-run / Send back |
| **codex-needed** | Loop 1/2 · dispatch gate | **"Approve to let an agent start."** (dispatchable only) | ✅ Approve & dispatch / Dismiss |
| **drafts** | author owns | "Author still working." | — |
| **hermes-checking** | Loop 1/2 · running | "Hermes/agent is working — watch only." | ❌ read-only |
| **release-queue** | Loop 1 · merging | "Branch protection / merge automation." | ❌ |
| **deploying** | post-merge | "Verifying — watch only." | ❌ |
| **done** | closed | History. | ❌ |

**The win condition:** the operator opens the board and sees a short list of *real* decisions — mostly "ready to merge" — or a first-class **"Nothing needs you right now"** empty state. Everything else is quiet progress in the loops. The tester is **invokable** (see §5), and its fail→fix→re-run cycle runs itself until it closes or gets stuck.

The operator's daily experience, in their terms: **SEE** (only what needs me) → **DECIDE** (one plain line: what happened, what Hermes recommends, what I'm approving) → **ACT** (one button that resolves it) → **RESOLVE/WATCH** (it moves to an automation lane; Hermes narrates) → **ASK** (plain-language questions answered in the rail, any time).

---

## 3. The single biggest fix — operator-facing vs internal

**One hard rule: a card exists only if it represents a decision or work item a human can act on.** Everything else is automation telemetry — it goes to **Slack (D4, already the intent) + one quiet status line**, never a card.

- **Off the board entirely (Slack-only + a single header/rail status line):** all capacity/escalation signals — `dispatch_budget_exhausted`, `open_fix_cap_reached`, `retry_budget_exhausted`, `halt_present`, `autopilot_suspended`, `dispatch_blocked:*`. A *gauge*, not a worklist: e.g. `Self-heal 2 open · dispatch 4/5`. **Do NOT build a whole new Diagnostics view yet** — that's net-new surface that risks re-introducing machinery-as-cards in another tab. Subtractive first; a dedicated view only if you later ask for it.
- **Fixed at the source:** environment/auth/runner failures (the 401 case) must yield **no `fixPrompt` → `autoFixable: false` → escalate as mission-triage**, not a code task. And self-heal proposals must **respect the operator gate** — no auto-approve/auto-dispatch of un-vetted fixes.

Get this boundary right and ~80% of what's drowning you disappears; the board collapses to the two loops.

---

## 4. Prioritized fix sequence (each item → one handoff prompt)

Ownership per coordination rules: self-heal/dispatch **decision logic = Codex**; UI/lane/rail render = **Claude**. Re-confirm each cited seam before cutting the prompt.

### P0 — Blunt-broken (the board lies, dead-ends, or bypasses the gate)

- **P0-1 · Take capacity/escalation signals off the board.** *(BUG · Codex)* — Self-heal/task-health escalation events (`index.ts:2651-2653`, `intent: self_healing`, `status: needs_review`) must not surface as board cards; alert **Slack-only** (already the D4 intent) + feed the single status line. Fix the `recordHandoffEvent` status and/or the `monitor-hermes-board.ts` classifier so `intent: self_healing` capacity reasons never become cards. **Accept:** no `dispatch_budget_exhausted` / `open_fix_cap_reached` / `retry_budget_exhausted` card ever appears.
- **P0-2 · Stop self-heal proposing & auto-approving un-fixable work.** *(BUG · Codex)* — (a) Disposition: environment/auth/runner failures (e.g. HTTP 401) yield **no `fixPrompt`** (`monitor-testbed-missions.ts:716-718`) → `autoFixable: false` → escalate as a **mission-triage** card (re-run / accept / open issue), never a code task. (b) Remove the **auto-approve** of self-heal proposals (`index.ts:2634 autoApproveProposedTask`) — they stay `proposed`, awaiting the operator (the gate). **Accept:** a failed `testbed:*` mission produces a triage card, not an auto-dispatched "Self-healing fix" code task; nothing reaches a branch/PR without an explicit operator approval click.
- **P0-3 · Fix "Open on github" wrong-target.** *(BUG · Claude)* — In the **default/task** drawer-footer variant, when there's no resolved PR, **disable** "Open on github" with an honest reason (*"No PR yet — opens once the task proposes a change"*) instead of the `githubUrlForCard()` repo-root fallback. (The merge variant is already correct.) **Accept:** no card silently links to the repo root.
- **P0-4 · Make "Ask Hermes" visibly respond.** *(BUG · Claude)* — Card-trigger path (`BoardView.tsx:351-355`): scroll composer into view + toast ("Asking Hermes about {card}"). Composer: optimistic render of the operator's message + "Hermes thinking…" indicator + inline error on POST failure; **disable input with "Ask Hermes unavailable"** when collaboration is off (no silent drop). **Accept:** every Ask-Hermes action produces immediate visible feedback.

### P1 — Workflow coherence (make the two loops legible)

- **P1-1 · `hermes-checking` stops being a junk drawer.** *(REDESIGN · Claude)* — Change the `laneFor()` default (`lane-rules.ts:22,28`): an unrouted card is a bug, not a silent `hermes-checking` resident — render it as a **de-emphasized, collapsed-by-default DegradedCard with a count** ("3 unrouted — source may be offline"), honest but *quiet*. Every in-flight card gets a status label ("Pre-check" / "CI watching" / "Mission running"). **Accept:** every card in the lane has a human title + reason; unrouted noise is collapsed, not loud.
- **P1-2 · Hoist the decision onto the card.** *(REDESIGN · Claude)* — Surface `decisionRecord.outcome.summary` + top reason in the card body for `needs-attention`/`codex-needed` (today buried in the drawer). **Accept:** the operator reads *what they're deciding* without opening anything.
- **P1-3 · One resolving primary action per operator card; none on watch-only cards.** *(REDESIGN · Claude)* — Each operator-facing card type has exactly one primary that moves/clears it (Approve & dispatch / Approve merge / Re-run / Send back). Internal/in-flight cards have **no buttons** — the absence is the signal "this isn't yours." "Approve & dispatch" authorizes an *agent to start* — **never** implies merge. **Accept:** no operator card without a working primary; no watch-only card with buttons.
- **P1-4 · Quiet automation-health status line.** *(REDESIGN · Codex + Claude)* — Roll the (now Slack-only) capacity signals into **one** status line in the existing header/rail (gauge, not worklist). **Accept:** automation health visible in one quiet place; it never touches the decision lanes. *(No new view.)*

### P2 — The rail + honesty

- **P2-1 · Full-height co-pilot.** *(REDESIGN · Claude)* — Replace `max-height: min(44vh, 520px)` (`monitor.css:1166`) with `flex:1` + independent scroll, sticky composer. **Accept:** ~8–10 turns visible without page scroll.
- **P2-2 · Honest reply labeling.** *(BUG · Claude + Codex)* — Label replies **"Hermes (live)"** vs **"(offline — templated)"**; one-time banner in template mode; load board context even without `OLLAMA_API_KEY` (`index.ts:1207`). **Accept:** the operator always knows whether they got inference or a template.
- **P2-3 · First-class empty state.** *(REDESIGN · Claude)* — "Nothing needs you right now" as a tested, deliberate state (the whole redesign makes the board go quiet — an empty board must read as *success*, not breakage). **Accept:** zero-decision board renders the calm empty state, tested.

> **Cut from the audit's draft (over-engineering risk):** a dedicated Diagnostics view (folded into P1-4's one status line) and proactive narration on every lane entry (adds rail chatter the operator didn't ask for — keep the rail responsive, not chatty).

---

## 5. The tester loop (Loop 2) — make it invokable and self-closing

- **Invoke affordance:** a clear way to launch the tester from the board/rail (operator *or* agent), per the T6 request→approve gate already built. The operator should be able to say "run the tester on X" and watch.
- **Fail → fix → re-run, automatically:** on FAIL, Hermes reads the report and assigns the fix to Codex/Claude (Loop 1 mechanics); on fix, the tester **re-runs**; the cycle repeats until PASS (loop closes) or it gets genuinely stuck → one `needs-attention` triage card. The operator sees the loop only at its ends, not every iteration.
- **Depends on:** P0-2 (so a tester *environment* failure doesn't masquerade as a code task) and the T4 live driver (already merged) actually running against staging.

---

## 6. Sequencing

1. **P0-1 + P0-2 (Codex)** and **P0-3 + P0-4 (Claude)** — these four make the board stop lying/dead-ending; they're independent and parallel.
2. **P1** — once the noise is gone, make the two loops legible.
3. **P2** — the rail and the empty state.
4. Re-run the burn-in on the *quiet* board; extend to more work only once these two loops run smoothly.

**Invariants (unchanged):** operator keeps merge/deploy; high-risk → Codex; truth-boundary (a quiet board is honest, a templated answer is labeled, an un-fixable failure is escalated not faked); nothing auto-dispatches without the operator's approval.

---

*End. The board's job is the two loops — surface the operator's two decisions ("merge this" / "we're stuck"), run everything else as calm progress, and answer in plain language. Build that smoothly first; extend later.*
