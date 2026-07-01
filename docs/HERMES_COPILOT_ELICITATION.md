# Co-pilot MCP Elicitation — Inline Tool-Call Approvals (feature #4)

- **Status:** **GROUNDWORK / DESIGN.** Not a live approval gate. No tool call is
  gated by this today. Ships behind `HERMES_COPILOT_ELICITATION` (default OFF),
  fail-closed, degraded-safe.
- **Date:** 2026-07-01
- **Depends on:** #3 (streaming co-pilot session, branch
  `claude/copilot-sse-streaming`) for the live stream this would read from, and
  on **new Hermes gateway support that does not exist yet** (see §3).

> ## Repo orientation
> This doc lives in the implementation repo (`depre-dev/averray-reference-agent`).
> Every `path:line` citation is local to this repo unless prefixed `[gateway]`,
> which marks the external `nousresearch/hermes-agent` image (`gateway run`,
> `api_server.py`) — code we do **not** own and can only reach over HTTP.

---

## 1. Goal

When the agentic Hermes co-pilot — reached over the gateway **Session API**
(`services/slack-operator/src/hermes-session-client.ts`) — hits a tool call that
needs human confirmation, surface an **inline approve/deny** in the co-pilot
rail (`packages/monitor-ui/src/components/hermes/CoPilotRail.tsx`) instead of
failing the turn or silently proceeding. This is a **security-sensitive approval
surface**: it decides whether a tool the agent proposes actually runs.

---

## 2. Why this is groundwork, not a live feature (truth boundary)

**The Hermes gateway does not expose MCP elicitation.** Confirmed from the
Session API client, which is the only programmatic channel we have to the agent:

- The Session API surface is **create / chat / fork** only —
  `hermes-session-client.ts:11-15`:
  - `POST /api/sessions` → `{ session: { id } }`
  - `POST /api/sessions/{id}/chat` `{ input }` → `{ message: { content }, usage }`
  - `POST /api/sessions/{id}/fork` → `{ session: { id } }`
- The **only** documented stream events are `assistant.delta` and
  `run.completed` — `hermes-session-client.ts:21-23`. **Neither is a
  tool-confirmation / elicitation request.**
- There is **no endpoint to answer a pending tool call** — nothing like
  `POST /api/sessions/{id}/elicitations/{eid}`.
- The gateway image today (`ops/compose.command-center.yml`, `${HERMES_IMAGE}`)
  is documented as **unverified for the Session API at all** — the pinned image
  is v0.14 and the Session API is v0.15+ (`docs/HERMES_SESSION_API_SPIKE.md`,
  "Verify against a running gateway BEFORE trusting it").

The current co-pilot is also **synchronous poll-based chat** with no tool
channel: `useCollaboration` polls `/monitor/collaboration`
(`packages/monitor-ui/src/hooks/useCollaboration.ts:1-7`) and messages are only
`chat | proposal | request_help | status`
(`services/slack-operator/src/monitor-collab.ts:40`).

**Consequence.** A UI that showed an "approve/deny this tool call" affordance
today would be **theater** — it could not receive a real elicitation request and
could not deliver a real answer to the agent. Per the truth-boundary rule, we do
**not** ship that. Instead we ship the types, the fail-closed gate, and a
dormant no-op handler, and we document the exact gateway support required so the
real slice is a small, well-scoped follow-up.

---

## 3. Exact gateway support required (does not exist yet)

The real feature becomes buildable when the gateway provides **both**:

1. **An elicitation request in the session stream.** On the SSE stream
   (`POST /api/sessions/{id}/chat/stream`), a new event emitted when the agent
   blocks on a tool that needs confirmation, e.g.:

   ```json
   { "type": "tool.confirmation",
     "id": "elc_abc",
     "session_id": "sess_1",
     "tool_name": "averray_submit",
     "summary": "Submit the proposal to the marketplace",
     "arguments": { "jobId": "j1" },
     "expires_at_ms": 1751500000000 }
   ```

   (Our parser already accepts this shape and an `elicitation.request` alias —
   `packages/averray-mcp/src/copilot-elicitation.ts`, `parseElicitationRequest`.)

2. **An answer endpoint** to resolve that request, e.g.:

   ```
   POST /api/sessions/{id}/elicitations/{elicitationId}
   { "decision": "approve" | "deny", "reason"?: "…" }
   ```

   returning a confirmation the agent received the answer. Approve **must**
   require a delivered, acknowledged response — the client treats an
   unacknowledged delivery as failure and denies (see §4).

Until **both** exist, `GATEWAY_ELICITATION_SUPPORTED` stays `false`
(`copilot-elicitation.ts`) and the handler falls closed.

---

## 4. Fail-closed semantics (the security contract)

