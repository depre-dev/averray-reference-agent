import { describe, expect, it } from "vitest";

import {
  HERMES_PERSONA,
  buildUserPrompt,
  generateHermesReply,
  type HermesReplyContext,
} from "../../services/slack-operator/src/monitor-hermes-voice.js";

const NOW = Date.UTC(2026, 4, 18, 12, 0, 0);

function baseContext(overrides: Partial<HermesReplyContext> = {}): HermesReplyContext {
  return {
    operatorMessage: {
      text: "what's the status on #137?",
      addressedTo: "hermes",
      kind: "chat",
      ...(overrides.operatorMessage?.relatedPr
        ? { relatedPr: overrides.operatorMessage.relatedPr }
        : {}),
    },
    recentMessages: [
      { author: "operator", text: "starting smoke", ts: NOW - 60_000 },
      { author: "hermes", text: "Watching.", ts: NOW - 50_000 },
    ],
    ...overrides,
  };
}

function jsonResponse(body: unknown, ok = true): Response {
  return new Response(JSON.stringify(body), {
    status: ok ? 200 : 500,
    headers: { "content-type": "application/json" },
  });
}

describe("HERMES_PERSONA", () => {
  it("constrains voice and reminds the model about truth boundary", () => {
    expect(HERMES_PERSONA).toMatch(/Hermes/);
    expect(HERMES_PERSONA).toMatch(/short sentences/i);
    expect(HERMES_PERSONA).toMatch(/never claim/i);
    expect(HERMES_PERSONA).toMatch(/Pascal/);
    expect(HERMES_PERSONA).toMatch(/Codex/);
  });
});

describe("buildUserPrompt", () => {
  it("includes selected PR fields when provided", () => {
    const prompt = buildUserPrompt(baseContext({
      selectedPr: {
        repo: "averray-agent/agent",
        number: 137,
        verdict: "pass",
        lane: "queue",
        ageLabel: "Fresh 4m",
      },
    }));
    expect(prompt).toContain("averray-agent/agent");
    expect(prompt).toContain("137");
    expect(prompt).toContain("pass");
    expect(prompt).toContain("queue");
  });

  it("falls back to operatorMessage.relatedPr when selectedPr is absent", () => {
    const prompt = buildUserPrompt(baseContext({
      operatorMessage: {
        text: "is this ready to merge?",
        addressedTo: "hermes",
        kind: "chat",
        relatedPr: { repo: "averray-agent/agent", number: 221 },
      },
    }));
    expect(prompt).toContain("averray-agent/agent");
    expect(prompt).toContain("221");
  });

  it("includes recent thread messages with their author labels", () => {
    const prompt = buildUserPrompt(baseContext());
    expect(prompt).toContain("operator: starting smoke");
    expect(prompt).toContain("hermes: Watching.");
  });

  it("tells the model to reply as Hermes in 1-3 sentences", () => {
    const prompt = buildUserPrompt(baseContext());
    expect(prompt).toMatch(/1-3 short sentences/);
  });
});

describe("generateHermesReply", () => {
  const apiKey = "test-key";
  const baseUrl = "https://ollama.example.com/v1";

  it("returns the model's reply text on success", async () => {
    const fetchFn = async (_url: string, _init: RequestInit) =>
      jsonResponse({ choices: [{ message: { content: "Got it. Watching averray-agent/agent#137 — verdict lands here when the checks clear." } }] });
    const text = await generateHermesReply(baseContext(), { apiKey, baseUrl, fetchFn: fetchFn as typeof fetch });
    expect(text).toMatch(/averray-agent\/agent#137/);
  });

  it("returns null when the API key is empty", async () => {
    const fetchFn = async () => jsonResponse({ choices: [{ message: { content: "anything" } }] });
    const text = await generateHermesReply(baseContext(), { apiKey: "", baseUrl, fetchFn: fetchFn as typeof fetch });
    expect(text).toBeNull();
  });

  it("returns null on non-2xx response", async () => {
    const fetchFn = async () => jsonResponse({ error: "rate_limited" }, false);
    const text = await generateHermesReply(baseContext(), { apiKey, baseUrl, fetchFn: fetchFn as typeof fetch });
    expect(text).toBeNull();
  });

  it("returns null on malformed response", async () => {
    const fetchFn = async () => jsonResponse({ choices: [] });
    const text = await generateHermesReply(baseContext(), { apiKey, baseUrl, fetchFn: fetchFn as typeof fetch });
    expect(text).toBeNull();
  });

  it("returns null when the model returns empty content", async () => {
    const fetchFn = async () => jsonResponse({ choices: [{ message: { content: "   " } }] });
    const text = await generateHermesReply(baseContext(), { apiKey, baseUrl, fetchFn: fetchFn as typeof fetch });
    expect(text).toBeNull();
  });

  it("returns null when the fetch throws", async () => {
    const fetchFn = async () => { throw new Error("network down"); };
    const text = await generateHermesReply(baseContext(), { apiKey, baseUrl, fetchFn: fetchFn as typeof fetch });
    expect(text).toBeNull();
  });

  it("returns null when the call times out", async () => {
    const fetchFn = (_url: string, init: RequestInit): Promise<Response> =>
      new Promise((_resolve, reject) => {
        // Reject when the signal aborts; never resolve otherwise.
        init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    const text = await generateHermesReply(baseContext(), {
      apiKey,
      baseUrl,
      fetchFn: fetchFn as typeof fetch,
      timeoutMs: 20,
    });
    expect(text).toBeNull();
  });

  it("sends the persona as the system message and uses the default model when unset", async () => {
    let captured: { url?: string; body?: unknown; headers?: Record<string, string> } = {};
    const fetchFn = async (url: string, init: RequestInit) => {
      captured.url = url;
      captured.headers = init.headers as Record<string, string>;
      captured.body = JSON.parse(init.body as string);
      return jsonResponse({ choices: [{ message: { content: "ok." } }] });
    };
    await generateHermesReply(baseContext(), { apiKey, baseUrl, fetchFn: fetchFn as typeof fetch });
    expect(captured.url).toBe("https://ollama.example.com/v1/chat/completions");
    expect(captured.headers?.authorization).toBe("Bearer test-key");
    const body = captured.body as { model: string; messages: Array<{ role: string; content: string }> };
    expect(body.model).toBe("deepseek-v4-pro:cloud");
    expect(body.messages[0].role).toBe("system");
    expect(body.messages[0].content).toMatch(/Hermes/);
    expect(body.messages[1].role).toBe("user");
  });

  it("honors a custom model override", async () => {
    let capturedModel = "";
    const fetchFn = async (_url: string, init: RequestInit) => {
      capturedModel = JSON.parse(init.body as string).model;
      return jsonResponse({ choices: [{ message: { content: "ok." } }] });
    };
    await generateHermesReply(baseContext(), {
      apiKey,
      baseUrl,
      model: "gpt-oss-120b",
      fetchFn: fetchFn as typeof fetch,
    });
    expect(capturedModel).toBe("gpt-oss-120b");
  });

  it("strips a trailing slash from baseUrl before appending the path", async () => {
    let capturedUrl = "";
    const fetchFn = async (url: string, _init: RequestInit) => {
      capturedUrl = url;
      return jsonResponse({ choices: [{ message: { content: "ok." } }] });
    };
    await generateHermesReply(baseContext(), {
      apiKey,
      baseUrl: "https://ollama.example.com/v1/",
      fetchFn: fetchFn as typeof fetch,
    });
    expect(capturedUrl).toBe("https://ollama.example.com/v1/chat/completions");
  });
});
