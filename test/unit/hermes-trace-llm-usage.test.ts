import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  recordHermesLlmUsageFromTraceEvent,
  summarizeHermesTraceUsageDebugShape,
} from "../../packages/trace-mcp/src/hermes-llm-usage.js";

describe("Hermes trace LLM usage capture", () => {
  it("records usage from a Hermes post_llm_call response into the shared JSONL log", async () => {
    const dir = await mkdtemp(join(tmpdir(), "averray-hermes-trace-usage-"));
    try {
      const path = join(dir, "llm-usage.jsonl");
      const event = await recordHermesLlmUsageFromTraceEvent({
        kind: "post_llm_call",
        timestamp: "2026-06-01T12:00:00.000Z",
        payload: {
          run_id: "hermes-chat-1",
          request: {
            model: "deepseek-v4-pro:cloud",
            messages: [{ role: "user", content: "not copied" }],
          },
          response: {
            id: "chatcmpl-test",
            model: "deepseek-v4-pro:cloud",
            choices: [
              {
                message: { role: "assistant", content: "also not copied" },
              },
            ],
            usage: {
              prompt_tokens: 181,
              completion_tokens: 37,
            },
          },
        },
      }, { path });

      expect(event).toEqual({
        agent: "hermes",
        model: "deepseek-v4-pro:cloud",
        runId: "hermes-chat-1",
        inputTokens: 181,
        outputTokens: 37,
        ts: "2026-06-01T12:00:00.000Z",
      });
      const line = await readFile(path, "utf8");
      expect(JSON.parse(line)).toEqual(event);
      expect(line).not.toContain("not copied");
      expect(line).not.toContain("also not copied");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not write usage for pre-call traces or provider responses without counters", async () => {
    const dir = await mkdtemp(join(tmpdir(), "averray-hermes-trace-usage-"));
    try {
      const path = join(dir, "llm-usage.jsonl");
      await expect(recordHermesLlmUsageFromTraceEvent({
        kind: "pre_llm_call",
        payload: { request: { model: "deepseek-v4-pro:cloud" } },
      }, { path })).resolves.toBeUndefined();
      await expect(recordHermesLlmUsageFromTraceEvent({
        kind: "post_llm_call",
        payload: {
          request: { model: "deepseek-v4-pro:cloud" },
          response: { choices: [{ message: { content: "no counters" } }] },
        },
      }, { path })).resolves.toBeUndefined();
      await expect(readFile(path, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("summarizes debug shape without message content", () => {
    const summary = summarizeHermesTraceUsageDebugShape({
      kind: "post_llm_call",
      payload: {
        response: {
          choices: [
            {
              message: {
                content: "private prompt/result",
                usage: {
                  prompt_eval_count: 44,
                  eval_count: 12,
                },
              },
            },
          ],
        },
      },
    });

    expect(summary).toMatchObject({
      topLevelKeys: ["kind", "payload"],
      payloadKeys: ["response"],
      present: {
        "payload.response.choices[0].message.usage": {
          prompt_eval_count: 44,
          eval_count: 12,
        },
      },
    });
    expect(JSON.stringify(summary)).not.toContain("private prompt/result");
  });
});
