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
 * `assistant.delta {message_id, delta}` … terminal `run.completed {session_id,
 * messages, usage}`) is implemented by `streamHermesSessionTurn` /
 * `chatWithHermesSessionStream` for live-token display in the co-pilot. It is
 * FLAG-GATED at the caller and DEGRADED-SAFE by the same contract as the sync
 * path: any failure (no token, non-2xx, timeout, parse error, no terminal
 * event) returns null so the caller falls back to the synchronous turn — the
 * co-pilot never breaks. The synchronous turn remains the default transport.
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

/**
 * POST to a streaming endpoint and return the raw response body as a byte
 * stream, or null on any failure (no token, missing url, non-2xx, no body,
 * thrown/aborted). Mirrors `postJson`'s degraded-safe contract but hands back
 * the SSE stream instead of a parsed JSON body. The caller owns reading +
 * timing out the stream; `abortSignal` lets it cancel the in-flight request.
 */
async function postStream(
  cfg: HermesSessionConfig,
  path: string,
  body: unknown,
  abortSignal: AbortSignal
): Promise<ReadableStream<Uint8Array> | null> {
  if (!cfg.apiToken || !cfg.baseUrl) return null;
  const url = `${cfg.baseUrl.replace(/\/+$/, "")}${path}`;
  const fetchImpl = cfg.fetchFn ?? fetch;
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "text/event-stream",
        authorization: `Bearer ${cfg.apiToken}`,
      },
      body: JSON.stringify(body ?? {}),
      signal: abortSignal,
    });
    if (!response.ok || !response.body) return null;
    return response.body as ReadableStream<Uint8Array>;
  } catch {
    return null;
  }
}

/**
 * Split a raw SSE text buffer into complete frames on blank lines, returning
 * the parsed frames and the trailing partial buffer (a frame that hasn't been
 * terminated by a blank line yet). Each frame is decoded into its `event` name
 * and concatenated `data` payload per the SSE grammar (multiple `data:` lines
 * join with "\n"; lines starting with ":" are comments/keepalives and ignored).
 * Exported for unit tests.
 */
export function parseSseFrames(buffer: string): { frames: SseFrame[]; rest: string } {
  // Normalize CRLF so the blank-line split is uniform, then peel complete
  // frames (terminated by a blank line) off the front, leaving any partial.
  const normalized = buffer.replace(/\r\n/g, "\n");
  const frames: SseFrame[] = [];
  let rest = normalized;
  let sep = rest.indexOf("\n\n");
  while (sep >= 0) {
    const raw = rest.slice(0, sep);
    rest = rest.slice(sep + 2);
    const frame = parseSseFrame(raw);
    if (frame) frames.push(frame);
    sep = rest.indexOf("\n\n");
  }
  return { frames, rest };
}

export interface SseFrame {
  event: string;
  data: string;
}

function parseSseFrame(raw: string): SseFrame | null {
  let event = "message";
  const dataLines: string[] = [];
  for (const line of raw.split("\n")) {
    if (!line || line.startsWith(":")) continue; // blank or comment/keepalive
    if (line.startsWith("event:")) {
      event = line.slice("event:".length).trim();
    } else if (line.startsWith("data:")) {
      // The SSE grammar strips exactly one leading space after the colon.
      dataLines.push(line.slice("data:".length).replace(/^ /, ""));
    }
  }
  if (dataLines.length === 0) return null;
  return { event, data: dataLines.join("\n") };
}

/**
 * Run one agent turn in an existing session over the SSE streaming endpoint.
 * Calls `onDelta(deltaText)` for each `assistant.delta` frame as tokens arrive,
 * accumulates the full text, and resolves the final `HermesSessionTurn` (full
 * text + usage + model via the existing extractors) when the terminal
 * `run.completed` frame lands. Returns null on ANY failure — no token, non-2xx,
 * timeout, malformed frame, a stream that ends without `run.completed`, or a
 * completed turn that yields no text — so the caller falls back to the sync
 * turn. `onDelta` is best-effort: a throwing callback never breaks the turn.
 */
