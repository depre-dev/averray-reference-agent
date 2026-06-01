import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  HERMES_PERSONA,
  appendHermesWhyTrace,
  applyHermesMemoryInfluence,
  buildBoardNarrationPrompt,
  buildUserPrompt,
  generateHermesBoardNarration,
  generateHermesReply,
  hermesDecisionCoachForCard,
  hermesMemoryInfluence,
  hermesOwnerAskForCard,
  summarizeHermesUsageDebugShape,
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

  it("includes lane-specific decision coaching in the board prompt", () => {
    const prompt = buildBoardNarrationPrompt({
      board: {
        headline: "Board now: 1 operator decision.",
        counts: { operator: 1 },
        items: [
          {
            repo: "averray-reference-agent",
            number: 183,
            title: "2 changed files touch review-gated surfaces.",
            lane: "Operator Review",
            owner: "Operator",
            verdict: "needs review",
            why: "Hermes has already done the code-level pre-check.",
            next: "decide whether project intent and rollout risk are acceptable",
          },
        ],
      },
      recentMessages: [],
    });

    expect(prompt).toContain("For decision lanes, coach the decision");
    expect(prompt).toContain("Make the handoff conversational");
    expect(prompt).toContain("button opens the operator checklist");
    expect(prompt).toContain("approval is a local monitor sign-off, not a merge");
    expect(prompt).toContain("avoid do not re-review code line by line");
    expect(prompt).toContain("safest decide whether project intent");
    expect(prompt).toContain("ask target Pascal");
    expect(prompt).toContain("ask decide whether the intent");
    expect(prompt).toContain("waiting for operator approval");
  });
});

describe("hermesDecisionCoachForCard", () => {
  it("explains what key lane buttons do and do not do", () => {
    expect(hermesDecisionCoachForCard({
      repo: "averray-agent/agent",
      number: 438,
      title: "1 PR check failed.",
      lane: "Needs Attention",
      owner: "Codex",
    })?.button).toContain("failed-task evidence");
    expect(hermesDecisionCoachForCard({
      repo: "averray-agent/agent",
      number: 439,
      title: "PR is still marked as draft.",
      lane: "Waiting / Drafts",
      owner: "PR author",
    })?.avoid).toContain("unless Pascal explicitly delegates takeover");
    expect(hermesDecisionCoachForCard({
      repo: "averray-agent/agent",
      number: 440,
      title: "Ready to merge.",
      lane: "Release Queue",
      owner: "Merge steward",
    })?.button).toContain("does not merge");
  });
});

