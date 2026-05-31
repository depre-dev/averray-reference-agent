import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  aggregateLlmUsage,
  llmUsageEventFromResult,
  recordLlmUsageFromResult,
} from "../../packages/averray-mcp/src/llm-usage.js";

describe("LLM usage tracker", () => {
  it("records a whitelisted usage event with the expected shape", async () => {
    const dir = await mkdtemp(join(tmpdir(), "averray-llm-usage-"));
    try {
      const path = join(dir, "llm-usage.jsonl");
      const event = await recordLlmUsageFromResult({
        agent: "claude",
        model: "claude-sonnet-4-5",
        runId: "run-1",
        taskId: "task-1",
        ts: new Date("2026-05-31T12:00:00.000Z"),
        result: {
          usage: {
            input_tokens: 100,
            output_tokens: 25,
            cost_usd: 0.0123456,
          },
        },
      }, { path });

      expect(event).toEqual({
        agent: "claude",
        model: "claude-sonnet-4-5",
        runId: "run-1",
        taskId: "task-1",
        inputTokens: 100,
        outputTokens: 25,
        costUsd: 0.012346,
        ts: "2026-05-31T12:00:00.000Z",
      });
      expect(JSON.parse((await readFile(path, "utf8")).trim())).toEqual(event);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("aggregates per agent/model/day and leaves bundled cost as not_recorded", () => {
    const aggregate = aggregateLlmUsage([
      {
        agent: "codex",
        model: "gpt-5-codex",
        taskId: "codex-task",
        inputTokens: 10,
        outputTokens: 5,
        ts: "2026-05-31T01:00:00.000Z",
      },
      {
        agent: "claude",
        model: "claude-sonnet-4-5",
        taskId: "claude-task",
        inputTokens: 20,
        outputTokens: 7,
        costUsd: 0.02,
        ts: "2026-05-31T02:00:00.000Z",
      },
      {
        agent: "claude",
        model: "claude-sonnet-4-5",
        taskId: "claude-task-2",
        inputTokens: 3,
        outputTokens: 2,
        costUsd: 0.01,
        ts: "2026-06-01T02:00:00.000Z",
      },
    ]);

    expect(aggregate).toMatchObject({
      status: "recorded",
      inputTokens: 33,
      outputTokens: 14,
      totalTokens: 47,
      costUsd: 0.03,
      costStatus: "recorded",
      runs: 3,
    });
    expect(aggregate.byModel.find((entry) => entry.agent === "codex")).toMatchObject({
      model: "gpt-5-codex",
      totalTokens: 15,
      costUsd: null,
      costStatus: "not_recorded",
    });
    expect(aggregate.byDay.map((day) => day.day)).toEqual(["2026-06-01", "2026-05-31"]);
    expect(aggregate.byDay.find((day) => day.day === "2026-05-31")).toMatchObject({
      totalTokens: 42,
      costUsd: 0.02,
    });
  });

  it("does not copy prompts or secrets into usage events", () => {
    const event = llmUsageEventFromResult({
      agent: "hermes",
      taskId: "mission-1",
      ts: new Date("2026-05-31T12:00:00.000Z"),
      result: {
        model: "deepseek-v4-pro:cloud",
        prompt: "private operator prompt",
        apiKey: "sk-should-never-appear",
        usage: {
          inputTokens: 12,
          outputTokens: 8,
          secret: "also-nope",
        },
      },
    });

    const serialized = JSON.stringify(event);
    expect(event).toEqual({
      agent: "hermes",
      model: "deepseek-v4-pro:cloud",
      taskId: "mission-1",
      inputTokens: 12,
      outputTokens: 8,
      ts: "2026-05-31T12:00:00.000Z",
    });
    expect(serialized).not.toContain("private operator prompt");
    expect(serialized).not.toContain("sk-should-never-appear");
    expect(serialized).not.toContain("also-nope");
  });
});
