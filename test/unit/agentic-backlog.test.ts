import { describe, expect, it, vi } from "vitest";

import {
  boardGroundingText,
  buildAgenticBacklogPrompt,
  collectAgenticBacklog,
  createAgenticBacklogPlanner,
  agenticBacklogContextSignature,
  normalizeItem,
  parseWorkItems,
  resolveAgenticBacklogMode,
  ungroundedHighRiskClaim,
  type AgenticBacklogConfig,
  type AgenticBacklogContext,
  type AgenticBacklogItem,
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

  it("prefers the compact completion transport over the full gateway session", async () => {
    const chat = chatReturning("should not run");
    const complete = chatReturning(JSON.stringify([VALID_ITEM]));
    const items = await collectAgenticBacklog(CFG(), CTX, { chat, complete });
    expect(complete).toHaveBeenCalledOnce();
    expect(chat).not.toHaveBeenCalled();
    expect(items).toHaveLength(1);
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

  it("drops an item asserting a high-risk category the board never mentions (source grounding guard)", async () => {
    // The #717 shape: a fabricated "touches secrets + migrations" claim against a
    // board (default CTX) whose evidence mentions neither.
    const fabricated = { ...VALID_ITEM, surface: "contracts audit", prompt: "Decompose PR #717 — 3 files touch secrets, contracts, AND database migrations." };
    expect(await collectAgenticBacklog(CFG(), CTX, { chat: chatReturning(JSON.stringify([fabricated])) })).toHaveLength(0);
  });

  it("keeps a high-risk item when the board evidence actually mentions it", async () => {
    const grounded = { ...VALID_ITEM, surface: "secrets rotation", prompt: "Rotate the committed secrets flagged by the scan." };
    const ctx: AgenticBacklogContext = { ...CTX, board: { ...CTX.board, headline: "secrets scan flagged a committed .env" } };
    expect(await collectAgenticBacklog(CFG(), ctx, { chat: chatReturning(JSON.stringify([grounded])) })).toHaveLength(1);
  });
});

describe("agentic backlog token budget", () => {
  it("defaults routine planning to compact even when the legacy feature is enabled", () => {
    expect(resolveAgenticBacklogMode({ HERMES_ROUTER_AGENTIC_BACKLOG: "1" } as NodeJS.ProcessEnv)).toBe("compact");
    expect(resolveAgenticBacklogMode({ HERMES_ROUTER_AGENTIC_BACKLOG_MODE: "agentic" } as NodeJS.ProcessEnv)).toBe("agentic");
  });

  it("reuses one result across unchanged scheduler ticks", async () => {
    const planner = createAgenticBacklogPlanner();
    const complete = chatReturning(JSON.stringify([VALID_ITEM]));
    const first = await planner.collect(CFG(), CTX, { complete }, { minIntervalMs: 120 * 60_000, nowMs: 0 });
    const second = await planner.collect(CFG(), CTX, { complete }, { minIntervalMs: 120 * 60_000, nowMs: 5 * 60_000 });
    expect(first).toHaveLength(1);
    expect(second).toEqual(first);
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("rate-limits a changed board and refreshes after the minimum interval", async () => {
    const planner = createAgenticBacklogPlanner();
    const complete = chatReturning(JSON.stringify([VALID_ITEM]));
    await planner.collect(CFG(), CTX, { complete }, { minIntervalMs: 60_000, nowMs: 0 });
    const changed = { ...CTX, board: { ...CTX.board, counts: { needsAttention: 2 } } };
    expect(await planner.collect(CFG(), changed, { complete }, { minIntervalMs: 60_000, nowMs: 30_000 })).toEqual([]);
    expect(await planner.collect(CFG(), changed, { complete }, { minIntervalMs: 60_000, nowMs: 60_000 })).toHaveLength(1);
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it("retries an empty or failed result only after the minimum interval", async () => {
    const planner = createAgenticBacklogPlanner();
    const complete = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ sessionId: "compact", text: JSON.stringify([VALID_ITEM]) });
    expect(await planner.collect(CFG(), CTX, { complete }, { minIntervalMs: 60_000, nowMs: 0 })).toEqual([]);
    expect(await planner.collect(CFG(), CTX, { complete }, { minIntervalMs: 60_000, nowMs: 30_000 })).toEqual([]);
    expect(await planner.collect(CFG(), CTX, { complete }, { minIntervalMs: 60_000, nowMs: 60_000 })).toHaveLength(1);
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it("ignores age-label churn when deciding whether board meaning changed", () => {
    const card = {
      repo: "averray-agent/agent",
      number: 42,
      lane: "Hermes Checking",
      owner: "Hermes",
      title: "Review PR",
      ageLabel: "1m",
    };
    const before = { ...CTX, board: { ...CTX.board, items: [card] } };
    const after = { ...CTX, board: { ...CTX.board, items: [{ ...card, ageLabel: "6m" }] } };
    expect(agenticBacklogContextSignature(before)).toBe(agenticBacklogContextSignature(after));
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

  it("includes the truth-boundary grounding rules (no menu→claim, no invented specifics)", () => {
    const prompt = buildAgenticBacklogPrompt(CFG(), CTX);
    expect(prompt).toMatch(/GROUND every factual claim/);
    expect(prompt).toMatch(/MENU of what it looks for/);
    expect(prompt).toMatch(/Never invent PR numbers/);
  });
});

describe("ungroundedHighRiskClaim (source truth-boundary guard)", () => {
  const allowed = new Set(["averray-agent/agent"]);
  const item = (over: Partial<AgenticBacklogItem>): AgenticBacklogItem => ({
    ...(normalizeItem(VALID_ITEM, allowed) as AgenticBacklogItem),
    ...over,
  });

  it("flags a high-risk category the board never mentions (the #717 fabrication)", () => {
    const claim = item({ prompt: "Decompose the PR — it touches secrets and database migrations." });
    expect(ungroundedHighRiskClaim(claim, "deploy verification failed on paseo")).toBe("secrets");
  });

  it("passes a high-risk claim that IS grounded in the board evidence", () => {
    const claim = item({ prompt: "Rotate the leaked secrets in the deploy pipeline." });
    expect(ungroundedHighRiskClaim(claim, "needs-attention: secrets scan flagged a committed .env")).toBeNull();
  });

  it("ignores items that assert no high-risk category (contracts are NOT in the guard)", () => {
    const claim = item({ prompt: "Fix the flaky monitor test and the contract selector.", title: "flaky test", description: "" });
    expect(ungroundedHighRiskClaim(claim, "anything")).toBeNull();
  });

  it("flags an ungrounded migrations claim too", () => {
    const claim = item({ prompt: "Write the DB migration for the new column.", title: "migration", description: "" });
    expect(ungroundedHighRiskClaim(claim, "board with no db work")).toBe("migrations");
  });
});

describe("boardGroundingText", () => {
  it("flattens headline + card fields into one lowercase corpus", () => {
    const text = boardGroundingText({
      headline: "One SECRETS scan failed",
      items: [{ title: "Rotate key", lane: "needs-attention", owner: "codex", why: "committed .env", next: "rotate then redeploy" }],
    });
    expect(text).toContain("secrets");
    expect(text).toContain(".env");
    expect(text).toContain("rotate then redeploy");
    expect(text).toBe(text.toLowerCase());
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
