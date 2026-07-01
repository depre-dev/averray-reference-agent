import { describe, expect, it } from "vitest";

import {
  chatWithHermesSession,
  createHermesSession,
  extractSessionId,
  extractTurnText,
  forkHermesSession,
  runHermesSessionTurn,
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
    expect(turn).toEqual({ sessionId: "s1", text: "hello" });
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
    expect(turn).toEqual({ sessionId: "s2", text: "reply" });
    expect(calls.map((c) => c.url)).toEqual([
      "http://gw:8642/api/sessions",
      "http://gw:8642/api/sessions/s2/chat",
    ]);
  });

  it("reuses a supplied session id with a single turn call", async () => {
    const { fetchFn, calls } = mockFetch([jsonResponse({ session_id: "s1", message: { content: "ok" } })]);
    const turn = await chatWithHermesSession(cfg(fetchFn), "hi", "s1");
    expect(turn).toEqual({ sessionId: "s1", text: "ok" });
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
    expect(turn).toEqual({ sessionId: "s3", text: "healed" });
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
