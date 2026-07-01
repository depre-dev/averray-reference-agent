# Spike — co-pilot on the Hermes gateway Session API

- **Status:** Spike. Built + unit-tested; **flag-gated OFF**; **not yet verified against a live gateway** (see the checklist). No behavior change until enabled.
- **Date:** 2026-07-01
- **Companion:** [`HERMES_UPGRADE_v017.md`](./HERMES_UPGRADE_v017.md) §2.2 (this is that item, spiked).
- **Why:** make Hermes a more *agentic* right-hand. Today the co-pilot's "Ask Hermes" is a **stateless** OpenAI-compat call straight to Ollama (`requestHermesCompletion`) carrying only the *persona* — no MCP tools, no skills, no memory, no continuity. This spike lets the co-pilot talk to the **real Hermes agent** over the gateway Session API, so replies can actually use board tools, remember prior turns, and act like the orchestrator brain rather than a persona-prompted completion.

---

## What shipped (dormant)

| File | Change |
|---|---|
| `services/slack-operator/src/hermes-session-client.ts` | **New.** Degraded-safe client for `/api/sessions/*` — create / turn / chat (create-if-needed + self-heal) / fork, tolerant extractors, injectable fetch. Zero external imports → fully isolated tests. |
| `services/slack-operator/src/monitor-hermes-voice.ts` | `resolveHermesSessionConfig(env)` (fail-closed env gate) + `generateHermesReplyViaSession(context, cfg, sessionId?)` (sends `buildUserPrompt` as the turn input; **no persona injected** — the session *is* Hermes). |
| `services/slack-operator/src/index.ts` | In `scheduleHermesAutoReply`: **session transport preferred when configured, else the existing Ollama path, else the canned template.** One module-level session id keeps the co-pilot thread continuous. |
| `ops/compose.yml` | `HERMES_SESSION_API_ENABLED` / `HERMES_API_URL` / `HERMES_API_TOKEN` / `HERMES_SESSION_TIMEOUT_MS` passthrough to `slack-operator`, **default off**. |
| `test/unit/hermes-session-{client,voice}.test.ts` | 23 tests: wire shapes, auth header, degraded paths, self-heal-on-stale-id, env gating, extractor drift tolerance. |

**Default behavior is byte-identical:** `resolveHermesSessionConfig` returns `null` unless the flag + URL + token are all set, so the new branch never runs until you opt in.

---

## Wire format (confirmed from `gateway/platforms/api_server.py` @ v0.17)

Auth: `Authorization: Bearer {API_SERVER_KEY}` on every call.

| Method | Path | Body | Response (fields we read) |
|---|---|---|---|
| POST | `/api/sessions` | `{}` | `{ session: { id } }` |
| POST | `/api/sessions/{id}/chat` | `{ "input": "…" }` | `{ session_id, message: { role, content }, usage }` — reply at **`message.content`** |
| POST | `/api/sessions/{id}/chat/stream` | `{ "input": "…" }` | SSE: `assistant.delta {message_id, delta}` … `run.completed {session_id, messages, usage}` |
| POST | `/api/sessions/{id}/fork` | `{ "title"? }` | `{ session: { id } }` |
| GET | `/api/sessions/{id}/messages` | — | message history |

The client uses the **synchronous `/chat`** turn: simplest, robust, and it carries the full agentic result. Extractors tolerate minor field drift (fall back to `content` / last assistant message) so a rename degrades to `null` (→ Ollama fallback) instead of throwing.

---

## How to enable (only with the command-center gateway up)

The gateway already exists in `ops/compose.command-center.yml` (`hermes-gateway`, `API_SERVER_ENABLED=true`, `API_SERVER_KEY=${HERMES_GATEWAY_API_KEY}`, `:8642`). In `.env.prod`:

```
HERMES_SESSION_API_ENABLED=1
HERMES_API_URL=http://hermes-gateway:8642
HERMES_API_TOKEN=${HERMES_GATEWAY_API_KEY}
# HERMES_SESSION_TIMEOUT_MS=45000   # agent turns are slower than a bare completion
```

Bring up slack-operator **and** the command-center profile together. Flip it off by unsetting the flag — the co-pilot reverts to the Ollama transport with zero risk.

---

## ⚠ Verify against a running gateway BEFORE trusting it

This spike is unit-tested against the **documented** shapes, but the pinned image is **v0.14** and the Session API is **v0.15+**. Do **not** enable in prod until, on a **v0.17** gateway:

1. **Create + turn round-trips.** From inside the network:
   ```sh
   ID=$(curl -s -XPOST http://hermes-gateway:8642/api/sessions -H "Authorization: Bearer $KEY" -d '{}' | jq -r .session.id)
   curl -s -XPOST http://hermes-gateway:8642/api/sessions/$ID/chat -H "Authorization: Bearer $KEY" -d '{"input":"what changed on the board?"}' | jq .message.content
   ```
   Confirm the reply text really lands at **`message.content`** (adjust the extractor if not).
2. **Agentic, not just a completion.** Ask something only the real agent can answer (needs an `averray_*` MCP tool or memory). Confirm it uses tools — otherwise the gateway session isn't wired to your MCP servers / profile.
3. **Continuity.** Two turns on the same id; confirm turn 2 remembers turn 1 (then we can stop resending the thread — see follow-ups).
4. **Latency + timeout.** Time a real turn; set `HERMES_SESSION_TIMEOUT_MS` above p95. The co-pilot reply is fire-and-forget, so a slow turn only delays Hermes's message.
5. **Fallback intact.** Point the URL at a dead port; confirm the co-pilot still replies (Ollama → canned) and `hermesMode` stays honest.

---

## Follow-ups (not in this spike)

- **Live SSE streaming** (`/chat/stream`) for token-by-token co-pilot replies — event shapes captured above; drop-in once the sync path is proven.
- **Stop resending the thread.** Once continuity (step 3) is confirmed, send only the new operator message per turn and let session memory carry context (cheaper, more natural).
- **Fork** for "explore this alternative" branches from the rail.
- **Reuse the session transport for the orchestration routines** (PR handoff / operator report) currently shelled over SSH `hermes chat -q` — the higher-value half of the "SSH → Session API" move.
