import { describe, expect, it, vi } from "vitest";

import {
  ClaudeWorkerAuthError,
  activeAuthRoute,
  assertAuthRouteOrHalt,
  budgetGate,
  buildClaudeInvocationEnv,
  parseDailyBudgetUsd,
  resolveAuthMode,
  verifyAuthRoute,
  type ClaudeWorkerAuthEnv,
} from "../../services/slack-operator/src/claude-worker-auth.js";

// A throwaway placeholder so a leaked value would be obvious in an assertion.
const FAKE_KEY = "sk-ant-FAKE-do-not-log";
const FAKE_TOKEN = "oauth-FAKE-do-not-log";

describe("resolveAuthMode", () => {
  it("defaults to sub when unset or empty", () => {
    expect(resolveAuthMode({})).toEqual({ mode: "sub" });
    expect(resolveAuthMode({ CLAUDE_WORKER_AUTH_MODE: "" })).toEqual({ mode: "sub" });
    expect(resolveAuthMode({ CLAUDE_WORKER_AUTH_MODE: "  SUB " })).toEqual({ mode: "sub" });
  });
  it("accepts explicit api (case-insensitive)", () => {
    expect(resolveAuthMode({ CLAUDE_WORKER_AUTH_MODE: "api" })).toEqual({ mode: "api" });
    expect(resolveAuthMode({ CLAUDE_WORKER_AUTH_MODE: "API" })).toEqual({ mode: "api" });
  });
  it("fails loud on an unrecognized mode (never guesses intent)", () => {
    const r = resolveAuthMode({ CLAUDE_WORKER_AUTH_MODE: "subscription" });
    expect("error" in r).toBe(true);
  });
});

describe("activeAuthRoute (key precedence)", () => {
  it("API key wins over the OAuth token", () => {
    expect(activeAuthRoute({ ANTHROPIC_API_KEY: FAKE_KEY, CLAUDE_CODE_OAUTH_TOKEN: FAKE_TOKEN })).toBe("api");
  });
  it("OAuth token → sub; nothing → none", () => {
    expect(activeAuthRoute({ CLAUDE_CODE_OAUTH_TOKEN: FAKE_TOKEN })).toBe("sub");
    expect(activeAuthRoute({})).toBe("none");
  });
});

