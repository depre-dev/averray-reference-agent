import { describe, expect, it } from "vitest";

import {
  HERMES_PERSONA,
  appendHermesWhyTrace,
  buildBoardNarrationPrompt,
  buildUserPrompt,
  generateHermesBoardNarration,
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
    expect(HERMES_PERSONA).toMatch(/board orchestrator/i);
    expect(HERMES_PERSONA).toMatch(/short sentences/i);
    expect(HERMES_PERSONA).toMatch(/never claim/i);
    expect(HERMES_PERSONA).toMatch(/memory notes/i);
    expect(HERMES_PERSONA).toMatch(/visible board controls/i);
    expect(HERMES_PERSONA).toMatch(/Why:/);
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

  it("includes memory notes as guidance, not proof", () => {
    const prompt = buildUserPrompt(baseContext({
      memoryNotes: [
        "Pascal preference: draft PRs owned by another agent should wait.",
      ],
    }));
    expect(prompt).toContain("Hermes memory");
    expect(prompt).toContain("draft PRs owned by another agent");
    expect(prompt).toContain("use as guidance, not proof");
    expect(prompt).toContain("Memory audit");
    expect(prompt).toContain("Why:");
  });

  it("includes live board context as higher-priority evidence", () => {
    const prompt = buildUserPrompt(baseContext({
      board: {
        generatedAt: "2026-05-20T08:54:42.000Z",
        status: "attention",
        headline: "Board now: 1 draft parked; 1 operator decision.",
        counts: { waiting: 1, operator: 1, codex: 0 },
        runner: "status=idle | Codex runner is online.",
        items: [
          {
            repo: "averray-agent/agent",
            number: 439,
            title: "PR is still marked as draft.",
            lane: "Waiting / Drafts",
            owner: "PR author",
            verdict: "draft",
            why: "GitHub reports this PR is still a draft.",
            next: "wait for the PR author unless Pascal delegates takeover",
            tags: ["backend", "secrets"],
          },
        ],
      },
    }));
    expect(prompt).toContain("Live board snapshot");
    expect(prompt).toContain("highest-priority evidence");
    expect(prompt).toContain("Board now: 1 draft parked");
    expect(prompt).toContain("waiting=1");
    expect(prompt).toContain("Waiting / Drafts / owner PR author");
    expect(prompt).toContain("trust the board");
  });

  it("tells the model to reply as Hermes in 1-4 sentences", () => {
    const prompt = buildUserPrompt(baseContext());
    expect(prompt).toMatch(/1-4 conversational sentences/);
    expect(prompt).toMatch(/route the next turn/);
  });
});

describe("buildBoardNarrationPrompt", () => {
  it("asks Hermes to proactively narrate board changes without claiming hidden actions", () => {
    const prompt = buildBoardNarrationPrompt({
      board: {
        headline: "Board now: 1 blocked item.",
        counts: { attention: 1 },
        items: [
          {
            repo: "averray-agent/agent",
            number: 438,
            title: "1 PR check failed",
            lane: "Needs Attention",
            owner: "Codex",
            verdict: "blocked",
            why: "1 PR check failed.",
            next: "inspect the failed runner output",
          },
        ],
      },
      recentMessages: [{ author: "operator", text: "keep it conversational", ts: NOW - 5_000 }],
      memoryNotes: ["Pascal prefers live, caring Hermes updates."],
      trigger: "attention=1",
    });
    expect(prompt).toContain("The monitor board changed");
    expect(prompt).toContain("Needs Attention / owner Codex");
    expect(prompt).toContain("Pascal prefers live");
    expect(prompt).toContain("Do not claim you clicked buttons");
    expect(prompt).toContain("Memory audit");
    expect(prompt).toContain("Why:");
  });
});

