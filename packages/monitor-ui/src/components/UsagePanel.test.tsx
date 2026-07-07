// @vitest-environment jsdom
import { afterEach, describe, expect, test } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { UsagePanel } from "./UsagePanel.js";
import type { LlmUsageAggregate, LlmUsageBilling, SubscriptionBilling } from "../lib/monitor/board-cache.js";

afterEach(cleanup);

const recorded: LlmUsageAggregate = {
  status: "recorded",
  inputTokens: 8_000,
  outputTokens: 2_000,
  totalTokens: 10_000,
  costUsd: null,
  costStatus: "not_recorded",
  runs: 5,
  lastActiveAt: "2026-06-09T10:00:00.000Z",
  byModel: [
    {
      agent: "hermes",
      model: "deepseek-v4-pro",
      inputTokens: 8_000,
      outputTokens: 2_000,
      totalTokens: 10_000,
      costUsd: null,
      costStatus: "not_recorded",
      runs: 5,
      lastActiveAt: "2026-06-09T10:00:00.000Z",
    },
  ],
  byDay: [],
  // The full expected roster: hermes active, the rest idle.
  sourceStatus: [
    { agent: "hermes", status: "recorded" },
    { agent: "claude", status: "not_reported", reason: "Claude Agent SDK usage counters have not arrived yet." },
    { agent: "test-writer", status: "not_reported", reason: "Test-writer SDK usage counters have not arrived yet." },
    { agent: "security", status: "not_reported", reason: "Security specialist SDK usage counters have not arrived yet." },
    { agent: "docs", status: "not_reported", reason: "Docs specialist SDK usage counters have not arrived yet." },
    { agent: "codex", status: "not_reported", reason: "Codex CLI does not report usage." },
  ],
};

describe("UsagePanel", () => {
  test("renders the real per-model table with a '?' latency (never fabricated)", () => {
    const { getByText, getAllByText, getByRole } = render(<UsagePanel usage={recorded} />);
    expect(getByRole("region", { name: "LLM usage" })).toBeTruthy();
    expect(getByText("All models")).toBeTruthy();
    expect(getByText("deepseek-v4-pro")).toBeTruthy();
    expect(getAllByText("10K").length).toBeGreaterThan(0); // total + model row, compact
    expect(getAllByText("?").length).toBeGreaterThan(0); // latency has no source
  });

  test("shows EVERY expected agent — idle ones listed explicitly with reasons, never collapsed", () => {
    const { getByText } = render(<UsagePanel usage={recorded} />);
    expect(getByText("Idle agents · 5")).toBeTruthy();
    // The agents that had no usage are still named (the operator's ask), with reasons.
    for (const agent of ["claude", "test-writer", "security", "docs", "codex"]) {
      expect(getByText(agent)).toBeTruthy();
    }
    expect(getByText("Codex CLI does not report usage.")).toBeTruthy();
  });

  test("renders a real Cost column only when costStatus is recorded", () => {
    const withCost: LlmUsageAggregate = {
      ...recorded,
      costUsd: 0.42,
      costStatus: "recorded",
      byModel: [{ ...recorded.byModel[0]!, costUsd: 0.42, costStatus: "recorded" }],
    };
    const { getByText, getAllByText } = render(<UsagePanel usage={withCost} />);
    expect(getByText("Cost")).toBeTruthy();
    expect(getAllByText("$0.42").length).toBeGreaterThan(0); // total + model row
  });

  test("omits the Cost column entirely when no source reports cost (no column of '?')", () => {
    const { queryByText } = render(<UsagePanel usage={recorded} />);
    expect(queryByText("Cost")).toBeNull();
  });

  test("renders a REAL daily-tokens chart from byDay (≥2 days), not the awaiting frame", () => {
    const withDays: LlmUsageAggregate = {
      ...recorded,
      byDay: [
        { day: "2026-06-07", inputTokens: 4_000, outputTokens: 1_000, totalTokens: 5_000, costUsd: null, costStatus: "not_recorded", runs: 3, byModel: [] },
        { day: "2026-06-08", inputTokens: 6_000, outputTokens: 2_000, totalTokens: 8_000, costUsd: null, costStatus: "not_recorded", runs: 4, byModel: [] },
        { day: "2026-06-09", inputTokens: 3_000, outputTokens: 1_000, totalTokens: 4_000, costUsd: null, costStatus: "not_recorded", runs: 2, byModel: [] },
      ],
    };
    const { getByText, queryByText } = render(<UsagePanel usage={withDays} />);
    expect(getByText("Daily tokens · last 3 days")).toBeTruthy();
    expect(getByText("daily")).toBeTruthy();
    expect(getByText(/17K tokens over 3 days/)).toBeTruthy();
    // The "awaiting per-minute" frame is replaced by the real chart.
    expect(queryByText("not wired")).toBeNull();
  });

  test("renders the live per-minute per-model lines when there's recent activity", () => {
    const points = new Array<number>(60).fill(0);
    points[58] = 40;
    points[59] = 120;
    const claudePoints = new Array<number>(60).fill(0);
    claudePoints[59] = 35;
    const withRecent: LlmUsageAggregate = {
      ...recorded,
      recent: {
        windowMinutes: 60,
        endsAt: "2026-06-09T12:30:00.000Z",
        series: [
          { agent: "hermes", model: "deepseek-v4-pro", points },
          { agent: "claude", model: "claude-sonnet-4-6", points: claudePoints },
        ],
      },
    };
    const { getByText, getByLabelText, queryByText } = render(<UsagePanel usage={withRecent} />);
    expect(getByLabelText(/Live tokens per minute/)).toBeTruthy();
    expect(getByText("Recent usage · tokens/min · per model")).toBeTruthy();
    expect(getByText("live · 60m")).toBeTruthy();
    // Per-model legend names both active models; no "idle"/"not wired" frame.
    expect(queryByText("idle")).toBeNull();
    expect(queryByText("not wired")).toBeNull();
  });

  test("falls back to an honest idle frame when there's no recent activity and no daily series", () => {
    const { getByText, getByLabelText } = render(<UsagePanel usage={recorded} />);
    expect(getByLabelText("Usage over time — no recent activity")).toBeTruthy();
    expect(getByText("idle")).toBeTruthy();
    expect(getByText("no token usage in the last hour")).toBeTruthy();
  });

  test("renders the honest empty state when nothing is recorded", () => {
    const empty: LlmUsageAggregate = {
      status: "not_recorded",
      message: "No LLM usage counters have been recorded yet.",
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      costUsd: null,
      costStatus: "not_recorded",
      runs: 0,
      byModel: [],
      byDay: [],
    };
    const { getByText, queryByText } = render(<UsagePanel usage={empty} />);
    expect(getByText("usage not reported")).toBeTruthy();
    expect(getByText(/No LLM usage counters have been recorded yet/)).toBeTruthy();
    // No awaiting-data chart and no fabricated rows when there's nothing real.
    expect(queryByText("not wired")).toBeNull();
  });
});

