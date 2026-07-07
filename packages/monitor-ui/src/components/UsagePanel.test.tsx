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

// ── Cost & subscription burn (Ollama + Codex + Claude flat plans) ───────────
const ollamaSub: SubscriptionBilling = {
  provider: "ollama",
  label: "Ollama",
  plan: "pro",
  planLabel: "Pro",
  monthlyUsd: 20,
  configured: true,
  active: true,
  dedicated: true, // Hermes/Ollama is used only inside the monitor
  unit: "tokens",
  models: ["glm-5.2:cloud", "deepseek-v4-pro:cloud"],
  windows: {
    session5h: { label: "5h session", tokens: 1_200_000, calls: 40, inputTokens: 1_000_000, outputTokens: 200_000, since: "2026-07-07T07:00:00.000Z" },
    week7d: { label: "7d week", tokens: 2_000_000, calls: 92, inputTokens: 1_800_000, outputTokens: 200_000, since: "2026-06-30T12:00:00.000Z" },
    month: { label: "this month", tokens: 2_000_000, calls: 92, inputTokens: 1_800_000, outputTokens: 200_000, since: "2026-07-01T00:00:00.000Z" },
  },
  apiEquivalentUsd: null,
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
  dedicated: false, // Codex draws from your shared ChatGPT plan
  unit: "runs", // Codex reports no tokens — usage proxy is run counts
  models: [],
  windows: null,
  apiEquivalentUsd: null,
  note: "Codex draws from your ChatGPT plan. The Codex CLI isn't emitting token counters, so there's no burn proxy yet.",
};
// Claude: shared Max 5× plan, usage plan-covered (paused credit change) but token
// counts ARE reported — token burn windows + a would-be API-cost of $0.16.
const claudeSub: SubscriptionBilling = {
  provider: "claude",
  label: "Claude",
  plan: "max5x",
  planLabel: "Max 5×",
  monthlyUsd: 100,
  configured: true,
  active: true,
  dedicated: false, // you use Claude interactively elsewhere too
  unit: "tokens",
  models: ["not_recorded"],
  windows: {
    session5h: { label: "5h session", tokens: 800_000, calls: 30, inputTokens: 700_000, outputTokens: 100_000, since: "2026-07-07T07:00:00.000Z" },
    week7d: { label: "7d week", tokens: 1_500_000, calls: 70, inputTokens: 1_300_000, outputTokens: 200_000, since: "2026-06-30T12:00:00.000Z" },
    month: { label: "this month", tokens: 1_500_000, calls: 70, inputTokens: 1_300_000, outputTokens: 200_000, since: "2026-07-01T00:00:00.000Z" },
  },
  apiEquivalentUsd: 0.16,
  note: "Claude Code draws from your Claude plan's shared 5h/weekly limits — included, not billed per token.",
};
const proBilling: LlmUsageBilling = {
  metered: { models: [], monthCostUsd: null, costStatus: "not_recorded" }, // nothing metered — Claude is a subscription now
  subscriptions: [ollamaSub, codexSub, claudeSub],
  monthlyTotalUsd: 20, // dedicated Ollama $20 only (Codex + Claude shared, excluded; Claude's $0.16 is plan-covered)
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

// text matcher tolerant of the "×" glyph in plan labels
const hasText = (needle: string) => (content: string) => content.includes(needle);

describe("UsagePanel — cost & subscription burn", () => {
  test("totals only DEDICATED spend (Ollama); Codex + Claude are shared context, not summed", () => {
    const { getByText, getAllByText, queryByText } = render(<UsagePanel usage={withBilling} />);
    expect(getByText("Cost this month")).toBeTruthy();
    // Total is the app's real dedicated cost: Ollama $20 — NOT Codex or Claude ($100 each, shared).
    expect(getByText(/≈\s*\$20\.00/)).toBeTruthy();
    expect(getByText("Ollama Pro · flat")).toBeTruthy();
    expect(getByText("$20/mo")).toBeTruthy();
    // Claude is no longer a metered line — its usage is plan-covered.
    expect(queryByText(hasText("Metered"))).toBeNull();
    // Codex + Claude under the "shared" heading, each $100/mo, excluded from the total.
    expect(getByText(hasText("used beyond this monitor"))).toBeTruthy();
    expect(getByText(hasText("Codex Pro"))).toBeTruthy(); // "Codex Pro 5× · flat"
    expect(getByText(hasText("Claude Max"))).toBeTruthy(); // "Claude Max 5× · flat"
    expect(getAllByText("$100/mo").length).toBe(2); // Codex + Claude
  });

  test("subscription rows (Ollama + Claude) show a muted 'flat' tag, not a misleading '?'", () => {
    const { getAllByText, getByText } = render(<UsagePanel usage={withBilling} />);
    expect(getAllByText("flat").length).toBeGreaterThanOrEqual(2); // glm + claude model rows
    // The would-be $0.16 surfaces as Claude context, not as a metered charge.
    const body = getByText("Cost this month").ownerDocument.body.textContent ?? "";
    expect(body).toContain("$0.16");
  });

  test("renders token burn blocks for Ollama and Claude; idle Codex shows no burn block", () => {
    const { getByText, getAllByText, queryByText } = render(<UsagePanel usage={withBilling} />);
    expect(getByText("Ollama burn · Pro plan")).toBeTruthy();
    expect(getByText(hasText("Claude burn"))).toBeTruthy(); // "Claude burn · Max 5× plan"
    expect(getAllByText("5h session").length).toBe(2); // Ollama + Claude token blocks
    expect(getByText("40 calls")).toBeTruthy(); // Ollama 5h
    // Claude's would-be API cost is shown as context, never in the total.
    expect(getByText(hasText("$0.16 at API rates"))).toBeTruthy();
    expect(getByText(hasText("covered by your plan"))).toBeTruthy();
    // Codex reports no usage → no burn block for it.
    expect(queryByText(hasText("Codex burn"))).toBeNull();
    expect(queryByText(hasText("Codex runs"))).toBeNull();
  });

  test("shows Codex RUNS as a second burn block — the monitor's own Codex usage (not tokens)", () => {
    // Codex reports no tokens, so its windows count runs the monitor dispatched.
    const codexRuns: SubscriptionBilling = {
      ...codexSub,
      active: true,
      unit: "runs",
      models: ["gpt-5.5-codex"],
      windows: {
        session5h: { label: "5h session", tokens: 0, calls: 3, inputTokens: 0, outputTokens: 0, since: "2026-07-07T07:00:00.000Z" },
        week7d: { label: "7d week", tokens: 0, calls: 18, inputTokens: 0, outputTokens: 0, since: "2026-06-30T12:00:00.000Z" },
        month: { label: "this month", tokens: 0, calls: 40, inputTokens: 0, outputTokens: 0, since: "2026-07-01T00:00:00.000Z" },
      },
      note: "Codex task runs this monitor dispatched — the Codex CLI reports no tokens, so this counts runs.",
    };
    const usage: LlmUsageAggregate = { ...withBilling, billing: { ...proBilling, subscriptions: [ollamaSub, codexRuns] } };
    const { getByText, getAllByText } = render(<UsagePanel usage={usage} />);
    expect(getByText("Ollama burn · Pro plan")).toBeTruthy();
    expect(getByText(hasText("Codex runs"))).toBeTruthy(); // title "Codex runs · Pro 5× plan"
    expect(getByText(hasText("3 runs"))).toBeTruthy(); // 5h session run count
    expect(getByText(hasText("40 runs"))).toBeTruthy(); // this month
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
