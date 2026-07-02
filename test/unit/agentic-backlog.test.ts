import { describe, expect, it, vi } from "vitest";

import {
  buildAgenticBacklogPrompt,
  collectAgenticBacklog,
  normalizeItem,
  parseWorkItems,
  type AgenticBacklogConfig,
  type AgenticBacklogContext,
} from "../../services/slack-operator/src/agentic-backlog.js";

const CFG = (over: Partial<AgenticBacklogConfig> = {}): AgenticBacklogConfig => ({
  session: { baseUrl: "http://gw:8642", apiToken: "t" },
  allowedRepos: ["averray-agent/agent"],
  maxItems: 3,
  ...over,
});

const CTX: AgenticBacklogContext = {
  board: { headline: "1 failure", counts: { needsAttention: 1 }, items: [] },
  inFlight: [],
  memoryNotes: [],
};

function chatReturning(text: string) {
  return vi.fn(async () => ({ sessionId: "s1", text }));
}

const VALID_ITEM = {
  repo: "averray-agent/agent",
  surface: "settlement waiver",
  title: "fix waiver selectors",
  prompt: "Update the EscrowCore waiver selector to tolerate the pinned contract.",
  why: "CI failing on the deploy verification",
  boardSignal: "needs-attention: post-production-deploy verification failed",
  suggestedAgent: "codex",
};

describe("collectAgenticBacklog", () => {
  it("returns validated, mapped items from Hermes's JSON reply", async () => {
    const chat = chatReturning(JSON.stringify([VALID_ITEM]));
    const items = await collectAgenticBacklog(CFG(), CTX, { chat });
    expect(chat).toHaveBeenCalledOnce();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      repo: "averray-agent/agent",
      surface: "settlement waiver",
      prompt: VALID_ITEM.prompt,
      suggestedAgent: "codex",
    });
    expect(items[0]!.description).toContain("board:");
  });

  it("drops items for non-allowlisted repos", async () => {
    const chat = chatReturning(JSON.stringify([{ ...VALID_ITEM, repo: "someone/else" }]));
    expect(await collectAgenticBacklog(CFG(), CTX, { chat })).toHaveLength(0);
  });

  it("drops items with no cited board signal (hallucination guard)", async () => {
    const chat = chatReturning(JSON.stringify([{ ...VALID_ITEM, boardSignal: "" }]));
    expect(await collectAgenticBacklog(CFG(), CTX, { chat })).toHaveLength(0);
  });

  it("never calls the gateway when the allowlist is empty (fail-closed)", async () => {
    const chat = chatReturning(JSON.stringify([VALID_ITEM]));
    expect(await collectAgenticBacklog(CFG({ allowedRepos: [] }), CTX, { chat })).toHaveLength(0);
    expect(chat).not.toHaveBeenCalled();
  });

  it("returns [] on a gateway error or non-JSON reply", async () => {
    const throwing = vi.fn(async () => { throw new Error("gw down"); });
    expect(await collectAgenticBacklog(CFG(), CTX, { chat: throwing as never })).toHaveLength(0);
    const prose = chatReturning("Sorry, I couldn't parse the board.");
    expect(await collectAgenticBacklog(CFG(), CTX, { chat: prose })).toHaveLength(0);
  });

  it("caps at maxItems and dedupes repo::surface", async () => {
    const many = [VALID_ITEM, { ...VALID_ITEM, surface: "a" }, { ...VALID_ITEM, surface: "b" }, { ...VALID_ITEM, surface: "c" }];
    const chat = chatReturning(JSON.stringify(many));
    expect(await collectAgenticBacklog(CFG({ maxItems: 2 }), CTX, { chat })).toHaveLength(2);
    const dupes = [VALID_ITEM, { ...VALID_ITEM }];
    expect(await collectAgenticBacklog(CFG(), CTX, { chat: chatReturning(JSON.stringify(dupes)) })).toHaveLength(1);
  });
});

describe("parseWorkItems", () => {
  it("extracts a JSON array even with surrounding prose", () => {
    expect(parseWorkItems('here you go: [{"repo":"a"}] done')).toEqual([{ repo: "a" }]);
    expect(parseWorkItems("no json here")).toEqual([]);
    expect(parseWorkItems("[not valid json")).toEqual([]);
  });
});

describe("normalizeItem", () => {
  const allowed = new Set(["averray-agent/agent"]);
  it("keeps a valid item and parses suggestedAgent", () => {
    const item = normalizeItem(VALID_ITEM, allowed);
    expect(item?.repo).toBe("averray-agent/agent");
    expect(item?.suggestedAgent).toBe("codex");
  });
  it("rejects missing repo/surface/prompt/boardSignal, and bad suggestedAgent → undefined", () => {
    expect(normalizeItem({ ...VALID_ITEM, prompt: "" }, allowed)).toBeNull();
    expect(normalizeItem({ ...VALID_ITEM, repo: "x/y" }, allowed)).toBeNull();
    expect(normalizeItem({ ...VALID_ITEM, suggestedAgent: "gpt" }, allowed)?.suggestedAgent).toBeUndefined();
    expect(normalizeItem(null, allowed)).toBeNull();
  });
});

describe("buildAgenticBacklogPrompt", () => {
  it("names the allowed repos and demands a board signal + JSON-only output", () => {
    const prompt = buildAgenticBacklogPrompt(CFG(), CTX);
    expect(prompt).toContain("averray-agent/agent");
    expect(prompt).toContain("boardSignal");
    expect(prompt).toMatch(/JSON array/i);
  });
});

describe("buildAgenticBacklogPrompt — Stage 3 diff areas", () => {
  it("surfaces a card's REAL diff-areas so the model can't invent categories the PR doesn't touch", () => {
    const ctx: AgenticBacklogContext = {
      ...CTX,
      board: {
        headline: "1 review",
        items: [
          {
            repo: "averray-agent/agent",
            number: 717,
            title: "rewire outflow breaker",
            lane: "Operator Review",
            owner: "Operator",
            verdict: "needs review",
            why: "critical files gate",
            touchedAreas: ["contracts", "tests"],
          },
        ],
      },
    };
    const prompt = buildAgenticBacklogPrompt(CFG(), ctx);
    expect(prompt).toContain("diff-areas contracts, tests");
  });
});
