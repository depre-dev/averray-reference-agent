# Hermes Orchestration — Agent Models & Effort Policy

- **Status:** Planning / handoff. Pins down which model each agent role runs, the tester's LLM, and how reasoning **effort** is chosen.
- **Date:** 2026-05-31
- **Companions:** [`HERMES_ORCHESTRATION_DESIGN.md`](./HERMES_ORCHESTRATION_DESIGN.md) (routing/riskTier), [`HERMES_PHASE2_DESIGN.md`](./HERMES_PHASE2_DESIGN.md) (A-stream/cost), [`HERMES_E2E_TESTER_DESIGN.md`](./HERMES_E2E_TESTER_DESIGN.md) (T4), [`HERMES_WORKER_AUTH_BILLING.md`](./HERMES_WORKER_AUTH_BILLING.md) (billing).

> **Effort is the main cost+quality lever.** A single global setting either burns money on trivial tasks or under-powers the dangerous ones. The policy below ties effort to the **`riskTier`** the routing taxonomy (O4-PR2) already computes — the same dimension that keeps high-risk on Codex.

---

## 1. Model topology — who runs what

| Role | Model (today) | Source / notes |
|---|---|---|
| **Hermes** (orchestrator / reviewer / narration / routing / autopilot judgments) | `deepseek-v4-pro:cloud` via Ollama Cloud | `HERMES_DEFAULT_MODEL` in compose; the GH workflows call `hermes chat -m deepseek-v4-pro:cloud`. **Not** Claude/Codex. |
| **Codex worker** (chain/settlement, high-risk lane) | the `codex` CLI (GPT-5-codex) | on the ChatGPT subscription |
| **Claude worker** (UI/docs/general lane) | Claude Agent SDK | sub OAuth / API key per the billing doc |
| **Tier-1 tester** (T1, live) | **none — deterministic Playwright** | the per-deploy public sweep is *not* an LLM; it's free |
| **Tier-2 tester** (T4, not built) | **Claude Agent SDK** (see §2) | the LLM gold-path agent |

---

## 2. The Tier-2 tester's LLM (T4)

- **Default: Claude Sonnet for routine runs; Opus for deep/critical evaluations.** Sonnet handles the agentic browser + multi-step + self-judging loop well and runs often (per-deploy / on-demand) → cost favors it; reserve Opus for the occasional "is the product genuinely usable?" pass.
- **Multi-backend later (T5 enhancement).** The tester's *purpose* is "**can an external agent use our product?**" — and real external agents won't all be Claude. The truest signal eventually comes from running the gold-path with **≥2 backends** (a Claude tester *and* a Codex/GPT tester) so you catch "works for Claude agents, breaks for GPT agents." **v1 (T4): ship Claude/Sonnet**; add a second backend in T5.
- Billing follows [`HERMES_WORKER_AUTH_BILLING.md`](./HERMES_WORKER_AUTH_BILLING.md) (programmatic Claude → sub credit / API key + cap; the startup route-verification check). Model choice is the dominant cost driver for the tester.

---

## 3. Effort policy — driven by `riskTier`

The workers and tester pick reasoning effort from the task's `riskTier` (O4-PR2), with an operator override:

| `riskTier` | Codex | Claude | Why |
|---|---|---|---|
| **high** (contracts / chain-settlement / secrets / migrations / deploy-ops) | **high** reasoning | **Opus** + extended thinking | correctness-critical, hard to reverse — spend the effort |
| **low / medium** (UI / docs / tests / refactors / general) | **medium** reasoning | **Sonnet** | routine; medium is plenty and keeps cost down |

- **Operator override:** an effort selector on the board next to the agent picker, so the operator can push effort up (or down) per task when they know better. The risk-tier value is the *default*, not a hard rule.
- **Cost link (A3):** effort is the main cost lever, so this policy *is* the practical core of cost-aware routing — high effort only where risk justifies it. A3's $-budget rides on top.
- **Until wired:** set worker defaults **Codex = medium, Claude = Sonnet**, and bump the high-risk lane to **high / Opus** manually.

**Invariant:** high-risk work always gets high effort — never under-power the dangerous lane (the same spirit as "high-risk → Codex, rule-bound"). Effort/model never bypasses the safety gates (guardrail, approval, HALT).

---

## 4. Hermes's own model — open decision

Hermes runs `deepseek-v4-pro:cloud` today. That was fine when Hermes only *reviewed + narrated* — but with O4 it now makes **routing and (under autopilot) auto-approval judgments**, where judgment quality directly affects what gets built and approved.

**Recommendation (operator to confirm): a tiered Hermes model.** Keep a cheap, fast model (deepseek) for high-frequency narration/status, but use a **stronger model (Claude Opus / GPT) for the autopilot-critical paths** — routing decisions and the auto-approval reasoning — where a bad call is expensive. At minimum, *evaluate* a stronger model on those paths before relying on autopilot heavily.

This is the one genuinely open call here — flagged for the operator.

---

## Decisions

| Decision | Resolution |
|---|---|
| Tier-2 tester LLM | **Claude Sonnet (routine) / Opus (deep)**; multi-backend (Claude + Codex/GPT) as a T5 enhancement |
| Effort selection | **Driven by `riskTier`** (high → high/Opus; low/med → medium/Sonnet) + an **operator override** on the board |
| Today's worker defaults | Codex = medium, Claude = Sonnet; high-risk → high/Opus |
| **Hermes's model** | **OPEN** — recommend a tiered model (cheap narration / stronger for routing + auto-approval); operator decision |

## Roadmap fit

- **A4 — riskTier → effort/model wiring:** workers + tester read `riskTier` and set reasoning effort / model accordingly; add the operator effort-override on the board. Small; slots beside A3 (cost).
- **Multi-backend tester:** a T5 enhancement (a Codex/GPT gold-path tester alongside the Claude one).
- **Hermes model decision:** operator call, before heavy autopilot use.

---

*End. Planning/handoff only — the policy is recorded; A4 wires it, and Hermes's model is an operator decision.*
