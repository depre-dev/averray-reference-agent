import { describe, expect, it } from "vitest";

import {
  generateHermesReplyViaSession,
  resolveHermesSessionConfig,
  type HermesReplyContext,
} from "../../services/slack-operator/src/monitor-hermes-voice.js";

describe("resolveHermesSessionConfig", () => {
  const base = {
    HERMES_API_URL: "http://hermes-gateway:8642",
    HERMES_API_TOKEN: "gwkey",
  } as NodeJS.ProcessEnv;

  it("returns null when the flag is unset (default = Ollama transport)", () => {
    expect(resolveHermesSessionConfig({ ...base })).toBeNull();
  });

  it("returns null when enabled but URL or token is missing (fail-closed)", () => {
    expect(resolveHermesSessionConfig({ HERMES_SESSION_API_ENABLED: "1", HERMES_API_TOKEN: "gwkey" })).toBeNull();
    expect(resolveHermesSessionConfig({ HERMES_SESSION_API_ENABLED: "1", HERMES_API_URL: "http://gw" })).toBeNull();
  });

  it("resolves a config when enabled with URL + token", () => {
    const cfg = resolveHermesSessionConfig({ ...base, HERMES_SESSION_API_ENABLED: "1" });
    expect(cfg).toEqual({ baseUrl: "http://hermes-gateway:8642", apiToken: "gwkey" });
  });

  it("accepts truthy flag spellings and rejects falsey ones", () => {
    for (const on of ["1", "true", "YES", "On"]) {
      expect(resolveHermesSessionConfig({ ...base, HERMES_SESSION_API_ENABLED: on })).not.toBeNull();
    }
    for (const off of ["0", "false", "", "no"]) {
      expect(resolveHermesSessionConfig({ ...base, HERMES_SESSION_API_ENABLED: off })).toBeNull();
    }
  });

  it("carries a positive numeric timeout override", () => {
    const cfg = resolveHermesSessionConfig({ ...base, HERMES_SESSION_API_ENABLED: "1", HERMES_SESSION_TIMEOUT_MS: "30000" });
    expect(cfg?.timeoutMs).toBe(30000);
    const noTimeout = resolveHermesSessionConfig({ ...base, HERMES_SESSION_API_ENABLED: "1", HERMES_SESSION_TIMEOUT_MS: "oops" });
    expect(noTimeout && "timeoutMs" in noTimeout).toBe(false);
  });
});

describe("generateHermesReplyViaSession", () => {
  const context: HermesReplyContext = {
    operatorMessage: { text: "what's the state of the board?", addressedTo: "hermes", kind: "chat" },
    recentMessages: [],
  };

  function fetchReturning(body: unknown, ok = true): typeof fetch {
    return (async () => ({ ok, status: ok ? 200 : 500, json: async () => body })) as unknown as typeof fetch;
  }

  it("returns the session reply + id via the real-agent transport", async () => {
    const cfg = {
      baseUrl: "http://gw:8642",
      apiToken: "tok",
      fetchFn: fetchReturning({ session: { id: "s9" }, message: { content: "Operator review has 2 cards waiting on you." } }),
    };
    const turn = await generateHermesReplyViaSession(context, cfg);
    expect(turn?.sessionId).toBe("s9");
    expect(turn?.text).toContain("Operator review");
  });

  it("returns null when the gateway is unreachable (caller falls back to Ollama)", async () => {
    const cfg = { baseUrl: "http://gw:8642", apiToken: "tok", fetchFn: fetchReturning({}, false) };
    expect(await generateHermesReplyViaSession(context, cfg)).toBeNull();
  });
});
