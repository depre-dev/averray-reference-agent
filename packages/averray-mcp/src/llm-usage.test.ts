import { describe, expect, it } from "vitest";

import {
  aggregateLlmUsage,
  llmBillingClass,
  resolveClaudePlan,
  resolveCodexPlan,
  resolveOllamaPlan,
  resolveSubscriptionPlans,
  subscriptionProviderOf,
  type LlmUsageEvent,
  type SubscriptionPlanConfig,
} from "./llm-usage.js";

function evt(over: Partial<LlmUsageEvent> & Pick<LlmUsageEvent, "agent" | "model" | "ts">): LlmUsageEvent {
  return { inputTokens: 0, outputTokens: 0, ...over };
}

// Ollama is dedicated (monitor-only); Codex + Claude are shared (used beyond this app).
const OLLAMA_PRO: SubscriptionPlanConfig = { provider: "ollama", label: "Ollama", plan: "pro", planLabel: "Pro", monthlyUsd: 20, configured: true, dedicated: true };
const CODEX_PRO5X: SubscriptionPlanConfig = { provider: "codex", label: "Codex", plan: "pro5x", planLabel: "Pro 5×", monthlyUsd: 100, configured: true, dedicated: false };
const CLAUDE_MAX5X: SubscriptionPlanConfig = { provider: "claude", label: "Claude", plan: "max5x", planLabel: "Max 5×", monthlyUsd: 100, configured: true, dedicated: false };
const OLLAMA_UNSET: SubscriptionPlanConfig = { provider: "ollama", label: "Ollama", plan: "none", planLabel: "", monthlyUsd: null, configured: false, dedicated: true };
const CODEX_UNSET: SubscriptionPlanConfig = { provider: "codex", label: "Codex", plan: "none", planLabel: "", monthlyUsd: null, configured: false, dedicated: false };

describe("resolve*Plan / resolveSubscriptionPlans", () => {
  it("maps each provider's plan to its flat monthly price (case-insensitive, dash/underscore tolerant)", () => {
    expect(resolveOllamaPlan({ OLLAMA_PLAN: "pro" } as NodeJS.ProcessEnv)).toEqual(OLLAMA_PRO);
    expect(resolveCodexPlan({ CODEX_PLAN: "pro-5x" } as NodeJS.ProcessEnv)).toEqual(CODEX_PRO5X); // normalised
    expect(resolveClaudePlan({ CLAUDE_PLAN: "max5x" } as NodeJS.ProcessEnv)).toEqual(CLAUDE_MAX5X);
    expect(resolveClaudePlan({ CLAUDE_PLAN: "MAX20X" } as NodeJS.ProcessEnv)).toMatchObject({ plan: "max20x", monthlyUsd: 200, planLabel: "Max 20×" });
  });

  it("treats unset / unknown plans as not configured (never invents a cost)", () => {
    expect(resolveOllamaPlan({} as NodeJS.ProcessEnv)).toEqual(OLLAMA_UNSET);
    expect(resolveClaudePlan({ CLAUDE_PLAN: "enterprise" } as NodeJS.ProcessEnv)).toMatchObject({ plan: "none", configured: false });
  });

  it("resolveSubscriptionPlans returns all three providers from env", () => {
    const plans = resolveSubscriptionPlans({ OLLAMA_PLAN: "pro", CODEX_PLAN: "pro5x", CLAUDE_PLAN: "max5x" } as NodeJS.ProcessEnv);
    expect(plans.map((p) => p.provider)).toEqual(["ollama", "codex", "claude"]);
    expect(plans).toEqual([OLLAMA_PRO, CODEX_PRO5X, CLAUDE_MAX5X]);
  });
});

describe("subscriptionProviderOf / llmBillingClass", () => {
  it("attributes events to their subscription provider (Claude included)", () => {
    expect(subscriptionProviderOf("hermes", "glm-5.2:cloud")).toBe("ollama");
    expect(subscriptionProviderOf("codex", "gpt-5.5-codex")).toBe("codex");
    expect(subscriptionProviderOf("claude", "claude-opus")).toBe("claude");
    expect(subscriptionProviderOf("test-writer", "claude-sonnet")).toBe("claude"); // a Claude specialist
    expect(subscriptionProviderOf("nobody", "mystery")).toBeNull();
  });

  it("classes Ollama, Codex, and Claude as subscription (Claude runs on a plan); else unknown", () => {
    expect(llmBillingClass("hermes", "glm-5.2:cloud")).toBe("subscription");
    expect(llmBillingClass("codex", "gpt-5.5-codex")).toBe("subscription");
    expect(llmBillingClass("claude", "not_recorded")).toBe("subscription"); // was metered — now plan-covered
    expect(llmBillingClass("security", "claude-opus-4")).toBe("subscription");
    expect(llmBillingClass("someone-else", "mystery")).toBe("unknown");
  });
});

