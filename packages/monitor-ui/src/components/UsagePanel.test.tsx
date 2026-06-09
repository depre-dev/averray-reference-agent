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

  test("shows an honest awaiting-data chart slot — never a synthetic series", () => {
    const { getByText, getByLabelText } = render(<UsagePanel usage={recorded} />);
    expect(getByLabelText("Recent per-model usage — awaiting data stream")).toBeTruthy();
    expect(getByText("not wired")).toBeTruthy();
    expect(getByText("awaiting per-model usage stream")).toBeTruthy();
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
