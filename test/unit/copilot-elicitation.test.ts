import { describe, expect, it } from "vitest";

import {
  COPILOT_ELICITATION_FLAG,
  GATEWAY_ELICITATION_SUPPORTED,
  handleElicitationRequest,
  isToolCallApproved,
  parseElicitationRequest,
  resolveCopilotElicitationConfig,
  resolveElicitationOutcome,
  type CopilotElicitationConfig,
  type ElicitationDecision,
  type ElicitationRequest,
} from "../../packages/averray-mcp/src/copilot-elicitation.js";

const REQUEST: ElicitationRequest = {
  id: "elc_1",
  sessionId: "sess_1",
  toolName: "averray_submit",
  summary: "Submit the proposal to the marketplace",
};

const APPROVE: ElicitationDecision = {
  requestId: "elc_1",
  decision: "approve",
  decidedBy: "operator",
};

const DENY: ElicitationDecision = {
  requestId: "elc_1",
  decision: "deny",
  decidedBy: "operator",
};

/** A config with the gateway pretended-supported, to exercise the FUTURE path. */
function supportedConfig(over: Partial<CopilotElicitationConfig> = {}): CopilotElicitationConfig {
  return { enabled: true, gatewaySupported: true, timeoutMs: 1000, ...over };
}

describe("resolveCopilotElicitationConfig — fail-closed env gate", () => {
  it("is OFF by default (unset flag)", () => {
    const cfg = resolveCopilotElicitationConfig({});
    expect(cfg.enabled).toBe(false);
  });

  it("stays OFF for 0 / empty / off / garbage", () => {
    for (const raw of ["0", "", " ", "off", "no", "false-ish", "2", "yes"]) {
      expect(resolveCopilotElicitationConfig({ [COPILOT_ELICITATION_FLAG]: raw }).enabled).toBe(false);
    }
  });

  it("turns ON only for explicit 1 / true (case/space tolerant)", () => {
    for (const raw of ["1", "true", "TRUE", " True "]) {
      expect(resolveCopilotElicitationConfig({ [COPILOT_ELICITATION_FLAG]: raw }).enabled).toBe(true);
    }
  });

  it("always reports the gateway as unsupported today, even when enabled", () => {
    const cfg = resolveCopilotElicitationConfig({ [COPILOT_ELICITATION_FLAG]: "1" });
    expect(cfg.gatewaySupported).toBe(false);
    expect(GATEWAY_ELICITATION_SUPPORTED).toBe(false);
  });

  it("reads a positive timeout override, else defaults", () => {
    expect(
      resolveCopilotElicitationConfig({
        [COPILOT_ELICITATION_FLAG]: "1",
        HERMES_COPILOT_ELICITATION_TIMEOUT_MS: "5000",
      }).timeoutMs
    ).toBe(5000);
    // bad values fall back to the default (non-zero)
    expect(
      resolveCopilotElicitationConfig({ HERMES_COPILOT_ELICITATION_TIMEOUT_MS: "-1" }).timeoutMs
    ).toBeGreaterThan(0);
    expect(
      resolveCopilotElicitationConfig({ HERMES_COPILOT_ELICITATION_TIMEOUT_MS: "abc" }).timeoutMs
    ).toBeGreaterThan(0);
  });
});

