# Monitor action parity — wiring the redesigned board's operator actions

**Status:** spec / hand-off for the monitor **action-flow lane** (Codex).
**Context:** the Hermes redesign is now the default board at `/monitor`
(cutover #241; legacy HTML demoted to `/monitor/legacy`). The board is
**view + chat + mission-spawn + rich statuses** (drawer now shows real
file diffs, per-check breakdown, and risk findings — #243). What it does
**not** yet do is wire the operator **action** endpoints the legacy
monitor had. This doc specifies that gap so the new board reaches parity.

> Lane note: the redesign frontend (`packages/monitor-ui`), the v2
> serializer (`monitor-v2.ts`), and the SPA serve are the Claude lane.
> The **action endpoints** (`/monitor/recheck`, `/monitor/codex-tasks`,
> `/monitor/command`) and their behaviour are the Codex action-flow lane
> (`codex/monitor-action-*`). This spec is the contract between them.

## Evidence

Operator-review drawer for `averray-agent/agent #590`
("ops: add KMS CloudWatch alarm proof validator"): the drawer renders
HERMES VERDICT, FILES & RISK SIGNALS, and CHECKS · 9/9 — but there is **no
button that does anything**. The footer's `Ask Hermes` opens chat; there
is no working "recheck", "approve & merge", or "dispatch to Codex".
(Screenshot shared in the redesign thread; attach to the tracking issue.)

## Parity matrix — frontend wiring

| Capability | Legacy endpoint | New board today | Wire to |
|---|---|---|---|
| Re-run Hermes pre-check on a PR | `POST /monitor/recheck` | ❌ none | a drawer button on PR / operator-review cards |
| Dispatch / approve a Codex task | `POST /monitor/codex-tasks` | ❌ view only (prompt shown) | the `codex-needed` lane card + task drawer |
| Operator command box | `POST /monitor/command` | ❌ (chat posts to `/monitor/collaboration` instead) | decide: keep as chat, or add a command affordance |

Already wired (for reference, no work): `GET /monitor/v2/board`,
SSE `/monitor/v2/stream`, `POST /monitor/testbed-missions` (the `/mission`
command), `GET`+`POST /monitor/collaboration` (co-pilot chat).

## Required behaviour

### 1. Recheck (`POST /monitor/recheck`)
- **Where:** a button in the detail drawer for PR / operator-review /
  hermes-checking cards (e.g. footer "Re-check"), and optionally a
  per-card affordance.
- **Payload:** mirror the legacy caller (`{ repo, number }` /
  correlation). Confirm the exact shape against the current handler.
- **UX:** optimistic "re-checking…" state; the result arrives via the
  existing SSE board feed (no bespoke response rendering needed). On
  failure, surface the degraded/toast path, never a silent no-op.

### 2. Codex dispatch / approve (`POST /monitor/codex-tasks`)
- **Where:** the `codex-needed` lane card + its drawer (`TaskBody`
  already shows the prompt and runner heartbeat). Add primary
  "Dispatch to Codex" / "Approve" and secondary "Edit prompt" / "Cancel".
- **Payload:** the task id / prompt the handler expects (confirm shape).
- **Truth-boundary (hard):** dispatch is a real mutation. Require an
  explicit operator confirm step before POST. Do **not** auto-dispatch on
  card click. The button must reflect the real task lifecycle
  (proposed → approved → running → done/failed) from the board feed.

### 3. Command box (`POST /monitor/command`)
- Decide whether the redesign keeps the chat composer as the only input
  (it posts to `/monitor/collaboration`) or restores a distinct command
  affordance. If the legacy `/command` did something the chat can't
  (e.g. structured operator directives), spec that and add it; otherwise
  document that chat supersedes it and retire `/command` from parity.

## Guardrails (truth-boundary)

- The redesigned board's CTAs are currently **non-functional by design**
  (the Hermes persona forbids implying you can merge/approve/dispatch
  without a real action). Wiring them is exactly what removes that
  limitation — but each mutating action (merge, dispatch, recheck-that-
  writes) must go through a visible confirm and the existing mutation
  policy. No silent mutations from a card click.
- Prefer driving result state from the **SSE board feed** rather than
  bespoke per-action response handling, so the board stays the single
  source of truth.

## Acceptance criteria

- [ ] From `/monitor`, an operator can re-check a PR and see the lane /
      checks update via the live feed.
- [ ] From `/monitor`, an operator can approve/dispatch a `codex-needed`
      task (with a confirm step) and watch it move proposed → running →
      done.
- [ ] `/command` parity decided and either wired or documented as
      superseded by chat.
- [ ] No action mutates without an explicit operator confirm.
- [ ] Once parity holds and `/monitor/legacy` has gone a release unused,
      delete `renderMonitorHtml` (separate follow-up).

## Out of scope here

- Backend producer fixes (e.g. the stale "Deploying" cards that never
  age out — `packages/averray-mcp/handoff-events.ts` never emits the
  terminal event). Tracked separately.