describe("hermesOwnerAskForCard", () => {
  it("turns board lanes into concrete owner handoffs", () => {
    expect(hermesOwnerAskForCard({
      repo: "averray-agent/agent",
      number: 438,
      title: "1 PR check failed.",
      lane: "Needs Attention",
      owner: "Codex",
    })).toMatchObject({
      target: "Codex",
      ask: expect.stringContaining("smallest verifiable fix"),
      waitingFor: expect.stringContaining("fresh pass"),
    });
    expect(hermesOwnerAskForCard({
      repo: "averray-agent/agent",
      number: 439,
      title: "PR is still marked as draft.",
      lane: "Waiting / Drafts",
      owner: "PR author",
    })).toMatchObject({
      target: "PR author or owning agent",
      ask: expect.stringContaining("mark it ready"),
      waitingFor: expect.stringContaining("explicit takeover decision"),
    });
    expect(hermesOwnerAskForCard({
      repo: "averray-agent/agent",
      number: 440,
      title: "Ready to merge.",
      lane: "Release Queue",
      owner: "Merge steward",
    })).toMatchObject({
      target: "merge steward",
      ask: expect.stringContaining("branch protection is green"),
      waitingFor: expect.stringContaining("merge/deploy event"),
    });
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

describe("applyHermesMemoryInfluence", () => {
  it("uses remembered draft rules when a draft is parked outside Codex", () => {
    const text = applyHermesMemoryInfluence("averray-agent/agent#439 is parked in Waiting / Drafts.", {
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
        "Pascal preference: external agent draft PRs should wait unless Pascal explicitly delegates takeover.",
      ],
    });

    expect(text).toContain("remembered draft rule");
    expect(text).toContain("unless Pascal explicitly delegates takeover");
  });

  it("calls out a conflict when the board asks Codex to own an external draft", () => {
    const context = {
      board: {
        items: [
          {
            repo: "averray-agent/agent",
            number: 439,
            title: "PR is still marked as draft.",
            lane: "Codex Needed",
            owner: "Codex",
          },
        ],
      },
      memoryNotes: [
        "Pascal preference: external agent draft PRs should wait unless Pascal explicitly delegates takeover.",
      ],
    };

    const influence = hermesMemoryInfluence(context);
    const text = applyHermesMemoryInfluence("Codex should inspect the draft next.", context);

    expect(influence?.conflict).toBe(true);
    expect(text).toContain("memory conflict");
    expect(text).toContain("trust the live board");
  });

  it("uses remembered operator-review boundaries for review-gated backend risk", () => {
    const text = applyHermesMemoryInfluence("Pascal, this one needs an operator decision.", {
      board: {
        items: [
          {
            repo: "averray-reference-agent",
            number: 183,
            title: "2 changed files touch review-gated surfaces.",
            lane: "Operator Review",
            owner: "Operator",
          },
        ],
      },
      memoryNotes: [
        "Pascal note: backend review-gated risk needs operator sign-off instead of another automatic handoff.",
      ],
    });

    expect(text).toContain("remembered review boundary");
    expect(text).toContain("operator decision");
  });

  it("uses remembered release queue boundaries before merge", () => {
    const text = applyHermesMemoryInfluence("averray-agent/agent#440 is in the Release Queue.", {
      board: {
        items: [
          {
            repo: "averray-agent/agent",
            number: 440,
            title: "Live GitHub PR metadata and checks look merge-ready.",
            lane: "Release Queue",
            owner: "Queue",
          },
        ],
      },
      memoryNotes: [
        "Pascal preference: release queue waits for merge steward ownership and branch protection green.",
      ],
    });

    expect(text).toContain("remembered release rule");
    expect(text).toContain("merge-steward ownership");
  });

  it("uses remembered testbed mission report evidence", () => {
    const text = applyHermesMemoryInfluence("Hermes has a testbed browser mission ready.", {
      board: {
        items: [
          {
            title: "Fresh-agent browser mission",
            lane: "Hermes Checking",
            owner: "Hermes",
          },
        ],
      },
      memoryNotes: [
        "Testbed mission report for https://testbed.example/app: verdict partial. Top blocker: unclear wallet boundary.",
      ],
    });

    expect(text).toContain("last testbed mission evidence");
    expect(text).toContain("browser-agent report");
  });

  it("does not duplicate a memory sentence that already exists", () => {
    const text = "This matches your remembered draft rule: keep external-agent drafts parked.";
    expect(applyHermesMemoryInfluence(text, {
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
        "Pascal preference: external agent draft PRs should wait unless Pascal explicitly delegates takeover.",
      ],
    })).toBe(text);
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
    expect(text).toContain("memory draft lane matches external-agent draft memory");
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

  it("uses DeepSeek reasoning text when content is empty and records OpenAI-style usage", async () => {
    const dir = await mkdtemp(join(tmpdir(), "averray-hermes-reasoning-usage-"));
    try {
      const usageLogPath = join(dir, "llm-usage.jsonl");
      const fetchFn = async () =>
        jsonResponse({
          model: "deepseek-v4-pro:cloud",
          choices: [
            {
              message: {
                role: "assistant",
                content: "",
                reasoning: "Pascal, this is live Hermes. The board has one operator triage item and I am not dispatching code work.",
              },
            },
          ],
          usage: {
            prompt_tokens: 93,
            completion_tokens: 21,
          },
        });

      const text = await generateHermesReply(baseContext(), {
        apiKey,
        baseUrl,
        model: "deepseek-v4-pro:cloud",
        runId: "deepseek-reasoning-1",
        taskId: "chat-message-2",
        usageLogPath,
        fetchFn: fetchFn as typeof fetch,
      });

      expect(text).toContain("this is live Hermes");
      expect(text).not.toContain("content");
      await expect(readFile(usageLogPath, "utf8").then((line) => JSON.parse(line))).resolves.toMatchObject({
        agent: "hermes",
        model: "deepseek-v4-pro:cloud",
        runId: "deepseek-reasoning-1",
        taskId: "chat-message-2",
        inputTokens: 93,
        outputTokens: 21,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("uses reasoning_content when content and reasoning are empty", async () => {
    const fetchFn = async () =>
      jsonResponse({
        choices: [{
          message: {
            content: "",
            reasoning: "   ",
            reasoning_content: "I have the live reply now.",
          },
        }],
      });
    const text = await generateHermesReply(baseContext(), { apiKey, baseUrl, fetchFn: fetchFn as typeof fetch });
    expect(text).toContain("live reply");
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

  it("records Ollama token counters from Hermes chat responses", async () => {
    const dir = await mkdtemp(join(tmpdir(), "averray-hermes-usage-"));
    try {
      const usageLogPath = join(dir, "llm-usage.jsonl");
      const fetchFn = async () =>
        jsonResponse({
          model: "deepseek-v4-pro:cloud",
          choices: [{ message: { content: "Watching it." } }],
          prompt_eval_count: 44,
          eval_count: 12,
        });

      const text = await generateHermesReply(baseContext(), {
        apiKey,
        baseUrl,
        model: "deepseek-v4-pro:cloud",
        runId: "chat-correlation-1",
        taskId: "chat-message-1",
        usageLogPath,
        fetchFn: fetchFn as typeof fetch,
      });

      expect(text).toContain("Watching it.");
      await expect(readFile(usageLogPath, "utf8").then((line) => JSON.parse(line))).resolves.toMatchObject({
        agent: "hermes",
        model: "deepseek-v4-pro:cloud",
        runId: "chat-correlation-1",
        taskId: "chat-message-1",
        inputTokens: 44,
        outputTokens: 12,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("summarizes usage debug shape without logging message content", () => {
    const summary = summarizeHermesUsageDebugShape({
      id: "chatcmpl-1",
      model: "deepseek-v4-pro:cloud",
      choices: [
        {
          message: {
            role: "assistant",
            content: "operator message content must stay redacted",
            usage: {
              prompt_eval_count: 44,
              eval_count: 12,
            },
          },
        },
      ],
    });

    expect(summary).toMatchObject({
      topLevelKeys: ["choices", "id", "model"],
      usageType: "undefined",
      present: {
        "choices[0].message.usage": {
          prompt_eval_count: 44,
          eval_count: 12,
        },
      },
    });
    expect(JSON.stringify(summary)).not.toContain("operator message content");
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

  it("uses DeepSeek reasoning text for proactive narration when content is empty", async () => {
    const dir = await mkdtemp(join(tmpdir(), "averray-hermes-narration-usage-"));
    try {
      const usageLogPath = join(dir, "llm-usage.jsonl");
      const fetchFn = async () =>
        jsonResponse({
          choices: [{
            message: {
              content: "",
              reasoning: "Pascal, Hermes is live on narration too; one release card needs a merge steward.",
            },
          }],
          usage: {
            prompt_tokens: 55,
            completion_tokens: 13,
          },
        });
      const text = await generateHermesBoardNarration(
        {
          board: {
            headline: "Board now: 1 release item.",
            counts: { release: 1 },
            items: [
              {
                repo: "averray-agent/agent",
                number: 440,
                title: "Ready to merge.",
                lane: "Release Queue",
                owner: "Merge steward",
              },
            ],
          },
          recentMessages: [],
        },
        { apiKey, baseUrl, usageLogPath, fetchFn: fetchFn as typeof fetch }
      );

      expect(text).toContain("Hermes is live on narration");
      await expect(readFile(usageLogPath, "utf8").then((line) => JSON.parse(line))).resolves.toMatchObject({
        agent: "hermes",
        model: "deepseek-v4-pro:cloud",
        inputTokens: 55,
        outputTokens: 13,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
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
    expect(text).toContain("memory draft lane matches external-agent draft memory");
  });
});