describe("aggregateLlmUsage — billing block (Ollama + Codex + Claude)", () => {
  const NOW = new Date("2026-07-07T12:00:00.000Z");
  const ollamaA = evt({ agent: "hermes", model: "glm-5.2:cloud", ts: "2026-07-07T11:00:00.000Z", inputTokens: 100, outputTokens: 50, cacheTokens: 1000 }); // 1h → 1150
  const codexA = evt({ agent: "codex", model: "gpt-5.5-codex", ts: "2026-07-07T11:30:00.000Z", inputTokens: 1000, outputTokens: 500 }); // 30m → 1500
  // Claude reports tokens AND a per-call cost, but the flat plan covers it.
  const claudeA = evt({ agent: "claude", model: "claude-opus", ts: "2026-07-07T11:00:00.000Z", inputTokens: 100, outputTokens: 200, cacheTokens: 5000, costUsd: 0.16 }); // 1h → 5300 tok

  it("makes Claude a SHARED subscription with token burn + a would-be $ context, never in the total", () => {
    const b = aggregateLlmUsage([ollamaA, codexA, claudeA], {
      now: NOW,
      subscriptions: [OLLAMA_PRO, CODEX_PRO5X, CLAUDE_MAX5X],
    }).billing;

    expect(b.subscriptions.map((s) => s.provider)).toEqual(["ollama", "codex", "claude"]);

    const claude = b.subscriptions.find((s) => s.provider === "claude")!;
    expect(claude.dedicated).toBe(false); // used interactively elsewhere too
    expect(claude.unit).toBe("tokens"); // Claude reports tokens (unlike Codex)
    expect(claude.active).toBe(true);
    expect(claude.monthlyUsd).toBe(100);
    expect(claude.planLabel).toBe("Max 5×");
    expect(claude.windows!.session5h.tokens).toBe(5300);
    expect(claude.windows!.session5h.calls).toBe(1);
    // The $0.16 is a would-be API cost the plan covers — context, not spend.
    expect(claude.apiEquivalentUsd).toBe(0.16);
    expect(claude.note).toMatch(/plan|not billed per token/i);

    // Nothing is metered now (Claude moved to subscription).
    expect(b.metered.monthCostUsd).toBeNull();
    // Total is the app's dedicated spend only: Ollama $20 — NOT Codex or Claude ($100 each).
    expect(b.monthlyTotalUsd).toBe(20);
    expect(b.monthlyTotalComplete).toBe(true);
  });

  it("keeps a configured provider with no usage as flat-cost-only (Codex idle)", () => {
    const b = aggregateLlmUsage([ollamaA, claudeA], {
      now: NOW,
      subscriptions: [OLLAMA_PRO, CODEX_PRO5X, CLAUDE_MAX5X], // Codex configured but no codex events
    }).billing;
    const codex = b.subscriptions.find((s) => s.provider === "codex")!;
    expect(codex.active).toBe(false);
    expect(codex.windows).toBeNull();
    expect(codex.monthlyUsd).toBe(100);
    // Ollama dedicated $20 is the whole total; Codex + Claude are shared context.
    expect(b.monthlyTotalUsd).toBe(20);
    expect(b.monthlyTotalComplete).toBe(true);
  });

  it("omits a provider that is neither configured nor active; flags an unconfigured-but-active dedicated plan", () => {
    const b = aggregateLlmUsage([ollamaA], {
      now: NOW,
      subscriptions: [OLLAMA_UNSET, CODEX_UNSET], // neither configured
    }).billing;
    expect(b.subscriptions.map((s) => s.provider)).toEqual(["ollama"]); // codex omitted
    expect(b.subscriptions[0]!.configured).toBe(false);
    expect(b.subscriptions[0]!.active).toBe(true);
    // A dedicated plan with usage but no price → total unknown + incomplete.
    expect(b.monthlyTotalUsd).toBeNull();
    expect(b.monthlyTotalComplete).toBe(false);
  });

  it("shows Codex RUNS as the burn proxy when it reports no tokens (usage, not cost)", () => {
    const runs = ["2026-07-07T11:00:00.000Z", "2026-07-07T09:00:00.000Z", "2026-07-04T00:00:00.000Z"]; // 1h,3h in 5h; 3d in week/month
    const b = aggregateLlmUsage([ollamaA], {
      now: NOW,
      subscriptions: [OLLAMA_PRO, CODEX_PRO5X],
      subscriptionRuns: { codex: runs },
    }).billing;
    const codex = b.subscriptions.find((s) => s.provider === "codex")!;
    expect(codex.active).toBe(true);
    expect(codex.unit).toBe("runs");
    expect(codex.windows!.session5h.calls).toBe(2);
    expect(codex.windows!.session5h.tokens).toBe(0); // never a fabricated token count
    expect(codex.windows!.month.calls).toBe(3);
    expect(codex.dedicated).toBe(false);
    expect(b.monthlyTotalUsd).toBe(20); // Ollama only
  });

  it("keeps a dedicated flat cost with no clock; a shared plan alone yields no app total", () => {
    const dedicated = aggregateLlmUsage([ollamaA], { subscriptions: [OLLAMA_PRO] }).billing;
    expect(dedicated.subscriptions[0]!.windows).toBeNull();
    expect(dedicated.monthlyTotalUsd).toBe(20);
    expect(dedicated.monthlyTotalComplete).toBe(true);

    // Claude alone is shared → its $100 is context, so there's nothing to total.
    const sharedOnly = aggregateLlmUsage([claudeA], { subscriptions: [CLAUDE_MAX5X] }).billing;
    expect(sharedOnly.subscriptions[0]!.provider).toBe("claude");
    expect(sharedOnly.subscriptions[0]!.monthlyUsd).toBe(100);
    expect(sharedOnly.monthlyTotalUsd).toBeNull();
    expect(sharedOnly.monthlyTotalComplete).toBe(true); // no dedicated plan to be missing
  });
});
