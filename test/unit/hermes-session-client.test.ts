import { describe, expect, it } from "vitest";

import {
  chatWithHermesSession,
  chatWithHermesSessionStream,
  createHermesSession,
  extractSessionId,
  extractTurnText,
  forkHermesSession,
  parseSseFrames,
  runHermesSessionTurn,
  streamHermesSessionTurn,
  type HermesSessionConfig,
} from "../../services/slack-operator/src/hermes-session-client.js";

function jsonResponse(body: unknown, init?: { ok?: boolean; status?: number; throwJson?: boolean }): Response {
  return {
    ok: init?.ok ?? true,
    status: init?.status ?? 200,
    json: async () => {
      if (init?.throwJson) throw new Error("bad json");
      return body;
    },
  } as unknown as Response;
}

interface MockCall {
  url: string;
  method?: string;
  body?: unknown;
  auth?: unknown;
}

function mockFetch(responses: Array<Response | Error>): { fetchFn: typeof fetch; calls: MockCall[] } {
  const calls: MockCall[] = [];
  let i = 0;
  const fetchFn = (async (url: unknown, init: RequestInit | undefined) => {
    calls.push({
      url: String(url),
      method: init?.method,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      auth: (init?.headers as Record<string, string> | undefined)?.authorization,
    });
    const r = responses[Math.min(i, responses.length - 1)];
    i += 1;
    if (r instanceof Error) throw r;
    return r as Response;
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

const cfg = (fetchFn: typeof fetch): HermesSessionConfig => ({
  baseUrl: "http://gw:8642/", // trailing slash exercises the strip
  apiToken: "tok",
  fetchFn,
});

describe("createHermesSession", () => {
  it("posts {} to /api/sessions with bearer auth and returns session.id", async () => {
    const { fetchFn, calls } = mockFetch([jsonResponse({ object: "hermes.session", session: { id: "s1" } })]);
    const id = await createHermesSession(cfg(fetchFn));
    expect(id).toBe("s1");
    expect(calls[0]!.url).toBe("http://gw:8642/api/sessions");
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.body).toEqual({});
    expect(calls[0]!.auth).toBe("Bearer tok");
  });

  it("returns null on a non-2xx response", async () => {
    const { fetchFn } = mockFetch([jsonResponse({}, { ok: false, status: 500 })]);
    expect(await createHermesSession(cfg(fetchFn))).toBeNull();
  });

  it("returns null when the body is not valid JSON", async () => {
    const { fetchFn } = mockFetch([jsonResponse(null, { throwJson: true })]);
    expect(await createHermesSession(cfg(fetchFn))).toBeNull();
  });

  it("returns null and never calls fetch without a token", async () => {
    const { fetchFn, calls } = mockFetch([jsonResponse({ session: { id: "s1" } })]);
    expect(await createHermesSession({ baseUrl: "http://gw:8642", apiToken: "", fetchFn })).toBeNull();
    expect(calls).toHaveLength(0);
  });
});

describe("runHermesSessionTurn", () => {
  it("posts { input } to /api/sessions/{id}/chat and returns message.content", async () => {
    const { fetchFn, calls } = mockFetch([
      jsonResponse({ session_id: "s1", message: { role: "assistant", content: " hello " }, usage: {} }),
    ]);
    const turn = await runHermesSessionTurn(cfg(fetchFn), "s1", "hi");
    expect(turn).toMatchObject({ sessionId: "s1", text: "hello" });
    expect(calls[0]!.url).toBe("http://gw:8642/api/sessions/s1/chat");
    expect(calls[0]!.body).toEqual({ input: "hi" });
  });

  it("returns null on empty input without calling fetch", async () => {
    const { fetchFn, calls } = mockFetch([jsonResponse({ message: { content: "x" } })]);
    expect(await runHermesSessionTurn(cfg(fetchFn), "s1", "   ")).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("returns null on a non-2xx turn", async () => {
    const { fetchFn } = mockFetch([jsonResponse({}, { ok: false, status: 404 })]);
    expect(await runHermesSessionTurn(cfg(fetchFn), "s1", "hi")).toBeNull();
  });

  it("falls back to root.content, then to the last assistant message", async () => {
    const c1 = mockFetch([jsonResponse({ content: "root-level" })]);
    expect((await runHermesSessionTurn(cfg(c1.fetchFn), "s", "q"))?.text).toBe("root-level");

    const c2 = mockFetch([
      jsonResponse({ messages: [{ role: "user", content: "q" }, { role: "assistant", content: "final" }] }),
    ]);
    expect((await runHermesSessionTurn(cfg(c2.fetchFn), "s", "q"))?.text).toBe("final");
  });
});

describe("chatWithHermesSession", () => {
  it("creates a session then runs the turn when no id is supplied", async () => {
    const { fetchFn, calls } = mockFetch([
      jsonResponse({ session: { id: "s2" } }),
      jsonResponse({ message: { content: "reply" } }),
    ]);
    const turn = await chatWithHermesSession(cfg(fetchFn), "hi");
    expect(turn).toMatchObject({ sessionId: "s2", text: "reply" });
    expect(calls.map((c) => c.url)).toEqual([
      "http://gw:8642/api/sessions",
      "http://gw:8642/api/sessions/s2/chat",
    ]);
  });

  it("reuses a supplied session id with a single turn call", async () => {
    const { fetchFn, calls } = mockFetch([jsonResponse({ session_id: "s1", message: { content: "ok" } })]);
    const turn = await chatWithHermesSession(cfg(fetchFn), "hi", "s1");
    expect(turn).toMatchObject({ sessionId: "s1", text: "ok" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://gw:8642/api/sessions/s1/chat");
  });

  it("recreates the session once when the supplied id is stale, then retries", async () => {
    const { fetchFn, calls } = mockFetch([
      jsonResponse({}, { ok: false, status: 404 }), // stale id turn fails
      jsonResponse({ session: { id: "s3" } }), // recreate
      jsonResponse({ message: { content: "healed" } }), // retry turn
    ]);
    const turn = await chatWithHermesSession(cfg(fetchFn), "hi", "stale");
    expect(turn).toMatchObject({ sessionId: "s3", text: "healed" });
    expect(calls).toHaveLength(3);
  });

  it("returns null when creation fails after a stale id", async () => {
    const { fetchFn } = mockFetch([
      jsonResponse({}, { ok: false, status: 404 }),
      jsonResponse({}, { ok: false, status: 500 }),
    ]);
    expect(await chatWithHermesSession(cfg(fetchFn), "hi", "stale")).toBeNull();
  });

  it("returns null when a network error is thrown", async () => {
    const { fetchFn } = mockFetch([new Error("ECONNREFUSED")]);
    expect(await chatWithHermesSession(cfg(fetchFn), "hi")).toBeNull();
  });
});

describe("forkHermesSession", () => {
  it("posts { title } to /api/sessions/{id}/fork and returns the new id", async () => {
    const { fetchFn, calls } = mockFetch([jsonResponse({ session: { id: "f1" } })]);
    const id = await forkHermesSession(cfg(fetchFn), "s1", "alt path");
    expect(id).toBe("f1");
    expect(calls[0]!.url).toBe("http://gw:8642/api/sessions/s1/fork");
    expect(calls[0]!.body).toEqual({ title: "alt path" });
  });
});

describe("extractors tolerate shape drift", () => {
  it("extractSessionId reads session.id / id / session_id and null otherwise", () => {
    expect(extractSessionId({ session: { id: "a" } })).toBe("a");
    expect(extractSessionId({ id: "b" })).toBe("b");
    expect(extractSessionId({ session_id: "c" })).toBe("c");
    expect(extractSessionId({ nope: 1 })).toBeNull();
    expect(extractSessionId(null)).toBeNull();
    expect(extractSessionId("x")).toBeNull();
  });

  it("extractTurnText prefers message.content, then falls back, else null", () => {
    expect(extractTurnText({ message: { content: "primary" } })).toBe("primary");
    expect(extractTurnText({ output: "out" })).toBe("out");
    expect(extractTurnText({ messages: [{ role: "assistant", content: "last" }] })).toBe("last");
    expect(extractTurnText({ message: { content: "   " } })).toBeNull();
    expect(extractTurnText({})).toBeNull();
  });
});

// --- SSE streaming -----------------------------------------------------------

/** Encode named SSE frames into a wire string (the shape the gateway sends). */
function sseFrame(event: string, data: unknown): string {
  const payload = typeof data === "string" ? data : JSON.stringify(data);
  return `event: ${event}\ndata: ${payload}\n\n`;
}

/**
 * Build a mock streaming Response whose `body` is a ReadableStream that yields
 * `chunks` as UTF-8 bytes (each chunk may hold zero, one, or several — even
 * partial — SSE frames, so the reader's buffering is exercised).
 */
function streamResponse(chunks: string[], init?: { ok?: boolean; status?: number; noBody?: boolean }): Response {
  const encoder = new TextEncoder();
  const body = init?.noBody
    ? null
    : new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
          controller.close();
        },
      });
  return {
    ok: init?.ok ?? true,
    status: init?.status ?? 200,
    body,
  } as unknown as Response;
}

describe("parseSseFrames", () => {
  it("splits complete frames on blank lines and returns the trailing partial", () => {
    const { frames, rest } = parseSseFrames(
      "event: assistant.delta\ndata: {\"delta\":\"a\"}\n\nevent: assistant.delta\ndata: {\"delta\":\"b\"}\n\nevent: run.compl",
    );
    expect(frames).toEqual([
      { event: "assistant.delta", data: '{"delta":"a"}' },
      { event: "assistant.delta", data: '{"delta":"b"}' },
    ]);
    expect(rest).toBe("event: run.compl");
  });

  it("joins multi-line data, ignores comments/keepalives, and normalizes CRLF", () => {
    const { frames } = parseSseFrames("event: x\r\ndata: line1\r\ndata: line2\r\n\r\n");
    expect(frames).toEqual([{ event: "x", data: "line1\nline2" }]);
    // A comment-only frame (":" line) carries no data and is dropped.
    expect(parseSseFrames(": keepalive\n\n").frames).toEqual([]);
  });
});

describe("streamHermesSessionTurn", () => {
  it("calls onDelta per assistant.delta and returns the final turn from run.completed", async () => {
    const { fetchFn, calls } = mockFetch([
      streamResponse([
        sseFrame("assistant.delta", { message_id: "m1", delta: "Hello" }),
        sseFrame("assistant.delta", { message_id: "m1", delta: ", world" }),
        sseFrame("run.completed", {
          session_id: "s1",
          message: { role: "assistant", content: "Hello, world" },
          usage: { input_tokens: 3, output_tokens: 5 },
          model: "glm-5.2:cloud",
        }),
      ]),
    ]);
    const deltas: string[] = [];
    const turn = await streamHermesSessionTurn(cfg(fetchFn), "s1", "hi", (d) => deltas.push(d));

    expect(deltas).toEqual(["Hello", ", world"]);
    expect(turn).toMatchObject({
      sessionId: "s1",
      text: "Hello, world",
      usage: { input_tokens: 3, output_tokens: 5 },
      model: "glm-5.2:cloud",
    });
    // Posts to the streaming endpoint with bearer auth + { input }.
    expect(calls[0]!.url).toBe("http://gw:8642/api/sessions/s1/chat/stream");
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.body).toEqual({ input: "hi" });
    expect(calls[0]!.auth).toBe("Bearer tok");
  });

  it("reassembles frames split across chunk boundaries", async () => {
    const full =
      sseFrame("assistant.delta", { delta: "abc" }) +
      sseFrame("run.completed", { session_id: "s1", message: { content: "abc" } });
    // Slice the wire mid-frame so the reader must buffer across chunks.
    const cut = 12;
    const { fetchFn } = mockFetch([streamResponse([full.slice(0, cut), full.slice(cut)])]);
    const deltas: string[] = [];
    const turn = await streamHermesSessionTurn(cfg(fetchFn), "s1", "hi", (d) => deltas.push(d));
    expect(deltas).toEqual(["abc"]);
    expect(turn?.text).toBe("abc");
  });

  it("falls back to accumulated deltas when run.completed carries no message body", async () => {
    const { fetchFn } = mockFetch([
      streamResponse([
        sseFrame("assistant.delta", { delta: "par" }),
        sseFrame("assistant.delta", { delta: "tial" }),
        sseFrame("run.completed", { session_id: "s1", usage: {} }),
      ]),
    ]);
    const turn = await streamHermesSessionTurn(cfg(fetchFn), "s1", "hi", () => {});
    expect(turn?.text).toBe("partial");
  });

  it("returns null when the stream ends without a run.completed frame", async () => {
    const { fetchFn } = mockFetch([
      streamResponse([sseFrame("assistant.delta", { delta: "x" })]),
    ]);
    const deltas: string[] = [];
    const turn = await streamHermesSessionTurn(cfg(fetchFn), "s1", "hi", (d) => deltas.push(d));
    expect(deltas).toEqual(["x"]); // deltas still fired
    expect(turn).toBeNull(); // but no authoritative turn → caller falls back
  });

  it("returns null on a non-2xx response, a missing body, no token, and empty input", async () => {
    const nonOk = mockFetch([streamResponse([], { ok: false, status: 500 })]);
    expect(await streamHermesSessionTurn(cfg(nonOk.fetchFn), "s1", "hi", () => {})).toBeNull();

    const noBody = mockFetch([streamResponse([], { noBody: true })]);
    expect(await streamHermesSessionTurn(cfg(noBody.fetchFn), "s1", "hi", () => {})).toBeNull();

    const noToken = mockFetch([streamResponse([sseFrame("run.completed", { message: { content: "x" } })])]);
    expect(
      await streamHermesSessionTurn({ baseUrl: "http://gw:8642", apiToken: "", fetchFn: noToken.fetchFn }, "s1", "hi", () => {}),
    ).toBeNull();
    expect(noToken.calls).toHaveLength(0);

    const emptyInput = mockFetch([streamResponse([sseFrame("run.completed", { message: { content: "x" } })])]);
    expect(await streamHermesSessionTurn(cfg(emptyInput.fetchFn), "s1", "   ", () => {})).toBeNull();
    expect(emptyInput.calls).toHaveLength(0);
  });

  it("tolerates a malformed delta frame (ignores it) and a throwing onDelta", async () => {
    const { fetchFn } = mockFetch([
      streamResponse([
        "event: assistant.delta\ndata: {not json\n\n", // malformed → no delta
        sseFrame("assistant.delta", { delta: "ok" }),
        sseFrame("run.completed", { message: { content: "ok" } }),
      ]),
    ]);
    // A callback that throws must never break the turn.
    const turn = await streamHermesSessionTurn(cfg(fetchFn), "s1", "hi", () => {
      throw new Error("subscriber blew up");
    });
    expect(turn?.text).toBe("ok");
  });

  it("returns null when fetch itself throws", async () => {
    const { fetchFn } = mockFetch([new Error("ECONNRESET")]);
    expect(await streamHermesSessionTurn(cfg(fetchFn), "s1", "hi", () => {})).toBeNull();
  });
});

describe("chatWithHermesSessionStream", () => {
  it("creates a session then streams the turn when no id is supplied", async () => {
    const { fetchFn, calls } = mockFetch([
      jsonResponse({ session: { id: "s2" } }),
      streamResponse([sseFrame("run.completed", { session_id: "s2", message: { content: "reply" } })]),
    ]);
    const turn = await chatWithHermesSessionStream(cfg(fetchFn), "hi", () => {});
    expect(turn).toMatchObject({ sessionId: "s2", text: "reply" });
    expect(calls.map((c) => c.url)).toEqual([
      "http://gw:8642/api/sessions",
      "http://gw:8642/api/sessions/s2/chat/stream",
    ]);
  });

  it("recreates the session once when the supplied id is stale, then retries the stream", async () => {
    const { fetchFn, calls } = mockFetch([
      streamResponse([], { ok: false, status: 404 }), // stale id stream fails
      jsonResponse({ session: { id: "s3" } }), // recreate
      streamResponse([sseFrame("run.completed", { session_id: "s3", message: { content: "healed" } })]),
    ]);
    const turn = await chatWithHermesSessionStream(cfg(fetchFn), "hi", () => {}, "stale");
    expect(turn).toMatchObject({ sessionId: "s3", text: "healed" });
    expect(calls).toHaveLength(3);
  });
});
