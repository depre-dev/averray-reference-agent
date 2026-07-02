import { describe, expect, it, vi } from "vitest";

import type { HermesSessionConfig, HermesSessionTurn } from "../../services/slack-operator/src/hermes-session-client.js";
import {
  analyzeCardFailure,
  buildFailureAnalysisPrompt,
  failureContextFactLines,
  hasDiagnosableFailureDetail,
  hashFailureContext,
  type FailureAnalysisCard,
  type FailureAnalysisDeps,
} from "../../services/slack-operator/src/monitor-failure-analysis.js";

const FAILED_DEPLOY: FailureAnalysisCard = {
  id: "deploy-abc",
  title: "Deploy monitor stack",
  repo: "depre-dev/averray-reference-agent",
  verdict: "deploy failed",
  failureKind: "deploy verification",
  failedCheckNames: ["unit tests", "browser replay"],
  state: "failed-fetch",
};

const SESSION_CONFIG: HermesSessionConfig = { baseUrl: "http://gw:8642", apiToken: "tok" };

function turn(
  text: string,
  extra: { usage?: Record<string, unknown> | null; model?: string | null } = {},
): HermesSessionTurn {
  return {
    sessionId: "s1",
    text,
    ...(extra.usage !== undefined ? { usage: extra.usage } : {}),
    ...(extra.model !== undefined ? { model: extra.model } : {}),
  };
}

function deps(overrides: Partial<FailureAnalysisDeps> = {}): FailureAnalysisDeps {
  return {
    enabled: true,
    sessionConfig: SESSION_CONFIG,
    ...overrides,
  };
}

describe("failureContextFactLines — truth boundary (no fabrication)", () => {
  it("emits a line only for failure fields actually present on the card", () => {
    const lines = failureContextFactLines(FAILED_DEPLOY);
    expect(lines).toContain("Card: Deploy monitor stack");
    expect(lines).toContain("Repo: depre-dev/averray-reference-agent");
    expect(lines).toContain("Verdict: deploy failed");
    expect(lines).toContain("Failed checks: unit tests, browser replay");
    expect(lines).toContain("Card state: failed-fetch");
    expect(lines).toContain("Failure kind: deploy verification");
  });

  it("stays silent about absent fields — never invents a failure reason or source failure", () => {
    const sparse: FailureAnalysisCard = { id: "c1", title: "A bare failed card", failureKind: "codex task" };
    const lines = failureContextFactLines(sparse);
    const joined = lines.join("\n").toLowerCase();
    expect(joined).not.toContain("failure reason");
    expect(joined).not.toContain("source failure");
    expect(joined).not.toContain("failed checks");
    expect(joined).not.toContain("risk signals");
    // Only the present facts remain.
    expect(lines).toEqual(["Card: A bare failed card", "Failure kind: codex task"]);
  });

  it("threads a source failure only when it carries a real message", () => {
    const withSource: FailureAnalysisCard = {
      id: "c2",
      title: "Runner offline",
      sourceFailure: { source: "runner", code: "HEARTBEAT_LOST", message: "no heartbeat for 12m" },
    };
    expect(failureContextFactLines(withSource)).toContain("Source failure: runner [HEARTBEAT_LOST]: no heartbeat for 12m");
    const emptyMsg: FailureAnalysisCard = { id: "c3", title: "x", sourceFailure: { source: "runner", message: "  " } };
    expect(failureContextFactLines(emptyMsg).some((l) => l.startsWith("Source failure"))).toBe(false);
  });
});

describe("hasDiagnosableFailureDetail — skip the undiagnosable", () => {
  it("is true when the card carries a concrete failure detail", () => {
    expect(hasDiagnosableFailureDetail(FAILED_DEPLOY)).toBe(true);
    expect(hasDiagnosableFailureDetail({ id: "x", title: "t", failureReason: "OOM killed" })).toBe(true);
    expect(hasDiagnosableFailureDetail({ id: "x", title: "t", riskSignals: ["contract touched"] })).toBe(true);
  });

  it("is false for a bare 'failed' with no diagnosable context (would only invite a guess)", () => {
    expect(hasDiagnosableFailureDetail({ id: "x", title: "Failed", verdict: "failed", state: "failed-fetch" })).toBe(false);
  });
});

describe("buildFailureAnalysisPrompt — grounded prompt + guardrails", () => {
  it("threads every present failure fact and the no-fabrication + cause-unclear rules", () => {
    const prompt = buildFailureAnalysisPrompt(FAILED_DEPLOY);
    expect(prompt).toContain("depre-dev/averray-reference-agent");
    expect(prompt).toContain("deploy failed");
    expect(prompt).toContain("unit tests, browser replay");
    // truth guardrails present
    expect(prompt).toContain("Ground EVERY claim in the failure facts listed above");
    expect(prompt).toContain("Do not invent a root cause");
    expect(prompt).toContain('Cause unclear from the available signals.');
    expect(prompt).toContain("Never guess a cause to fill the gap");
    expect(prompt).toContain("fix or a rollback");
    expect(prompt).toContain("Do not claim you inspected logs");
  });

  it("does not name a failure signal the card lacks", () => {
    const prompt = buildFailureAnalysisPrompt({ id: "c", title: "Bare card", failureKind: "pull request" });
    expect(prompt).not.toMatch(/failure reason:/i);
    expect(prompt).not.toMatch(/failed checks:/i);
    expect(prompt).not.toMatch(/source failure:/i);
  });
});