// ── Cost & subscription burn (Ollama + Codex flat plans + metered Claude $) ──
const ollamaSub: SubscriptionBilling = {
  provider: "ollama",
  label: "Ollama",
  plan: "pro",
  planLabel: "Pro",
  monthlyUsd: 20,
  configured: true,
  active: true,
  models: ["glm-5.2:cloud", "deepseek-v4-pro:cloud"],
  windows: {
    session5h: { label: "5h session", tokens: 1_200_000, calls: 40, inputTokens: 1_000_000, outputTokens: 200_000, since: "2026-07-07T07:00:00.000Z" },
    week7d: { label: "7d week", tokens: 2_000_000, calls: 92, inputTokens: 1_800_000, outputTokens: 200_000, since: "2026-06-30T12:00:00.000Z" },
    month: { label: "this month", tokens: 2_000_000, calls: 92, inputTokens: 1_800_000, outputTokens: 200_000, since: "2026-07-01T00:00:00.000Z" },
  },
  note: "Ollama Cloud bills a flat monthly plan metered by GPU-time — not tokens or per-call dollars.",
};
// Codex configured (Pro 5× $100) but its CLI isn't reporting usage → flat cost only.
const codexSub: SubscriptionBilling = {
  provider: "codex",
  label: "Codex",
  plan: "pro5x",
  planLabel: "Pro 5×",
  monthlyUsd: 100,
  configured: true,
  active: false,
  models: [],
  windows: null,
  note: "Codex draws from your ChatGPT plan. The Codex CLI isn't emitting token counters, so there's no burn proxy yet.",
};
const proBilling: LlmUsageBilling = {
  metered: { models: ["not_recorded"], monthCostUsd: 0.16, costStatus: "recorded" },
  subscriptions: [ollamaSub, codexSub],
  monthlyTotalUsd: 120.16,
  monthlyTotalComplete: true,
};

const withBilling: LlmUsageAggregate = {
  ...recorded,
  costUsd: 0.16,
  costStatus: "recorded",
  byModel: [
    { agent: "hermes", model: "glm-5.2:cloud", inputTokens: 2_000_000, outputTokens: 16_300, totalTokens: 2_000_000, costUsd: null, costStatus: "not_recorded", runs: 92, lastActiveAt: "2026-07-07T11:59:00.000Z" },
    { agent: "claude", model: "not_recorded", inputTokens: 8, outputTokens: 2_700, totalTokens: 161_600, costUsd: 0.16, costStatus: "recorded", runs: 1, lastActiveAt: "2026-07-07T11:00:00.000Z" },
  ],
  billing: proBilling,
};

