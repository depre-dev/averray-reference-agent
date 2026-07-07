import { describe, expect, it } from "vitest";

import {
  aggregateLlmUsage,
  llmBillingClass,
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

const OLLAMA_PRO: SubscriptionPlanConfig = { provider: "ollama", label: "Ollama", plan: "pro", planLabel: "Pro", monthlyUsd: 20, configured: true };
const CODEX_PRO5X: SubscriptionPlanConfig = { provider: "codex", label: "Codex", plan: "pro5x", planLabel: "Pro 5×", monthlyUsd: 100, configured: true };
const OLLAMA_UNSET: SubscriptionPlanConfig = { provider: "ollama", label: "Ollama", plan: "none", planLabel: "", monthlyUsd: null, configured: false };
const CODEX_UNSET: SubscriptionPlanConfig = { provider: "codex", label: "Codex", plan: "none", planLabel: "", monthlyUsd: null, configured: false };

describe("resolveOllamaPlan / resolveCodexPlan / resolveSubscriptionPlans", () => {
  it("maps each provider's plan to its flat monthly price (case-insensitive, dash/underscore tolerant)", () => {
    expect(resolveOllamaPlan({ OLLAMA_PLAN: "pro" } as NodeJS.ProcessEnv)).toEqual(OLLAMA_PRO);
    expect(resolveOllamaPlan({ OLLAMA_PLAN: "MAX" } as NodeJS.ProcessEnv)).toMatchObject({ plan: "max", monthlyUsd: 100, configured: true });
    expect(resolveCodexPlan({ CODEX_PLAN: "pro5x" } as NodeJS.ProcessEnv)).toEqual(CODEX_PRO5X);
    expect(resolveCodexPlan({ CODEX_PLAN: "pro-5x" } as NodeJS.ProcessEnv)).toEqual(CODEX_PRO5X); // normalised
    expect(resolveCodexPlan({ CODEX_PLAN: "plus" } as NodeJS.ProcessEnv)).toMatchObject({ plan: "plus", monthlyUsd: 20, planLabel: "Plus" });
  });

  it("treats unset / unknown plans as not configured (never invents a cost)", () => {
    expect(resolveOllamaPlan({} as NodeJS.ProcessEnv)).toEqual(OLLAMA_UNSET);
    expect(resolveCodexPlan({ CODEX_PLAN: "enterprise" } as NodeJS.ProcessEnv)).toEqual(CODEX_UNSET);
  });

  it("resolveSubscriptionPlans returns both providers from env", () => {
    const plans = resolveSubscriptionPlans({ OLLAMA_PLAN: "pro", CODEX_PLAN: "pro5x" } as NodeJS.ProcessEnv);
    expect(plans.map((p) => p.provider)).toEqual(["ollama", "codex"]);
    expect(plans).toEqual([OLLAMA_PRO, CODEX_PRO5X]);
  });
});

describe("subscriptionProviderOf / llmBillingClass", () => {
  it("attributes events to their subscription provider", () => {
    expect(subscriptionProviderOf("hermes", "glm-5.2:cloud")).toBe("ollama");
    expect(subscriptionProviderOf("worker", "some-ollama-model")).toBe("ollama");
    expect(subscriptionProviderOf("codex", "gpt-5.5-codex")).toBe("codex");
    expect(subscriptionProviderOf("claude", "claude-opus")).toBeNull();
  });

  it("classes both Ollama and Codex as subscription, Claude agents as metered, else unknown", () => {
    expect(llmBillingClass("hermes", "glm-5.2:cloud")).toBe("subscription");
    expect(llmBillingClass("codex", "gpt-5.5-codex")).toBe("subscription");
    expect(llmBillingClass("claude", "not_recorded")).toBe("metered");
    expect(llmBillingClass("test-writer", "claude-opus-4")).toBe("metered");
    expect(llmBillingClass("someone-else", "mystery")).toBe("unknown");
  });
});

describe("aggregateLlmUsage — billing block (multi-provider)", () => {
  const NOW = new Date("2026-07-07T12:00:00.000Z");
  const ollamaA = evt({ agent: "hermes", model: "glm-5.2:cloud", ts: "2026-07-07T11:00:00.000Z", inputTokens: 100, outputTokens: 50, cacheTokens: 1000 }); // 1h → 1150
  const ollamaB = evt({ agent: "hermes", model: "deepseek-v4-pro:cloud", ts: "2026-07-07T09:00:00.000Z", inputTokens: 8, outputTokens: 2700 }); // 3h → 2708
  const codexA = evt({ agent: "codex", model: "gpt-5.5-codex", ts: "2026-07-07T11:30:00.000Z", inputTokens: 1000, outputTokens: 500 }); // 30m → 1500
  const metered = evt({ agent: "claude", model: "not_recorded", ts: "2026-07-06T00:00:00.000Z", inputTokens: 8, outputTokens: 2700, cacheTokens: 160000, costUsd: 0.16 });

  it("builds one entry per configured/active provider and totals every flat plan + metered $", () => {
    const b = aggregateLlmUsage([ollamaA, ollamaB, codexA, metered], {
      now: NOW,
      subscriptions: [OLLAMA_PRO, CODEX_PRO5X],
    }).billing;

    expect(b.subscriptions.map((s) => s.provider)).toEqual(["ollama", "codex"]);

    const ollama = b.subscriptions.find((s) => s.provider === "ollama")!;
    expect(ollama.monthlyUsd).toBe(20);
    expect(ollama.active).toBe(true);
    expect(ollama.windows!.session5h.tokens).toBe(1150 + 2708);
    expect(ollama.windows!.session5h.calls).toBe(2);
    expect(ollama.note).toMatch(/GPU-time/i);

    const codex = b.subscriptions.find((s) => s.provider === "codex")!;
    expect(codex.monthlyUsd).toBe(100);
    expect(codex.planLabel).toBe("Pro 5×");
    expect(codex.active).toBe(true);
    expect(codex.windows!.session5h.tokens).toBe(1500);
    expect(codex.windows!.session5h.calls).toBe(1);
    expect(codex.note).toMatch(/ChatGPT/i);

    expect(b.metered.monthCostUsd).toBe(0.16);
    expect(b.monthlyTotalUsd).toBe(120.16); // 20 + 100 + 0.16
    expect(b.monthlyTotalComplete).toBe(true);
  });

  it("shows a configured provider that reports NO usage as flat-cost-only (no windows, honest note)", () => {
    const b = aggregateLlmUsage([ollamaA, metered], {
      now: NOW,
      subscriptions: [OLLAMA_PRO, CODEX_PRO5X], // Codex configured but no codex events
    }).billing;

    const codex = b.subscriptions.find((s) => s.provider === "codex")!;
    expect(codex.active).toBe(false);
    expect(codex.windows).toBeNull();
    expect(codex.monthlyUsd).toBe(100); // flat cost still counted
    expect(codex.note).toMatch(/isn't emitting|no burn proxy/i);
    expect(b.monthlyTotalUsd).toBe(120.16);
    expect(b.monthlyTotalComplete).toBe(true);
  });

  it("omits a provider that is neither configured nor active, and flags an unconfigured-but-active one", () => {
    const b = aggregateLlmUsage([ollamaA, metered], {
      now: NOW,
      subscriptions: [OLLAMA_UNSET, CODEX_UNSET], // neither configured
    }).billing;
    // Ollama has usage → shown (active, unconfigured); Codex has neither → omitted.
    expect(b.subscriptions.map((s) => s.provider)).toEqual(["ollama"]);
    expect(b.subscriptions[0]!.configured).toBe(false);
    expect(b.subscriptions[0]!.active).toBe(true);
    // Total is metered-only and flagged incomplete (an active plan has no price).
    expect(b.monthlyTotalUsd).toBe(0.16);
    expect(b.monthlyTotalComplete).toBe(false);
  });

  it("keeps a configured flat cost even with no clock to anchor windows", () => {
    const b = aggregateLlmUsage([codexA], { subscriptions: [CODEX_PRO5X] }).billing;
    const codex = b.subscriptions.find((s) => s.provider === "codex")!;
    expect(codex.windows).toBeNull();
    expect(b.monthlyTotalUsd).toBe(100);
    expect(b.monthlyTotalComplete).toBe(true);
  });
});
