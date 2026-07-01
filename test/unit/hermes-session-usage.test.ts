import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  extractTurnModel,
  extractTurnUsage,
  runHermesSessionTurn,
  type HermesSessionConfig,
} from "../../services/slack-operator/src/hermes-session-client.js";
import {
  generateHermesReplyViaSession,
  type HermesReplyContext,
} from "../../services/slack-operator/src/monitor-hermes-voice.js";

const CHAT_RESPONSE = {
  object: "hermes.session.chat.completion",
  session_id: "s1",
  message: { role: "assistant", content: "Two cards await your review." },
  usage: { input_tokens: 21675, output_tokens: 388, total_tokens: 22063 },
};

function fetchReturning(body: unknown): typeof fetch {
  return (async () => ({ ok: true, status: 200, json: async () => body })) as unknown as typeof fetch;
}

describe("session usage extraction", () => {
  it("extractTurnUsage returns the raw usage block, else null", () => {
    expect(extractTurnUsage(CHAT_RESPONSE)).toEqual({ input_tokens: 21675, output_tokens: 388, total_tokens: 22063 });
    expect(extractTurnUsage({ message: { content: "x" } })).toBeNull();
    expect(extractTurnUsage(null)).toBeNull();
  });

  it("extractTurnModel reads model where reported, else null", () => {
    expect(extractTurnModel({ model: "deepseek" })).toBe("deepseek");
    expect(extractTurnModel({ usage: { model: "glm-5.2" } })).toBe("glm-5.2");
    expect(extractTurnModel(CHAT_RESPONSE)).toBeNull();
  });

  it("runHermesSessionTurn carries usage alongside the reply text", async () => {
    const cfg: HermesSessionConfig = { baseUrl: "http://gw", apiToken: "t", fetchFn: fetchReturning(CHAT_RESPONSE) };
    const turn = await runHermesSessionTurn(cfg, "s1", "hi");
    expect(turn?.text).toContain("cards");
    expect(turn?.usage).toEqual({ input_tokens: 21675, output_tokens: 388, total_tokens: 22063 });
  });
});

describe("generateHermesReplyViaSession records the agentic turn's usage", () => {
  let dir = "";
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("writes an LlmUsageEvent with the turn's tokens to the usage log", async () => {
    dir = mkdtempSync(join(tmpdir(), "hermes-usage-"));
    const path = join(dir, "usage.jsonl");
    const context: HermesReplyContext = {
      operatorMessage: { text: "status?", addressedTo: "hermes", kind: "chat" },
      recentMessages: [],
    };
    const cfg: HermesSessionConfig = { baseUrl: "http://gw", apiToken: "t", fetchFn: fetchReturning(CHAT_RESPONSE) };

    const turn = await generateHermesReplyViaSession(context, cfg, "s1", {
      model: "deepseek-v4-pro:cloud",
      usageLogPath: path,
    });
    expect(turn?.text).toBeTruthy();

    const lines = readFileSync(path, "utf8").trim().split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);
    const event = JSON.parse(lines[0]!);
    expect(event.agent).toBe("hermes");
    expect(event.model).toBe("deepseek-v4-pro:cloud");
    expect(event.inputTokens).toBe(21675);
    expect(event.outputTokens).toBe(388);
  });

  it("does not throw and records nothing when the gateway fails", async () => {
    dir = mkdtempSync(join(tmpdir(), "hermes-usage-"));
    const path = join(dir, "usage.jsonl");
    const context: HermesReplyContext = {
      operatorMessage: { text: "status?", addressedTo: "hermes", kind: "chat" },
      recentMessages: [],
    };
    const cfg: HermesSessionConfig = {
      baseUrl: "http://gw",
      apiToken: "t",
      fetchFn: (async () => ({ ok: false, status: 502, json: async () => ({}) })) as unknown as typeof fetch,
    };
    const turn = await generateHermesReplyViaSession(context, cfg, "s1", { model: "m", usageLogPath: path });
    expect(turn).toBeNull();
    expect(() => readFileSync(path, "utf8")).toThrow(); // no file written
  });
});