export async function streamHermesSessionTurn(
  cfg: HermesSessionConfig,
  sessionId: string,
  input: string,
  onDelta: (deltaText: string) => void
): Promise<HermesSessionTurn | null> {
  if (!sessionId || !input.trim()) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const stream = await postStream(
      cfg,
      `/api/sessions/${encodeURIComponent(sessionId)}/chat/stream`,
      { input },
      controller.signal
    );
    if (!stream) return null;

    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let accumulated = "";
    let completion: unknown = null;

    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const { frames, rest } = parseSseFrames(buffer);
        buffer = rest;
        for (const frame of frames) {
          if (frame.event === "assistant.delta") {
            const delta = extractDeltaText(frame.data);
            if (delta) {
              accumulated += delta;
              emitDelta(onDelta, delta);
            }
          } else if (frame.event === "run.completed") {
            completion = safeParseJson(frame.data);
          }
        }
        if (completion) break; // terminal frame seen — stop reading
      }
    } finally {
      // Best-effort: release the reader / cancel the underlying stream.
      try {
        await reader.cancel();
      } catch {
        /* stream already closed */
      }
    }

    if (!completion) return null; // stream ended without a terminal frame

    // Prefer the authoritative full text from run.completed; fall back to the
    // deltas we accumulated if the terminal frame carries no message body.
    const finalText = extractTurnText(completion) ?? (accumulated.trim() || null);
    if (!finalText) return null;
    return {
      sessionId: extractTurnSessionId(completion) ?? sessionId,
      text: finalText,
      usage: extractTurnUsage(completion),
      model: extractTurnModel(completion),
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Streaming sibling of `chatWithHermesSession`: create a session if one isn't
 * supplied, and if a supplied session id has gone stale (the streamed turn
 * fails) create a fresh session and retry once. NOTE on deltas across a retry:
 * a stale first attempt usually emits nothing (it fails before any token) and
 * the retry then streams cleanly; but a first attempt that emitted partial
 * tokens before failing will fall through to the retry, so callers that render
 * deltas must treat the terminal turn's full text as authoritative and reset
 * their buffer to it. Returns the (possibly new) session id + reply, or null on
 * failure.
 */
export async function chatWithHermesSessionStream(
  cfg: HermesSessionConfig,
  input: string,
  onDelta: (deltaText: string) => void,
  existingSessionId?: string
): Promise<HermesSessionTurn | null> {
  if (!input.trim()) return null;
  if (existingSessionId) {
    const turn = await streamHermesSessionTurn(cfg, existingSessionId, input, onDelta);
    if (turn) return turn;
    // fall through: stale/invalid session id -> recreate once
  }
  const fresh = await createHermesSession(cfg);
  if (!fresh) return null;
  return streamHermesSessionTurn(cfg, fresh, input, onDelta);
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

/**
 * Pull the incremental text out of an `assistant.delta` frame's data. The
 * gateway sends `{message_id, delta}` where `delta` is the token text; we also
 * tolerate a bare string payload or a `{delta: {content}}` / `{text}` shape so a
 * minor wire drift degrades to "" (no delta) rather than throwing.
 */
function extractDeltaText(data: string): string {
  const json = safeParseJson(data);
  if (typeof json === "string") return json;
  const root = asRecord(json);
  if (!root) return "";
  if (typeof root.delta === "string") return root.delta;
  const nested = asRecord(root.delta);
  const fromNested = asText(nested?.content) ?? asText(nested?.text);
  if (fromNested) return fromNested;
  return asText(root.text) ?? asText(root.content) ?? "";
}

/** Invoke the delta callback without letting a throwing subscriber break the turn. */
function emitDelta(onDelta: (deltaText: string) => void, delta: string): void {
  try {
    onDelta(delta);
  } catch {
    /* subscriber threw — never break the stream over a bad callback */
  }
}

function safeParseJson(data: string): unknown {
  const trimmed = data.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
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
