# Hermes Orchestration — Phase 4 Design (Multi-Agent Collaboration)

- **Status:** Reconciled 2026-05-31. C4 inter-agent chat v1 shipped in #291. C1-C3 and remaining C follow-ups stay design/follow-up.
- **Date:** 2026-05-29
- **Companions:** the core [`HERMES_ORCHESTRATION_DESIGN.md`](./HERMES_ORCHESTRATION_DESIGN.md) (P1–P5), [`HERMES_PHASE2_DESIGN.md`](./HERMES_PHASE2_DESIGN.md) (A + D), [`HERMES_PHASE3_DESIGN.md`](./HERMES_PHASE3_DESIGN.md) (B).
- **Position:** **Phase 4 (Theme C).** Today agents work in *parallel but isolated* — each builds its own PR; only Hermes reviews. C makes them work *together* and lets the roster grow. **Modular:** it builds on the core's multi-worker (P2) + the existing review machinery, and is independent of B — it can land alongside Phase 2/3 rather than strictly after.

> Theme that carries through: **review depth scales with risk**, and **the human owns every disagreement.**

---

## C1 + C2 — Review model  ·  **cross-agent default + panel for high-risk** (decision #1)

- **Cross-agent review (default):** every PR is reviewed by the **non-builder** agent (Claude reviews Codex's work and vice versa), producing a structured verdict — an independent second set of eyes *before* the human, at no cost to your time. Reuses Hermes's existing structured `codeReview` block; the reviewer is just a different agent than the builder.
- **Panel for high-risk:** high-risk PRs (contracts, chain/settlement, secrets, migrations, deploy) get a **full panel** — Hermes + both builder agents review independently; the verdict is their agreement/majority. Defense-in-depth where it matters.
- This sits in front of the existing human gate: cross-agent/panel review is advisory and produces evidence; the operator still owns merge.

## Disagreement resolution  ·  **escalate to operator** (decision #2)

Any unresolved disagreement — a panel split, or a reviewer that blocks — **parks the PR for the operator**, showing each reviewer's verdict + reasoning side by side. The human owns the call. Consistent with every other gate in the system; no agent quietly overrides another. (Decision records from D2 make the disagreement legible.)

Implementation note: C2 is advisory only. A high-risk panel records independent
Hermes/Codex/Claude review requests and verdicts. A `block` verdict escalates as
soon as it lands; any completed non-unanimous panel also parks the card in
`needs-attention`, which lets the existing D4 alert bridge notify the operator.
No panel path merges, deploys, approves dispatch, or changes high-risk routing.

## C3 — Roster growth  ·  **internal specialists now, external later** (decision #3)

- **Internal specialists now:** add role-specific agents — a **test-writer**, a **security-review** agent, a **docs** agent — via the per-agent-runner pattern from P2. Adding one is modular: a new runner + a new `agentType` + a routing-taxonomy entry. The risk taxonomy decides what each is trusted with (e.g. the security-review agent is a reviewer, not a builder, on high-risk surfaces).
- **External/3rd-party agents later:** defer the generic external-agent interface (via the `ext` type) until internal collaboration is solid — external agents add a real trust/security surface (sandboxing, credential scope, allowlisting) that's better handled once the internal model is proven.

Implementation note: C3 first slice adds the `test-writer` internal specialist as the template. It reuses the Claude-family per-agent runner/branch-worker with `CLAUDE_TASK_RUNNER_AGENT=test-writer`, a role prompt, `test-writer/*` branch attribution, and the normal PR review/human merge gate. The security/docs extension follows the same seam: role prompt + per-agent branch worker + off-by-default runner profile + routing taxonomy entry. Security remains proposes-only; high-risk findings escalate to the operator instead of auto-acting.

## C4 — Inter-agent communication

Extend the board's collaboration channel (today: `codex | hermes | operator | system`; note `claude` isn't yet a collaboration author) so agents can coordinate directly on a card — e.g. a reviewer asking the builder to clarify, or Hermes brokering a disagreement before escalating. A data-model extension (`CollaborationAuthor`/`Target`) + UI; low-risk and immediately useful once there are ≥2 builders.

Implementation note: C4 v1 shipped in #291 with Claude author/target and card-scoped agent messages. Broader collaboration/review follow-ups are still governed by C1-C3.

---

## Dependencies & sequencing

- Needs the **per-agent runner + multiple builders (P2)** and the existing review machinery. Independent of Theme B.
- Suggested order within C: **C2 cross-agent review** (highest-leverage quality win, builds straight on Hermes's review) → **C4 inter-agent chat** (cheap, makes collaboration legible) → **C1 panels for high-risk** → **C3 specialist agents** (each a modular add).

## Decisions (resolved)

| # | Decision | Resolution |
|---|---|---|
| 1 | Review model | **Cross-agent review by default; full panel for high-risk** (depth scales with risk) |
| 2 | Disagreement resolution | **Escalate to the operator**, with all verdicts shown |
| 3 | Roster growth | **Internal specialists now** (test-writer, security, docs); **external/3rd-party deferred** |

**Invariants carried through:** no agent silently overrides another (disagreements escalate); the human still owns merge; review depth scales with risk; external agents wait until the internal model is proven (trust surface controlled).

---

*End of Phase 4 design. Reconciled 2026-05-31: C4 v1 has shipped; C1-C3 and remaining collaboration follow-ups are still design/follow-up.*