// text matcher tolerant of the "×" glyph in "Pro 5×"
const hasText = (needle: string) => (content: string) => content.includes(needle);

describe("UsagePanel — cost & subscription burn", () => {
  test("headlines an honest 'cost this month' = each flat plan (Ollama + Codex) + metered Claude $", () => {
    const { getByText } = render(<UsagePanel usage={withBilling} />);
    expect(getByText("Cost this month")).toBeTruthy();
    expect(getByText(/≈\s*\$120\.16/)).toBeTruthy(); // $20 + $100 + $0.16
    expect(getByText("Ollama Pro · flat")).toBeTruthy();
    expect(getByText("$20/mo")).toBeTruthy();
    expect(getByText(hasText("Codex Pro"))).toBeTruthy(); // "Codex Pro 5× · flat"
    expect(getByText("$100/mo")).toBeTruthy();
    expect(getByText("Metered · Claude API")).toBeTruthy();
  });

  test("a subscription (:cloud) row shows a muted 'flat' tag, not a misleading '?'", () => {
    const { getByText } = render(<UsagePanel usage={withBilling} />);
    expect(getByText("flat")).toBeTruthy(); // the glm-5.2:cloud row
    const dollars = getByText("Cost this month").ownerDocument.body.textContent ?? "";
    expect(dollars).toContain("$0.16");
  });

  test("renders the Ollama burn block; a configured-but-idle Codex shows cost only (no burn block)", () => {
    const { getByText, getAllByText, queryByText } = render(<UsagePanel usage={withBilling} />);
    expect(getByText("Ollama burn · Pro plan")).toBeTruthy();
    expect(getByText("5h session")).toBeTruthy();
    expect(getByText("40 calls")).toBeTruthy();
    expect(getAllByText("92 calls").length).toBe(2);
    expect(getByText(/GPU-time/)).toBeTruthy();
    // Codex reports no usage → its cost shows in the strip but no burn windows.
    expect(queryByText(hasText("Codex burn"))).toBeNull();
  });

  test("renders a SECOND burn block for Codex once it reports usage", () => {
    const codexActive: SubscriptionBilling = {
      ...codexSub,
      active: true,
      models: ["gpt-5.5-codex"],
      windows: {
        session5h: { label: "5h session", tokens: 500_000, calls: 12, inputTokens: 400_000, outputTokens: 100_000, since: "2026-07-07T07:00:00.000Z" },
        week7d: { label: "7d week", tokens: 900_000, calls: 30, inputTokens: 700_000, outputTokens: 200_000, since: "2026-06-30T12:00:00.000Z" },
        month: { label: "this month", tokens: 900_000, calls: 30, inputTokens: 700_000, outputTokens: 200_000, since: "2026-07-01T00:00:00.000Z" },
      },
      note: "Codex draws from your ChatGPT plan, metered against a rolling ~5-hour window.",
    };
    const usage: LlmUsageAggregate = { ...withBilling, billing: { ...proBilling, subscriptions: [ollamaSub, codexActive] } };
    const { getByText, getAllByText } = render(<UsagePanel usage={usage} />);
    expect(getByText("Ollama burn · Pro plan")).toBeTruthy();
    expect(getByText(hasText("Codex burn"))).toBeTruthy(); // "Codex burn · Pro 5× plan"
    expect(getByText("12 calls")).toBeTruthy(); // codex 5h session
    expect(getAllByText("5h session").length).toBe(2); // one window row per block
  });

  test("when a plan is unset, shows 'plan not set' and flags the total incomplete — never invents a subscription $", () => {
    const unset: LlmUsageAggregate = {
      ...withBilling,
      billing: {
        metered: proBilling.metered,
        subscriptions: [{ ...ollamaSub, plan: "none", planLabel: "", monthlyUsd: null, configured: false }],
        monthlyTotalUsd: 0.16,
        monthlyTotalComplete: false,
      },
    };
    const { getByText } = render(<UsagePanel usage={unset} />);
    expect(getByText("Ollama · flat")).toBeTruthy();
    expect(getByText("plan not set")).toBeTruthy();
    expect(getByText(/\$0\.16 \+/)).toBeTruthy(); // metered-only total, "+" signals the missing sub cost
  });

  test("omits every burn block when no subscription is active", () => {
    const idle: LlmUsageAggregate = {
      ...withBilling,
      billing: { ...proBilling, subscriptions: [{ ...ollamaSub, active: false }, codexSub] },
    };
    const { queryByText } = render(<UsagePanel usage={idle} />);
    expect(queryByText(hasText("burn"))).toBeNull();
  });
});
