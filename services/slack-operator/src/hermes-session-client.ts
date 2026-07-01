/**
 * Client for the Hermes gateway Session API (`API_SERVER_ENABLED`, gated by
 * `API_SERVER_KEY`, served on :8642 by the command-center `hermes-gateway`).
 *
 * Unlike `requestHermesCompletion` — a stateless OpenAI-compat call straight to
 * Ollama that only carries Hermes's *persona* — a session turn runs the real
 * Hermes *agent*: its MCP tools, skills, and memory, with context preserved
 * across turns. This is the transport that lets the co-pilot talk to the
 * agentic Hermes rather than a persona-prompted completion.
 *
 * Wire format (confirmed from gateway/platforms/api_server.py @ v0.17):
 *   POST /api/sessions            {}          -> { session: { id, ... } }
 *   POST /api/sessions/{id}/chat  { input }   -> { session_id, message: { role, content }, usage }
 *   POST /api/sessions/{id}/fork  { title? }  -> { session: { id, ... } }
 *   Auth: `Authorization: Bearer {API_SERVER_KEY}`
 *
 * Every call is DEGRADED-SAFE: it returns null on any failure (no token,
 * non-2xx, timeout, malformed body) so the caller can fall back to the Ollama
 * transport and then the canned template — the co-pilot never breaks.
 *
 * Live SSE streaming (`POST /api/sessions/{id}/chat/stream`; events
 * `assistant.delta {message_id, delta}` … `run.completed {session_id, messages,
 * usage}`) is a documented follow-up for live-token display. This client uses
 * the synchronous turn, which is simpler and carries the full agentic result.
 */

export interface HermesSessionConfig {
  /** Gateway base, e.g. `http://hermes-gateway:8642` (from `HERMES_API_URL`). */
  baseUrl: string;
  /** Bearer token = `API_SERVER_KEY` / `HERMES_API_TOKEN`. */
  apiToken: string;
  /**
   * Per-call hard timeout. An agent turn (MCP tools + skills) is far slower than
   * a bare completion, so this defaults high (45s). The co-pilot reply is
   * fire-and-forget, so a slow turn only delays Hermes's message, never blocks.
   */
  timeoutMs?: number;
  /** Injection point so tests don't hit the network. */
  fetchFn?: typeof fetch;
}

export interface HermesSessionTurn {
  sessionId: string;
  text: string;
  /** Raw `usage` block from the turn response ({input_tokens, output_tokens, …}).
   *  Passed to the monitor's usage recorder so agentic replies show on the panel. */
  usage?: Record<string, unknown> | null;
  /** Model the gateway ran the turn on, when the response reports it. */
  model?: string | null;
}

const DEFAULT_TIMEOUT_MS = 45_000;

async function postJson(cfg: HermesSessionConfig, path: string, body: unknown): Promise<unknown | null> {
  if (!cfg.apiToken || !cfg.baseUrl) return null;
  const url = `${cfg.baseUrl.replace(/\/+$/, "")}${path}`;
  const fetchImpl = cfg.fetchFn ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${cfg.apiToken}`,
      },
      body: JSON.stringify(body ?? {}),
      signal: controller.signal,
    });
    if (!response.ok) return null;
    return (await response.json().catch(() => null)) as unknown;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Create an empty Hermes session; returns its id or null on failure. */
export async function createHermesSession(
  cfg: HermesSessionConfig,
  init?: { title?: string }
): Promise<string | null> {
  const json = await postJson(cfg, "/api/sessions", init?.title ? { title: init.title } : {});
  return extractSessionId(json);
}

/** Run one synchronous agent turn in an existing session. */
export async function runHermesSessionTurn(
  cfg: HermesSessionConfig,
  sessionId: string,
  input: string
): Promise<HermesSessionTurn | null> {
  if (!sessionId || !input.trim()) return null;
  const json = await postJson(cfg, `/api/sessions/${encodeURIComponent(sessionId)}/chat`, { input });
  const text = extractTurnText(json);
  if (!text) return null;
  return {
    sessionId: extractTurnSessionId(json) ?? sessionId,
    text,
    usage: extractTurnUsage(json),
    model: extractTurnModel(json),
  };
}

/**
 * Send a message to Hermes, creating a session if one isn't supplied. If a
 * supplied session id has gone stale (the turn fails), transparently create a
 * fresh session and retry once, so the co-pilot self-heals across gateway
 * restarts. Returns the (possibly new) session id + reply, or null on failure.
 */
export async function chatWithHermesSession(
  cfg: HermesSessionConfig,
  input: string,
  existingSessionId?: string
): Promise<HermesSessionTurn | null> {
  if (!input.trim()) return null;
  if (existingSessionId) {
    const turn = await runHermesSessionTurn(cfg, existingSessionId, input);
    if (turn) return turn;
    // fall through: stale/invalid session id -> recreate once
  }
  const fresh = await createHermesSession(cfg);
  if (!fresh) return null;
  return runHermesSessionTurn(cfg, fresh, input);
}

/** Branch a session (CLI `/branch` semantics); returns the new session id. */
export async function forkHermesSession(
  cfg: HermesSessionConfig,
  sessionId: string,
  title?: string
): Promise<string | null> {
  if (!sessionId) return null;
  const json = await postJson(
    cfg,
    `/api/sessions/${encodeURIComponent(sessionId)}/fork`,
    title ? { title } : {}
  );
  return extractSessionId(json);
}

// --- tolerant extractors -----------------------------------------------------
// Response shapes are confirmed from api_server.py; the fallbacks tolerate minor
// shape drift across Hermes versions so a field rename degrades to null (caller
// falls back) rather than throwing.

/** `{ session: { id } }`, with fallbacks to `{ id }` / `{ session_id }`. */
export function extractSessionId(json: unknown): string | null {
  const root = asRecord(json);
  if (!root) return null;
  const session = asRecord(root.session);
  return asId(session?.id) ?? asId(root.id) ?? asId(root.session_id) ?? asId(root.sessionId);
}

/** `{ message: { content } }`, with fallbacks incl. the last assistant message. */
export function extractTurnText(json: unknown): string | null {
  const root = asRecord(json);
  if (!root) return null;
  const message = asRecord(root.message);
  const direct =
    asText(message?.content) ??
    asText(root.content) ??
    asText(root.output) ??
    asText(root.text) ??
    asText(root.reply);
  if (direct) return direct;
  const messages = Array.isArray(root.messages) ? root.messages : [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = asRecord(messages[i]);
    if (m && (m.role === undefined || m.role === "assistant")) {
      const t = asText(m.content);
      if (t) return t;
    }
  }
  return null;
}

function extractTurnSessionId(json: unknown): string | null {
  const root = asRecord(json);
  if (!root) return null;
  return asId(root.session_id) ?? asId(root.sessionId) ?? extractSessionId(json);
}

/** The raw `usage` object off a turn response, or null when absent. */
export function extractTurnUsage(json: unknown): Record<string, unknown> | null {
  return asRecord(asRecord(json)?.usage) ?? null;
}

/** The model the turn ran on, when the response reports it. */
export function extractTurnModel(json: unknown): string | null {
  const root = asRecord(json);
  if (!root) return null;
  return asId(root.model) ?? asId(asRecord(root.message)?.model) ?? asId(asRecord(root.usage)?.model);
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

function asId(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function asText(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}