describe("verifyAuthRoute", () => {
  it("sub (default) with an OAuth token and no API key → confirmed sub", () => {
    const r = verifyAuthRoute({ CLAUDE_CODE_OAUTH_TOKEN: FAKE_TOKEN });
    expect(r).toMatchObject({ ok: true, mode: "sub", activeRoute: "sub" });
  });

  it("FOOTGUN 1: intent sub + ANTHROPIC_API_KEY present → fails loud", () => {
    const r = verifyAuthRoute({ CLAUDE_WORKER_AUTH_MODE: "sub", CLAUDE_CODE_OAUTH_TOKEN: FAKE_TOKEN, ANTHROPIC_API_KEY: FAKE_KEY });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/ANTHROPIC_API_KEY is set/i);
  });

  it("FOOTGUN 2: intent sub + live probe says api (silent billing) → fails loud", () => {
    const r = verifyAuthRoute({ CLAUDE_WORKER_AUTH_MODE: "sub", CLAUDE_CODE_OAUTH_TOKEN: FAKE_TOKEN }, { probedRoute: "api" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/live route probe|active billing route is API/i);
  });

  it("sub with no OAuth token and no confirming probe → cannot confirm sub", () => {
    const r = verifyAuthRoute({ CLAUDE_WORKER_AUTH_MODE: "sub" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/CLAUDE_CODE_OAUTH_TOKEN/);
  });

  it("sub with no token but a probe confirming sub → ok", () => {
    const r = verifyAuthRoute({ CLAUDE_WORKER_AUTH_MODE: "sub" }, { probedRoute: "sub" });
    expect(r).toMatchObject({ ok: true, mode: "sub" });
  });

  it("api with a key → confirmed api", () => {
    const r = verifyAuthRoute({ CLAUDE_WORKER_AUTH_MODE: "api", ANTHROPIC_API_KEY: FAKE_KEY });
    expect(r).toMatchObject({ ok: true, mode: "api", activeRoute: "api" });
  });

  it("api with no key → fails loud", () => {
    const r = verifyAuthRoute({ CLAUDE_WORKER_AUTH_MODE: "api" });
    expect(r.ok).toBe(false);
  });

  it("never leaks the secret VALUE into the reason/message", () => {
    const confirmed = verifyAuthRoute({ CLAUDE_WORKER_AUTH_MODE: "api", ANTHROPIC_API_KEY: FAKE_KEY });
    const mismatch = verifyAuthRoute({ CLAUDE_WORKER_AUTH_MODE: "sub", CLAUDE_CODE_OAUTH_TOKEN: FAKE_TOKEN, ANTHROPIC_API_KEY: FAKE_KEY });
    const text = JSON.stringify(confirmed) + JSON.stringify(mismatch);
    expect(text).not.toContain(FAKE_KEY);
    expect(text).not.toContain(FAKE_TOKEN);
  });
});

describe("assertAuthRouteOrHalt", () => {
  it("on mismatch: refuses (throws), writes a misconfigured heartbeat, logs — no secret leak", async () => {
    const writeMisconfiguredHeartbeat = vi.fn();
    const logs: string[] = [];
    const env: ClaudeWorkerAuthEnv = { CLAUDE_WORKER_AUTH_MODE: "sub", CLAUDE_CODE_OAUTH_TOKEN: FAKE_TOKEN, ANTHROPIC_API_KEY: FAKE_KEY };
    await expect(
      assertAuthRouteOrHalt(env, "claude-task-runner", { writeMisconfiguredHeartbeat, log: (m) => logs.push(m) }),
    ).rejects.toBeInstanceOf(ClaudeWorkerAuthError);
    expect(writeMisconfiguredHeartbeat).toHaveBeenCalledTimes(1);
    expect(writeMisconfiguredHeartbeat.mock.calls[0][0]).toMatchObject({ runnerId: "claude-task-runner" });
    expect(writeMisconfiguredHeartbeat.mock.calls[0][0].reason).toMatch(/auth route check failed/);
    expect(logs.join("\n")).toMatch(/REFUSING TO RUN/);
    expect(logs.join("\n") + JSON.stringify(writeMisconfiguredHeartbeat.mock.calls)).not.toContain(FAKE_KEY);
  });

  it("on match: logs the confirmed route, returns the verification, no heartbeat write", async () => {
    const writeMisconfiguredHeartbeat = vi.fn();
    const logs: string[] = [];
    const result = await assertAuthRouteOrHalt(
      { CLAUDE_WORKER_AUTH_MODE: "sub", CLAUDE_CODE_OAUTH_TOKEN: FAKE_TOKEN },
      "claude-task-runner",
      { writeMisconfiguredHeartbeat, log: (m) => logs.push(m) },
    );
    expect(result.ok).toBe(true);
    expect(result.mode).toBe("sub");
    expect(writeMisconfiguredHeartbeat).not.toHaveBeenCalled();
    expect(logs.join("\n")).toMatch(/auth route confirmed: subscription/);
  });
});

describe("parseDailyBudgetUsd", () => {
  it("parses a positive number; rejects unset / non-positive / non-numeric", () => {
    expect(parseDailyBudgetUsd({ CLAUDE_WORKER_DAILY_BUDGET: "25" })).toBe(25);
    expect(parseDailyBudgetUsd({ CLAUDE_WORKER_DAILY_BUDGET: "12.5" })).toBe(12.5);
    expect(parseDailyBudgetUsd({})).toBeUndefined();
    expect(parseDailyBudgetUsd({ CLAUDE_WORKER_DAILY_BUDGET: "0" })).toBeUndefined();
    expect(parseDailyBudgetUsd({ CLAUDE_WORKER_DAILY_BUDGET: "-5" })).toBeUndefined();
    expect(parseDailyBudgetUsd({ CLAUDE_WORKER_DAILY_BUDGET: "lots" })).toBeUndefined();
  });
});

describe("budgetGate", () => {
  it("sub mode always allows claiming (no per-token charge)", () => {
    expect(budgetGate("sub", 9999, { CLAUDE_WORKER_DAILY_BUDGET: "1" })).toMatchObject({ allowClaim: true });
  });
  it("api mode under the cap allows; at/over the cap stops claiming", () => {
    const env = { CLAUDE_WORKER_DAILY_BUDGET: "20" };
    expect(budgetGate("api", 19.99, env)).toMatchObject({ allowClaim: true, capUsd: 20 });
    const stopped = budgetGate("api", 20, env);
    expect(stopped.allowClaim).toBe(false);
    expect(stopped.reason).toMatch(/daily budget reached/);
  });
  it("api mode with no budget set allows but flags reliance on the Console cap", () => {
    const gate = budgetGate("api", 100, {});
    expect(gate.allowClaim).toBe(true);
    expect(gate.reason).toMatch(/no CLAUDE_WORKER_DAILY_BUDGET set|Console cap/);
  });
});

describe("buildClaudeInvocationEnv", () => {
  it("strips ANTHROPIC_API_KEY in sub mode (no key leaks into the child)", () => {
    const out = buildClaudeInvocationEnv({ ANTHROPIC_API_KEY: FAKE_KEY, CLAUDE_CODE_OAUTH_TOKEN: FAKE_TOKEN, PATH: "/usr/bin" }, "sub");
    expect(out.ANTHROPIC_API_KEY).toBeUndefined();
    expect(out.CLAUDE_CODE_OAUTH_TOKEN).toBe(FAKE_TOKEN);
    expect(out.PATH).toBe("/usr/bin");
  });
  it("passes ANTHROPIC_API_KEY through in api mode", () => {
    const out = buildClaudeInvocationEnv({ ANTHROPIC_API_KEY: FAKE_KEY }, "api");
    expect(out.ANTHROPIC_API_KEY).toBe(FAKE_KEY);
  });
});