describe("resolveElicitationOutcome — the fail-closed truth table", () => {
  it("DENY (feature-disabled) when the flag is off — even with an explicit approve", () => {
    const out = resolveElicitationOutcome({
      config: { enabled: false, gatewaySupported: false, timeoutMs: 1000 },
      request: REQUEST,
      decision: APPROVE,
      deliveredOk: true,
    });
    expect(out).toEqual({ gated: false, decision: "deny", reason: "feature-disabled" });
  });

  it("DENY (no-gateway-support) when enabled but the gateway can't be answered — even with a delivered approve", () => {
    const out = resolveElicitationOutcome({
      config: { enabled: true, gatewaySupported: false, timeoutMs: 1000 },
      request: REQUEST,
      decision: APPROVE,
      deliveredOk: true,
    });
    expect(out).toEqual({ gated: false, decision: "deny", reason: "no-gateway-support" });
  });

  it("DENY (no-request) when there is nothing to gate", () => {
    const out = resolveElicitationOutcome({
      config: supportedConfig(),
      request: null,
      decision: APPROVE,
      deliveredOk: true,
    });
    expect(out.decision).toBe("deny");
    expect(out.reason).toBe("no-request");
  });

  it("DENY (no-operator-response) on operator silence — the core never-auto-approve guarantee", () => {
    const out = resolveElicitationOutcome({
      config: supportedConfig(),
      request: REQUEST,
      decision: null,
      deliveredOk: false,
    });
    expect(out).toEqual({ gated: false, decision: "deny", reason: "no-operator-response" });
  });

  it("DENY (timeout) when the window elapsed, regardless of a late answer", () => {
    const out = resolveElicitationOutcome({
      config: supportedConfig(),
      request: REQUEST,
      decision: APPROVE,
      deliveredOk: true,
      timedOut: true,
    });
    expect(out.decision).toBe("deny");
    expect(out.reason).toBe("timeout");
  });

  it("DENY (no-operator-response) when the answer is for a different request id", () => {
    const out = resolveElicitationOutcome({
      config: supportedConfig(),
      request: REQUEST,
      decision: { ...APPROVE, requestId: "some-other-id" },
      deliveredOk: true,
    });
    expect(out.decision).toBe("deny");
    expect(out.reason).toBe("no-operator-response");
  });

  it("DENY (operator-denied) on an explicit deny — and it IS gated", () => {
    const out = resolveElicitationOutcome({
      config: supportedConfig(),
      request: REQUEST,
      decision: DENY,
      deliveredOk: false,
    });
    expect(out).toEqual({ gated: true, decision: "deny", reason: "operator-denied" });
  });

  it("DENY (delivery-unreachable) when an approve could not be delivered to the gateway", () => {
    const out = resolveElicitationOutcome({
      config: supportedConfig(),
      request: REQUEST,
      decision: APPROVE,
      deliveredOk: false,
    });
    expect(out.decision).toBe("deny");
    expect(out.reason).toBe("delivery-unreachable");
  });

  it("APPROVE only on enabled + supported + explicit approve + delivered", () => {
    const out = resolveElicitationOutcome({
      config: supportedConfig(),
      request: REQUEST,
      decision: APPROVE,
      deliveredOk: true,
    });
    expect(out).toEqual({ gated: true, decision: "approve", reason: "operator-approved" });
    expect(isToolCallApproved(out)).toBe(true);
  });

  it("there is NO input combination without an explicit approve that yields approve", () => {
    // Exhaustively sweep the decision-less / deny / undelivered space and assert
    // none of it ever produces an approval.
    const configs: CopilotElicitationConfig[] = [
      { enabled: false, gatewaySupported: false, timeoutMs: 1000 },
      { enabled: true, gatewaySupported: false, timeoutMs: 1000 },
      supportedConfig(),
    ];
    const decisions: (ElicitationDecision | null)[] = [null, DENY];
    for (const config of configs) {
      for (const decision of decisions) {
        for (const deliveredOk of [false, true]) {
          for (const timedOut of [false, true]) {
            const out = resolveElicitationOutcome({
              config,
              request: REQUEST,
              decision,
              deliveredOk,
              timedOut,
            });
            expect(out.decision).toBe("deny");
            expect(isToolCallApproved(out)).toBe(false);
          }
        }
      }
    }
  });
});

