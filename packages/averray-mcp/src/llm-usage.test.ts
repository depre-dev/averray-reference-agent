import { describe, expect, it } from "vitest";

import {
  aggregateLlmUsage,
  llmBillingClass,
  resolveOllamaPlan,
  type LlmUsageEvent,
} from "./llm-usage.js";

function evt(over: Partial<LlmUsageEvent> & Pick<LlmUsageEvent, "agent" | "model" | "ts">): LlmUsageEvent {
  return {
    inputTokens: 0,
    outputTokens: 0,
    ...over,
  };
}

describe("resolveOllamaPlan", () => {
  it("maps free/pro/max to their flat monthly price (case-insensitive)", () => {
    expect(resolveOllamaPlan({ OLLAMA_PLAN: "pro" } as NodeJS.ProcessEnv)).toEqual({
      plan: "pro",
      monthlyUsd: 20,
      configured: true,
    });
    expect(resolveOllamaPlan({ OLLAMA_PLAN: "MAX" } as NodeJS.ProcessEnv)).toEqual({
      plan: "max",
      monthlyUsd: 100,
      configured: true,
    });
    expect(resolveOllamaPlan({ OLLAMA_PLAN: "free" } as NodeJS.ProcessEnv)).toEqual({
      plan: "free",
      monthlyUsd: 0,
      configured: true,
    });
  });

  it("treats unset / unknown plans as not configured (never invents a cost)", () => {
    expect(resolveOllamaPlan({} as NodeJS.ProcessEnv)).toEqual({ plan: "none", monthlyUsd: null, configured: false });
    expect(resolveOllamaPlan({ OLLAMA_PLAN: "enterprise" } as NodeJS.ProcessEnv)).toEqual({
      plan: "none",
      monthlyUsd: null,
      configured: false,
    });
  });
});

describe("llmBillingClass", () => {
  it("classes Ollama Cloud (:cloud / ollama / hermes) as subscription", () => {
    expect(llmBillingClass("hermes", "glm-5.2:cloud")).toBe("subscription");
    expect(llmBillingClass("hermes", "deepseek-v4-pro:cloud")).toBe("subscription");
    expect(llmBillingClass("worker", "some-ollama-model")).toBe("subscription");
    expect(llmBillingClass("hermes", "not_recorded")).toBe("subscription");
  });

  it("classes the Claude SDK agents as metered, everything else unknown", () => {
    expect(llmBillingClass("claude", "not_recorded")).toBe("metered");
    expect(llmBillingClass("test-writer", "claude-opus-4")).toBe("metered");
    expect(llmBillingClass("security", "claude-sonnet")).toBe("metered");
    expect(llmBillingClass("codex", "gpt-x")).toBe("unknown");
  });
});

describe("aggregateLlmUsage — billing block", () => {
  const NOW = new Date("2026-07-07T12:00:00.000Z");
  // Ollama (subscription) events at varying ages.
  const subA = evt({ agent: "hermes", model: "glm-5.2:cloud", ts: "2026-07-07T11:00:00.000Z", inputTokens: 100, outputTokens: 50, cacheTokens: 1000 }); // 1h ago → 1150 tok
  const subB = evt({ agent: "hermes", model: "deepseek-v4-pro:cloud", ts: "2026-07-07T09:00:00.000Z", inputTokens: 8, outputTokens: 2700 }); // 3h ago → 2708 tok
  const subC = evt({ agent: "hermes", model: "glm-5.2:cloud", ts: "2026-07-07T05:00:00.000Z", inputTokens: 10, outputTokens: 20, cacheTokens: 100 }); // 7h ago → 130 tok, outside 5h
  const subOld = evt({ agent: "hermes", model: "glm-5.2:cloud", ts: "2026-06-15T00:00:00.000Z", inputTokens: 5, outputTokens: 5 }); // last month
  // Claude (metered) event with a recorded cost, this month.
  const metered = evt({ agent: "claude", model: "not_recorded", ts: "2026-07-06T00:00:00.000Z", inputTokens: 8, outputTokens: 2700, cacheTokens: 160000, costUsd: 0.16 });

  it("splits subscription windows and metered $, and totals them honestly for a configured plan", () => {
    const agg = aggregateLlmUsage([subA, subB, subC, subOld, metered], {
      now: NOW,
      subscription: { plan: "pro", monthlyUsd: 20, configured: true },
    });
    const b = agg.billing;

    // Subscription side — flat Ollama Pro, active, correct windows (tokens = in+out+cache).
    expect(b.subscription.provider).toBe("ollama");
    expect(b.subscription.plan).toBe("pro");
    expect(b.subscription.monthlyUsd).toBe(20);
    expect(b.subscription.configured).toBe(true);
    expect(b.subscription.active).toBe(true);
    expect(b.subscription.models).toContain("glm-5.2:cloud");

    const w = b.subscription.windows!;
    // 5h session excludes subC (7h old) and subOld.
    expect(w.session5h.calls).toBe(2);
    expect(w.session5h.tokens).toBe(1150 + 2708);
    // 7d week + this month include subA/B/C but not last-month subOld.
    expect(w.week7d.calls).toBe(3);
    expect(w.week7d.tokens).toBe(1150 + 2708 + 130);
    expect(w.month.calls).toBe(3);
    expect(w.month.tokens).toBe(1150 + 2708 + 130);

    // Metered side — real recorded $ this month.
    expect(b.metered.monthCostUsd).toBe(0.16);
    expect(b.metered.costStatus).toBe("recorded");

    // Honest month total = flat plan + metered $, and it's complete.
    expect(b.monthlyTotalUsd).toBe(20.16);
    expect(b.monthlyTotalComplete).toBe(true);
    expect(b.note).toMatch(/GPU-time/i);
  });

  it("never invents a subscription cost when the plan is unset — total is metered-only + flagged incomplete", () => {
    const agg = aggregateLlmUsage([subA, metered], { now: NOW }); // no subscription option
    const b = agg.billing;
    expect(b.subscription.configured).toBe(false);
    expect(b.subscription.monthlyUsd).toBeNull();
    expect(b.subscription.plan).toBe("none");
    // Total excludes the (unknown) Ollama cost, so it's incomplete.
    expect(b.monthlyTotalUsd).toBe(0.16);
    expect(b.monthlyTotalComplete).toBe(false);
  });

  it("leaves windows null when there is no clock to anchor them", () => {
    const agg = aggregateLlmUsage([subA], { subscription: { plan: "pro", monthlyUsd: 20, configured: true } });
    expect(agg.billing.subscription.windows).toBeNull();
    // A configured flat plan still surfaces its price even without a clock.
    expect(agg.billing.monthlyTotalUsd).toBe(20);
    expect(agg.billing.monthlyTotalComplete).toBe(true);
  });
});
