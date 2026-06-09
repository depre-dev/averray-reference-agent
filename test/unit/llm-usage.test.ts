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
            cache_creation_input_tokens: 10,
            cache_read_input_tokens: 5,
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
        cacheTokens: 15,
        ts: "2026-05-31T12:00:00.000Z",
      });
      expect(JSON.parse((await readFile(path, "utf8")).trim())).toEqual(event);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("aggregates per agent/model/day with call counts, cache tokens, and last-active time", () => {
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
        cacheTokens: 4,
        ts: "2026-05-31T02:00:00.000Z",
      },
      {
        agent: "claude",
        model: "claude-sonnet-4-5",
        taskId: "claude-task-2",
        inputTokens: 3,
        outputTokens: 2,
        ts: "2026-06-01T02:00:00.000Z",
      },
    ]);

    expect(aggregate).toMatchObject({
      status: "recorded",
      inputTokens: 33,
      outputTokens: 14,
      cacheTokens: 4,
      totalTokens: 51,
      costUsd: null,
      costStatus: "not_recorded",
      runs: 3,
      lastActiveAt: "2026-06-01T02:00:00.000Z",
    });
    expect(aggregate.byModel.find((entry) => entry.agent === "codex")).toMatchObject({
      model: "gpt-5-codex",
      totalTokens: 15,
      runs: 1,
      lastActiveAt: "2026-05-31T01:00:00.000Z",
      costUsd: null,
      costStatus: "not_recorded",
    });
    expect(aggregate.byDay.map((day) => day.day)).toEqual(["2026-06-01", "2026-05-31"]);
    expect(aggregate.byDay.find((day) => day.day === "2026-05-31")).toMatchObject({
      totalTokens: 46,
      costUsd: null,
    });
    expect(aggregate.sourceStatus.find((entry) => entry.agent === "claude")).toMatchObject({
      status: "recorded",
    });
    expect(aggregate.sourceStatus.find((entry) => entry.agent === "hermes")).toMatchObject({
      status: "not_reported",
      reason: "Hermes monitor replies may be templated when OLLAMA_API_KEY is unset; live Hermes agent usage is recorded from post_llm_call traces when provider counters are present.",
    });
  });

  it("extracts Claude SDK-style message usage and cache token aliases", () => {
    const event = llmUsageEventFromResult({
      agent: "claude",
      taskId: "task-sdk",
      ts: new Date("2026-05-31T12:00:00.000Z"),
      result: {
        messages: [
          {
            type: "assistant",
            model: "claude-sonnet-4-5",
            usage: {
              input_tokens: 75,
              output_tokens: 18,
              cache_read_input_tokens: 11,
            },
          },
        ],
      },
    });

    expect(event).toEqual({
      agent: "claude",
      model: "claude-sonnet-4-5",
      taskId: "task-sdk",
      inputTokens: 75,
      outputTokens: 18,
      cacheTokens: 11,
      ts: "2026-05-31T12:00:00.000Z",
    });
  });

  it("extracts Ollama response token counts", () => {
    const event = llmUsageEventFromResult({
      agent: "hermes",
      model: "deepseek-v4-pro:cloud",
      runId: "chat-1",
      ts: new Date("2026-05-31T12:00:00.000Z"),
      result: {
        model: "deepseek-v4-pro:cloud",
        response: "Watching it.",
        prompt_eval_count: 44,
        eval_count: 12,
      },
    });

    expect(event).toEqual({
      agent: "hermes",
      model: "deepseek-v4-pro:cloud",
      runId: "chat-1",
      inputTokens: 44,
      outputTokens: 12,
      ts: "2026-05-31T12:00:00.000Z",
    });
  });

  it("extracts top-level Ollama token counts from numeric strings and appends the event", async () => {
    const dir = await mkdtemp(join(tmpdir(), "averray-llm-usage-"));
    try {
      const path = join(dir, "llm-usage.jsonl");
      const nativeOllamaChatShape = {
        model: "deepseek-v4-pro:cloud",
        created_at: "2026-06-01T09:00:00.000Z",
        message: {
          role: "assistant",
          content: "redacted in usage events",
        },
        done: true,
        prompt_eval_count: "181",
        eval_count: "37",
      };

      const event = await recordLlmUsageFromResult({
        agent: "hermes",
        model: "deepseek-v4-pro:cloud",
        runId: "board-narration-1",
        ts: new Date("2026-06-01T09:00:00.000Z"),
        result: nativeOllamaChatShape,
      }, { path });

      expect(event).toEqual({
        agent: "hermes",
        model: "deepseek-v4-pro:cloud",
        runId: "board-narration-1",
        inputTokens: 181,
        outputTokens: 37,
        ts: "2026-06-01T09:00:00.000Z",
      });
      await expect(readFile(path, "utf8").then((line) => JSON.parse(line))).resolves.toEqual(event);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("extracts OpenAI-compatible usage from choices[0].usage", () => {
    const event = llmUsageEventFromResult({
      agent: "hermes",
      model: "deepseek-v4-pro:cloud",
      ts: new Date("2026-06-01T09:05:00.000Z"),
      result: {
        model: "deepseek-v4-pro:cloud",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "not copied" },
            usage: {
              prompt_tokens: 93,
              completion_tokens: 21,
              prompt_tokens_details: { cached_tokens: 7 },
            },
          },
        ],
      },
    });

    expect(event).toEqual({
      agent: "hermes",
      model: "deepseek-v4-pro:cloud",
      inputTokens: 93,
      outputTokens: 21,
      cacheTokens: 7,
      ts: "2026-06-01T09:05:00.000Z",
    });
  });

  it("extracts nested message.usage from provider chat responses", () => {
    const event = llmUsageEventFromResult({
      agent: "hermes",
      model: "deepseek-v4-pro:cloud",
      ts: new Date("2026-06-01T09:10:00.000Z"),
      result: {
        model: "deepseek-v4-pro:cloud",
        choices: [
          {
            message: {
              role: "assistant",
              content: "also not copied",
              usage: {
                prompt_eval_count: 64,
                eval_count: 15,
              },
            },
          },
        ],
      },
    });

    expect(event).toEqual({
      agent: "hermes",
      model: "deepseek-v4-pro:cloud",
      inputTokens: 64,
      outputTokens: 15,
      ts: "2026-06-01T09:10:00.000Z",
    });
  });

  it("extracts best-effort token counts from Codex CLI output when present", () => {
    const event = llmUsageEventFromResult({
      agent: "codex",
      model: "gpt-5-codex",
      taskId: "codex-task",
      ts: new Date("2026-05-31T12:00:00.000Z"),
      result: {
        stdout: "Model: gpt-5-codex\nInput tokens: 1,200\nOutput tokens: 340\n",
        stderr: "",
      },
    });

    expect(event).toEqual({
      agent: "codex",
      model: "gpt-5-codex",
      taskId: "codex-task",
      inputTokens: 1200,
      outputTokens: 340,
      ts: "2026-05-31T12:00:00.000Z",
    });
  });

  it("explains missing sources instead of exposing a dead not_recorded enum", () => {
    const aggregate = aggregateLlmUsage([]);

    expect(aggregate).toMatchObject({
      status: "not_recorded",
      message: "No LLM usage counters have been recorded yet. Sources stay not reported until a real provider or runner emits whitelisted counters.",
    });
    expect(aggregate.sourceStatus.find((entry) => entry.agent === "codex")).toMatchObject({
      status: "not_reported",
      reason: "Codex CLI does not report usage.",
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

  it("builds a real per-minute, per-model recent window from event timestamps", () => {
    const now = new Date("2026-06-09T12:30:00.000Z"); // window start = 11:30:00
    const aggregate = aggregateLlmUsage(
      [
        { agent: "hermes", model: "deepseek-v4-pro", inputTokens: 50, outputTokens: 10, ts: "2026-06-09T11:30:30.000Z" }, // idx 0 → 60
        { agent: "hermes", model: "deepseek-v4-pro", inputTokens: 100, outputTokens: 20, ts: "2026-06-09T12:29:30.000Z" }, // idx 59 → 120
        { agent: "claude", model: "claude-sonnet-4-6", inputTokens: 30, outputTokens: 5, ts: "2026-06-09T12:29:45.000Z" }, // idx 59 → 35
      ],
      { now, recentWindowMinutes: 60 },
    );
    expect(aggregate.recent).not.toBeNull();
    expect(aggregate.recent!.windowMinutes).toBe(60);
    expect(aggregate.recent!.endsAt).toBe("2026-06-09T12:30:00.000Z");
    const hermes = aggregate.recent!.series.find((s) => s.agent === "hermes");
    expect(hermes!.points).toHaveLength(60);
    expect(hermes!.points[0]).toBe(60);
    expect(hermes!.points[59]).toBe(120);
    const claude = aggregate.recent!.series.find((s) => s.agent === "claude");
    expect(claude!.points[59]).toBe(35);
  });

  it("returns recent: null without a clock to anchor the window", () => {
    const aggregate = aggregateLlmUsage([
      { agent: "hermes", model: "x", inputTokens: 1, outputTokens: 1, ts: "2026-06-09T12:00:00.000Z" },
    ]);
    expect(aggregate.recent).toBeNull();
  });

  it("returns recent: null when no events fall inside the window", () => {
    const now = new Date("2026-06-09T12:30:00.000Z");
    const aggregate = aggregateLlmUsage(
      [{ agent: "hermes", model: "x", inputTokens: 1, outputTokens: 1, ts: "2026-06-01T00:00:00.000Z" }],
      { now },
    );
    expect(aggregate.recent).toBeNull();
  });
});