describe("handleElicitationRequest — degraded-safe no-op handler (today)", () => {
  it("never engages the operator or the gateway while the flag is OFF", async () => {
    let collectCalls = 0;
    let deliverCalls = 0;
    const out = await handleElicitationRequest(REQUEST, resolveCopilotElicitationConfig({}), {
      collectDecision: async () => {
        collectCalls++;
        return APPROVE;
      },
      deliverDecision: async () => {
        deliverCalls++;
        return true;
      },
    });
    expect(out).toEqual({ gated: false, decision: "deny", reason: "feature-disabled" });
    expect(collectCalls).toBe(0);
    expect(deliverCalls).toBe(0);
  });

  it("even when ENABLED, does not engage hooks and falls closed (no gateway support today)", async () => {
    let collectCalls = 0;
    let deliverCalls = 0;
    const out = await handleElicitationRequest(
      REQUEST,
      resolveCopilotElicitationConfig({ [COPILOT_ELICITATION_FLAG]: "1" }),
      {
        collectDecision: async () => {
          collectCalls++;
          return APPROVE;
        },
        deliverDecision: async () => {
          deliverCalls++;
          return true;
        },
      }
    );
    // Real product config can never reach an approval today.
    expect(out).toEqual({ gated: false, decision: "deny", reason: "no-gateway-support" });
    expect(isToolCallApproved(out)).toBe(false);
    expect(collectCalls).toBe(0);
    expect(deliverCalls).toBe(0);
  });

  it("with a null request, returns a fail-closed DENY", async () => {
    const out = await handleElicitationRequest(
      null,
      resolveCopilotElicitationConfig({ [COPILOT_ELICITATION_FLAG]: "1" })
    );
    expect(out.decision).toBe("deny");
    expect(out.gated).toBe(false);
  });

  // The following exercise the FUTURE wired path (gateway pretended-supported)
  // to prove the handler itself stays fail-closed once support lands.
  it("[future path] fails closed to DENY when the operator does not answer", async () => {
    const out = await handleElicitationRequest(REQUEST, supportedConfig(), {
      collectDecision: async () => null, // operator silent / timeout
    });
    expect(out.decision).toBe("deny");
    expect(out.reason).toBe("timeout");
  });

  it("[future path] fails closed to DENY when collecting the decision throws", async () => {
    const out = await handleElicitationRequest(REQUEST, supportedConfig(), {
      collectDecision: async () => {
        throw new Error("rail unreachable");
      },
    });
    expect(out.decision).toBe("deny");
    expect(isToolCallApproved(out)).toBe(false);
  });

  it("[future path] fails closed to DENY when an approve cannot be delivered", async () => {
    const out = await handleElicitationRequest(REQUEST, supportedConfig(), {
      collectDecision: async () => APPROVE,
      deliverDecision: async () => false, // gateway unreachable
    });
    expect(out.decision).toBe("deny");
    expect(out.reason).toBe("delivery-unreachable");
  });

  it("[future path] fails closed to DENY when delivery throws", async () => {
    const out = await handleElicitationRequest(REQUEST, supportedConfig(), {
      collectDecision: async () => APPROVE,
      deliverDecision: async () => {
        throw new Error("boom");
      },
    });
    expect(out.decision).toBe("deny");
  });

  it("[future path] honours an explicit operator DENY (gated)", async () => {
    const out = await handleElicitationRequest(REQUEST, supportedConfig(), {
      collectDecision: async () => DENY,
    });
    expect(out).toEqual({ gated: true, decision: "deny", reason: "operator-denied" });
  });

  it("[future path] approves ONLY on explicit approve + confirmed delivery", async () => {
    const out = await handleElicitationRequest(REQUEST, supportedConfig(), {
      collectDecision: async () => APPROVE,
      deliverDecision: async () => true,
    });
    expect(out).toEqual({ gated: true, decision: "approve", reason: "operator-approved" });
    expect(isToolCallApproved(out)).toBe(true);
  });
});

describe("parseElicitationRequest — strict, fail-closed parser", () => {
  it("returns null for non-objects and empties", () => {
    for (const bad of [null, undefined, 42, "x", [], true]) {
      expect(parseElicitationRequest(bad)).toBeNull();
    }
  });

  it("returns null for ordinary stream events (assistant.delta / run.completed)", () => {
    expect(parseElicitationRequest({ type: "assistant.delta", message_id: "m1", delta: "hi" })).toBeNull();
    expect(parseElicitationRequest({ type: "run.completed", session_id: "s1" })).toBeNull();
  });

  it("returns null when the discriminator is right but required fields are missing", () => {
    expect(parseElicitationRequest({ type: "tool.confirmation" })).toBeNull();
    expect(parseElicitationRequest({ type: "tool.confirmation", id: "e1" })).toBeNull();
    expect(parseElicitationRequest({ type: "tool.confirmation", id: "e1", session_id: "s1" })).toBeNull();
  });

  it("parses a well-formed tool.confirmation frame", () => {
    const req = parseElicitationRequest({
      type: "tool.confirmation",
      id: "e1",
      session_id: "s1",
      tool_name: "averray_submit",
      summary: "Submit proposal",
      arguments: { jobId: "j1" },
      expires_at_ms: 123,
    });
    expect(req).toEqual({
      id: "e1",
      sessionId: "s1",
      toolName: "averray_submit",
      summary: "Submit proposal",
      arguments: { jobId: "j1" },
      expiresAtMs: 123,
    });
  });

  it("accepts the elicitation.request alias and synthesizes a summary when absent", () => {
    const req = parseElicitationRequest({
      event: "elicitation.request",
      request_id: "e2",
      sessionId: "s2",
      toolName: "averray_claim",
    });
    expect(req?.toolName).toBe("averray_claim");
    expect(req?.summary).toContain("averray_claim");
  });
});
