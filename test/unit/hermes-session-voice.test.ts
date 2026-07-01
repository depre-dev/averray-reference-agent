import { describe, expect, it } from "vitest";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  generateHermesReplyViaSession,
  generateHermesReplyViaSessionStream,
  resolveHermesSessionConfig,
  type HermesReplyContext,
} from "../../services/slack-operator/src/monitor-hermes-voice.js";

describe("resolveHermesSessionConfig", () => {
  const base = {
    HERMES_API_URL: "http://hermes-gateway:8642",
    HERMES_API_TOKEN: "gwkey",
  } as NodeJS.ProcessEnv;

  it("returns null when the flag is unset (default = Ollama transport)", () => {
    expect(resolveHermesSessionConfig({ ...base })).toBeNull();
  });

  it("returns null when enabled but URL or token is missing (fail-closed)", () => {
    expect(resolveHermesSessionConfig({ HERMES_SESSION_API_ENABLED: "1", HERMES_API_TOKEN: "gwkey" })).toBeNull();
    expect(resolveHermesSessionConfig({ HERMES_SESSION_API_ENABLED: "1", HERMES_API_URL: "http://gw" })).toBeNull();
  });

  it("resolves a config when enabled with URL + token", () => {
    const cfg = resolveHermesSessionConfig({ ...base, HERMES_SESSION_API_ENABLED: "1" });
    expect(cfg).toEqual({ baseUrl: "http://hermes-gateway:8642", apiToken: "gwkey" });
  });

  it("accepts truthy flag spellings and rejects falsey ones", () => {
    for (const on of ["1", "true", "YES", "On"]) {
      expect(resolveHermesSessionConfig({ ...base, HERMES_SESSION_API_ENABLED: on })).not.toBeNull();
    }
    for (const off of ["0", "false", "", "no"]) {
      expect(resolveHermesSessionConfig({ ...base, HERMES_SESSION_API_ENABLED: off })).toBeNull();
    }
  });

  it("carries a positive numeric timeout override", () => {
    const cfg = resolveHermesSessionConfig({ ...base, HERMES_SESSION_API_ENABLED: "1", HERMES_SESSION_TIMEOUT_MS: "30000" });
    expect(cfg?.timeoutMs).toBe(30000);
    const noTimeout = resolveHermesSessionConfig({ ...base, HERMES_SESSION_API_ENABLED: "1", HERMES_SESSION_TIMEOUT_MS: "oops" });
    expect(noTimeout && "timeoutMs" in noTimeout).toBe(false);
  });
});

describe("generateHermesReplyViaSession", () => {
  const context: HermesReplyContext = {
    operatorMessage: { text: "what's the state of the board?", addressedTo: "hermes", kind: "chat" },
    recentMessages: [],
  };

  function fetchReturning(body: unknown, ok = true): typeof fetch {
    return (async () => ({ ok, status: ok ? 200 : 500, json: async () => body })) as unknown as typeof fetch;
  }

  it("returns the session reply + id via the real-agent transport", async () => {
    const cfg = {
      baseUrl: "http://gw:8642",
      apiToken: "tok",
      fetchFn: fetchReturning({ session: { id: "s9" }, message: { content: "Operator review has 2 cards waiting on you." } }),
    };
    const turn = await generateHermesReplyViaSession(context, cfg);
    expect(turn?.sessionId).toBe("s9");
    expect(turn?.text).toContain("Operator review");
  });

  it("returns null when the gateway is unreachable (caller falls back to Ollama)", async () => {
    const cfg = { baseUrl: "http://gw:8642", apiToken: "tok", fetchFn: fetchReturning({}, false) };
    expect(await generateHermesReplyViaSession(context, cfg)).toBeNull();
  });
});

describe("generateHermesReplyViaSessionStream", () => {
  const context: HermesReplyContext = {
    operatorMessage: { text: "what's the state of the board?", addressedTo: "hermes", kind: "chat" },
    recentMessages: [],
  };

  function sseFrame(event: string, data: unknown): string {
    return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  }
  function streamBody(chunks: string[]): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    return new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of chunks) controller.enqueue(encoder.encode(c));
        controller.close();
      },
    });
  }
  /** Sequenced mock: JSON for /api/sessions, an SSE body for /chat/stream. */
  function sequencedFetch(streamChunks: string[]): typeof fetch {
    let i = 0;
    return (async (url: unknown) => {
      i += 1;
      if (String(url).endsWith("/chat/stream")) {
        return { ok: true, status: 200, body: streamBody(streamChunks) } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => ({ session: { id: "s9" } }) } as unknown as Response;
    }) as unknown as typeof fetch;
  }

  it("streams deltas to onDelta and returns the finalized turn (usage recorded like sync)", async () => {
    const cfg = {
      baseUrl: "http://gw:8642",
      apiToken: "tok",
      fetchFn: sequencedFetch([
        sseFrame("assistant.delta", { delta: "Operator review " }),
        sseFrame("assistant.delta", { delta: "has 2 cards." }),
        sseFrame("run.completed", {
          session_id: "s9",
          message: { content: "Operator review has 2 cards." },
          usage: { input_tokens: 10, output_tokens: 6 },
        }),
      ]),
    };
    const deltas: string[] = [];
    // Point usage recording at a temp JSONL so the shared recorder writes there
    // instead of the container's /data path (keeps test output clean + proves
    // the streaming path records usage exactly like the sync path).
    const usageLogPath = join(tmpdir(), `hermes-stream-usage-${Date.now()}.jsonl`);
    const turn = await generateHermesReplyViaSessionStream(context, cfg, (d) => deltas.push(d), undefined, {
      usageLogPath,
    });
    expect(deltas).toEqual(["Operator review ", "has 2 cards."]);
    expect(turn?.sessionId).toBe("s9");
    expect(turn?.text).toBe("Operator review has 2 cards.");
    // Usage was recorded (a non-empty JSONL line with the token counts).
    const recorded = readFileSync(usageLogPath, "utf8").trim();
    expect(recorded).toContain("output");
    rmSync(usageLogPath, { force: true });
  });

  it("returns null on a streaming failure so the caller falls back to the sync path", async () => {
    // Gateway reachable for session creation, but the stream 500s → null.
    const failingStream = (async (url: unknown) => {
      if (String(url).endsWith("/chat/stream")) {
        return { ok: false, status: 500, body: null } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => ({ session: { id: "s9" } }) } as unknown as Response;
    }) as unknown as typeof fetch;
    const cfg = { baseUrl: "http://gw:8642", apiToken: "tok", fetchFn: failingStream };
    const deltas: string[] = [];
    expect(await generateHermesReplyViaSessionStream(context, cfg, (d) => deltas.push(d))).toBeNull();
    expect(deltas).toEqual([]); // no tokens surfaced on failure
  });
});
