// @vitest-environment jsdom
import { afterEach, describe, expect, test } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { UsagePanel } from "./UsagePanel.js";
import type { LlmUsageAggregate } from "../lib/monitor/board-cache.js";

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

  test("falls back to an honest awaiting-data frame when there's no daily series", () => {
    const { getByText, getByLabelText } = render(<UsagePanel usage={recorded} />);
    expect(getByLabelText("Usage over time — awaiting per-minute stream")).toBeTruthy();
    expect(getByText("not wired")).toBeTruthy();
    expect(getByText("awaiting per-minute usage stream")).toBeTruthy();
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