describe("hashFailureContext — cache key changes iff the failure changes", () => {
  it("is stable for the same failure context", () => {
    expect(hashFailureContext(FAILED_DEPLOY)).toBe(hashFailureContext({ ...FAILED_DEPLOY }));
  });

  it("changes when a real failure field changes", () => {
    const before = hashFailureContext(FAILED_DEPLOY);
    expect(hashFailureContext({ ...FAILED_DEPLOY, failedCheckNames: ["unit tests"] })).not.toBe(before);
    expect(hashFailureContext({ ...FAILED_DEPLOY, verdict: "deploy failed (retry 2)" })).not.toBe(before);
  });
});

describe("analyzeCardFailure — agentic-only, degraded-safe", () => {
  it("runs the session, tags live, and threads the real failure facts into the prompt", async () => {
    const runSession = vi.fn(async () =>
      turn("Both unit tests and browser replay failed on this deploy, so the verification never went green; roll back to the last passing build and re-run before promoting."),
    );
    const result = await analyzeCardFailure(FAILED_DEPLOY, deps({ runSession }));

    expect(runSession).toHaveBeenCalledTimes(1);
    const [cfgArg, promptArg] = runSession.mock.calls[0]!;
    expect(cfgArg).toBe(SESSION_CONFIG);
    expect(promptArg).toContain("unit tests, browser replay");
    expect(result.hermesMode).toBe("live");
    expect(result.text).toContain("roll back");
  });

  it("is a no-op when the flag is off (default behavior) — no session, no text", async () => {
    const runSession = vi.fn(async () => turn("should not run"));
    const result = await analyzeCardFailure(FAILED_DEPLOY, deps({ enabled: false, runSession }));
    expect(runSession).not.toHaveBeenCalled();
    expect(result).toEqual({ text: "", hermesMode: "none" });
  });

  it("is a no-op when no gateway session config resolved (degraded)", async () => {
    const runSession = vi.fn(async () => turn("should not run"));
    const result = await analyzeCardFailure(FAILED_DEPLOY, deps({ sessionConfig: null, runSession }));
    expect(runSession).not.toHaveBeenCalled();
    expect(result.hermesMode).toBe("none");
  });

  it("produces NOTHING (never a fabricated cause) when the session returns null", async () => {
    const runSession = vi.fn(async () => null);
    const result = await analyzeCardFailure(FAILED_DEPLOY, deps({ runSession }));
    expect(result).toEqual({ text: "", hermesMode: "none" });
  });

  it("produces NOTHING when the session throws (never guesses on a gateway error)", async () => {
    const runSession = vi.fn(async () => {
      throw new Error("gateway down");
    });
    const result = await analyzeCardFailure(FAILED_DEPLOY, deps({ runSession }));
    expect(result.hermesMode).toBe("none");
    expect(result.text).toBe("");
  });

  it("treats a blank agentic reply as no analysis (never tags live off empty text)", async () => {
    const onSessionTurn = vi.fn();
    const runSession = vi.fn(async () => turn("   ", { usage: { input_tokens: 5 } }));
    const result = await analyzeCardFailure(FAILED_DEPLOY, deps({ runSession, onSessionTurn }));
    expect(result.hermesMode).toBe("none");
    // no usable text -> nothing to attribute here
    expect(onSessionTurn).not.toHaveBeenCalled();
  });

  it("honors the 'cause unclear' path verbatim when the model can't determine the cause", async () => {
    // The prompt REQUIRES this phrasing when signals are thin; the module surfaces
    // it verbatim rather than dropping or embellishing it.
    const runSession = vi.fn(async () =>
      turn("Cause unclear from the available signals. The safest next step is to open the failed check output before deciding to fix or roll back."),
    );
    const result = await analyzeCardFailure(FAILED_DEPLOY, deps({ runSession }));
    expect(result.hermesMode).toBe("live");
    expect(result.text).toContain("Cause unclear from the available signals.");
  });

  it("forwards the successful turn to onSessionTurn (usage) with its model captured", async () => {
    const onSessionTurn = vi.fn();
    const produced = turn("Grounded read of the failure.", { usage: { input_tokens: 120, output_tokens: 44 }, model: "hermes-4" });
    const runSession = vi.fn(async () => produced);
    const result = await analyzeCardFailure(FAILED_DEPLOY, deps({ runSession, onSessionTurn }));

    expect(result.hermesMode).toBe("live");
    expect(result.model).toBe("hermes-4");
    expect(onSessionTurn).toHaveBeenCalledTimes(1);
    expect(onSessionTurn).toHaveBeenCalledWith(produced);
  });
});