describe("appendHermesWhyTrace", () => {
  it("adds a compact board-plus-memory trace when memory is present", () => {
    const text = appendHermesWhyTrace("I will keep this parked until Pascal delegates it.", {
      selectedPr: { repo: "averray-agent/agent", number: 439 },
      board: {
        items: [
          {
            repo: "averray-agent/agent",
            number: 439,
            title: "PR is still marked as draft.",
            lane: "Waiting / Drafts",
            owner: "PR author",
          },
        ],
      },
      memoryNotes: [
        "Pascal outcome for averray-agent/agent#439: delegated draft takeover to Codex; Codex may inspect only verifiable missing work.",
      ],
    });

    expect(text).toContain("\nWhy:");
    expect(text).toContain("board averray-agent/agent#439 in Waiting / Drafts");
    expect(text).toContain("memory delegated draft takeover");
  });

  it("does not add a trace without memory notes", () => {
    const text = appendHermesWhyTrace("I will keep watching.", {
      board: { headline: "Board now: idle." },
    });
    expect(text).toBe("I will keep watching.");
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

  it("adds a deterministic why trace when memory guides the reply", async () => {
    const fetchFn = async (_url: string, _init: RequestInit) =>
      jsonResponse({ choices: [{ message: { content: "I will keep this in Waiting / Drafts unless Pascal delegates takeover." } }] });
    const text = await generateHermesReply(baseContext({
      selectedPr: { repo: "averray-agent/agent", number: 439 },
      board: {
        items: [
          {
            repo: "averray-agent/agent",
            number: 439,
            title: "PR is still marked as draft.",
            lane: "Waiting / Drafts",
            owner: "PR author",
          },
        ],
      },
      memoryNotes: [
        "Pascal note for averray-agent/agent#439: external-agent drafts should wait unless Pascal explicitly delegates takeover.",
      ],
    }), { apiKey, baseUrl, fetchFn: fetchFn as typeof fetch });

    expect(text).toContain("\nWhy:");
    expect(text).toContain("board averray-agent/agent#439 in Waiting / Drafts");
    expect(text).toContain("memory external-agent drafts should wait");
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

describe("generateHermesBoardNarration", () => {
  const apiKey = "test-key";
  const baseUrl = "https://ollama.example.com/v1";

  it("sends a proactive narration prompt to the configured model", async () => {
    let capturedBody: unknown;
    const fetchFn = async (_url: string, init: RequestInit) => {
      capturedBody = JSON.parse(init.body as string);
      return jsonResponse({ choices: [{ message: { content: "Codex, averray-agent/agent#438 needs you on the failed check; I will wait for the runner output before moving it." } }] });
    };
    const text = await generateHermesBoardNarration(
      {
        board: {
          headline: "Board now: 1 blocked item.",
          counts: { attention: 1 },
          items: [
            {
              repo: "averray-agent/agent",
              number: 438,
              title: "1 PR check failed",
              lane: "Needs Attention",
              owner: "Codex",
            },
          ],
        },
        recentMessages: [],
      },
      { apiKey, baseUrl, model: "deepseek-v4-pro:cloud", fetchFn: fetchFn as typeof fetch }
    );
    const body = capturedBody as { max_tokens: number; messages: Array<{ role: string; content: string }> };
    expect(text).toMatch(/averray-agent\/agent#438/);
    expect(body.max_tokens).toBe(180);
    expect(body.messages[1].content).toContain("Speak proactively as Hermes");
  });

  it("adds a why trace when board narration receives relevant memory", async () => {
    const fetchFn = async (_url: string, _init: RequestInit) =>
      jsonResponse({ choices: [{ message: { content: "Pascal, this draft stays parked unless you explicitly delegate Codex takeover." } }] });
    const text = await generateHermesBoardNarration(
      {
        board: {
          headline: "Board now: 1 draft parked.",
          counts: { waiting: 1 },
          items: [
            {
              repo: "averray-agent/agent",
              number: 439,
              title: "PR is still marked as draft.",
              lane: "Waiting / Drafts",
              owner: "PR author",
            },
          ],
        },
        recentMessages: [],
        memoryNotes: [
          "Pascal preference: drafts owned by another agent should wait unless Pascal delegates takeover.",
        ],
        trigger: "waiting=1",
      },
      { apiKey, baseUrl, fetchFn: fetchFn as typeof fetch }
    );

    expect(text).toContain("\nWhy:");
    expect(text).toContain("board averray-agent/agent#439 in Waiting / Drafts");
    expect(text).toContain("memory drafts owned by another agent");
  });
});