A proposed tool call is allowed to proceed (**approve**) **only** when **all** of:

1. `HERMES_COPILOT_ELICITATION` is explicitly on (`1`/`true`), **and**
2. the gateway actually supports elicitation (§3), **and**
3. an operator **explicitly** clicked approve in the rail, **and**
4. that approval was **delivered and acknowledged** by the gateway.

**Every other path denies.** Encoded as a pure truth table in
`resolveElicitationOutcome` (`copilot-elicitation.ts`) and exhaustively tested
(`test/unit/copilot-elicitation.test.ts`):

| Condition | Outcome | `reason` |
| --- | --- | --- |
| Flag off (default) | **DENY** (ungated) | `feature-disabled` |
| Flag on, gateway unsupported (today) | **DENY** (ungated) | `no-gateway-support` |
| No/malformed elicitation frame | **DENY** (ungated) | `no-request` |
| Operator silent / window elapsed | **DENY** (ungated) | `no-operator-response` / `timeout` |
| Approve but undeliverable to gateway | **DENY** (ungated) | `delivery-unreachable` |
| Operator denies | **DENY** (gated) | `operator-denied` |
| Enabled + supported + approve + delivered | **APPROVE** (gated) | `operator-approved` |

Key invariants (asserted in tests):

- **Silence is DENY.** If the operator does not respond, or the rail/gateway is
  unreachable, the tool call is denied — never auto-approved.
- **No auto-approve path.** There is no input combination lacking an *explicit*
  operator approve that yields approve. A dedicated test sweeps the
  decision-less / deny / undelivered space and asserts every result is DENY.
- **Off ⇒ inert.** With the flag off the handler engages neither the operator
  nor the gateway (proven by call-count assertions).

---

## 5. Intended flow (once §3 lands)

```
Hermes agent (gateway session)
   │  emits tool.confirmation on the SSE stream
   ▼
slack-operator stream reader  ──parseElicitationRequest()──▶ ElicitationRequest
   │  records a co-pilot turn of a new kind ("elicitation")
   ▼
CoPilotRail  ──▶ renders an inline Approve / Deny affordance (scoped, expiring)
   │  operator clicks
   ▼
slack-operator route (POST answer)  ──deliverDecision()──▶ gateway answer endpoint
   │  gateway acknowledges
   ▼
resolveElicitationOutcome()  ──▶ approve (only here) or fail-closed deny
```

Concretely, the follow-up PR (blocked on §3 + a real gateway) adds:

1. **Stream reader**: in the streaming session client (#3), detect
   `tool.confirmation` frames via `parseElicitationRequest`.
2. **A new collaboration kind** `"elicitation"` in
   `services/slack-operator/src/monitor-collab.ts` so the pending request renders
   as a turn without pretending to be ordinary chat.
3. **An answer route** in `services/slack-operator/src/index.ts` (e.g.
   `POST /monitor/elicitations/:id`) that calls `deliverDecision` →
   the gateway answer endpoint, with the operator as `decidedBy` for audit.
4. **Rail affordance**: an approve/deny control in `CoPilotRail.tsx` /
   `HermesTurn.tsx`, wired through `handleElicitationRequest`'s `collectDecision`
   hook, with a visible expiry and a "denies on timeout" note.
5. **Gate the tool call** on `isToolCallApproved(outcome)`.

None of steps 1–5 ship in this PR.

---

## 6. What ships in this PR (groundwork)

| File | Change |
| --- | --- |
| `packages/averray-mcp/src/copilot-elicitation.ts` | **New.** Types (`ElicitationRequest` / `ElicitationDecision` / `ElicitationOutcome`), fail-closed env gate (`resolveCopilotElicitationConfig`), strict frame parser (`parseElicitationRequest`), the pure fail-closed truth table (`resolveElicitationOutcome`), and a degraded-safe no-op handler (`handleElicitationRequest`) that gates nothing and can never auto-approve. No `@avg/*` imports → isolated tests. |
| `test/unit/copilot-elicitation.test.ts` | **New.** 29 tests: default-OFF, the full fail-closed table, the never-auto-approve sweep, off ⇒ hooks-never-called, the future wired path staying fail-closed, and parser rejection of `assistant.delta` / `run.completed` / malformed frames. |
| `ops/compose.yml` | `HERMES_COPILOT_ELICITATION` (+ `_TIMEOUT_MS`) passthrough to `slack-operator`, default `0`. |
| `docs/HERMES_COPILOT_ELICITATION.md` | This doc. |

**Default behavior is byte-identical.** The module is not yet imported by any
runtime path; it is dormant until the gateway support above lands and the
follow-up wires it in. No UI claims to gate a tool call it cannot gate.
