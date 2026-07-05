import { describe, expect, it } from "vitest";
import {
  decideRpcRemediation,
  initialRpcRemediationState,
  buildRemediationAlert,
  loadRemediationConfig,
  type RemediationConfig,
} from "../../services/slack-operator/src/ops-remediation.js";

const cfg = (over: Partial<RemediationConfig> = {}): RemediationConfig => ({
  enabled: true,
  endpoints: ["rpc-a", "rpc-b", "rpc-c"],
  failThreshold: 2,
  maxAttempts: 3,
  maxPerWindow: 5,
  windowMs: 3_600_000,
  ...over,
});

describe("decideRpcRemediation", () => {
  it("never acts while disabled, even when unhealthy", () => {
    const r = decideRpcRemediation({ rpcHealthy: false, state: initialRpcRemediationState(), config: cfg({ enabled: false }), nowMs: 0 });
    expect(r.outcome.kind).toBe("none");
  });

  it("does nothing when health is unjudgeable (RPC not configured)", () => {
    const r = decideRpcRemediation({ rpcHealthy: undefined, state: initialRpcRemediationState(), config: cfg(), nowMs: 0 });
    expect(r.outcome.kind).toBe("none");
  });

  it("tolerates a single hiccup below the flap threshold", () => {
    const r = decideRpcRemediation({ rpcHealthy: false, state: initialRpcRemediationState(), config: cfg(), nowMs: 0 });
    expect(r.outcome.kind).toBe("none");
    expect(r.state.failStreak).toBe(1);
  });

  it("fails over to the next endpoint once the flap threshold is met", () => {
    const s = decideRpcRemediation({ rpcHealthy: false, state: initialRpcRemediationState(), config: cfg(), nowMs: 0 }).state;
    const r = decideRpcRemediation({ rpcHealthy: false, state: s, config: cfg(), nowMs: 1000 });
    expect(r.outcome).toMatchObject({ kind: "failover", from: "rpc-a", to: "rpc-b" });
    expect(r.state.activeIndex).toBe(1);
    expect(r.state.failoversSinceHealthy).toBe(1);
    expect(r.state.failStreak).toBe(0);
    expect(r.state.windowActions).toHaveLength(1);
  });

  it("resolves + resets on a healthy cycle, staying on the endpoint that works", () => {
    const troubled = { ...initialRpcRemediationState(), activeIndex: 1, failoversSinceHealthy: 1, failStreak: 1, windowActions: [500] };
    const r = decideRpcRemediation({ rpcHealthy: true, state: troubled, config: cfg(), nowMs: 1000 });
    expect(r.outcome).toEqual({ kind: "resolved", endpoint: "rpc-b" });
    expect(r.state.activeIndex).toBe(1);
    expect(r.state.failoversSinceHealthy).toBe(0);
    expect(r.state.breakerTripped).toBe(false);
    expect(r.state.windowActions).toEqual([500]); // kept — the rate cap must still see past flaps
  });

  it("escalates at the threshold when there is no backup endpoint", () => {
    const c = cfg({ endpoints: ["rpc-a"] });
    const s = decideRpcRemediation({ rpcHealthy: false, state: initialRpcRemediationState(), config: c, nowMs: 0 }).state;
    const r = decideRpcRemediation({ rpcHealthy: false, state: s, config: c, nowMs: 1 });
    expect(r.outcome).toMatchObject({ kind: "escalate" });
    expect(r.state.breakerTripped).toBe(true);
  });

  it("trips the breaker once the failover budget is exhausted", () => {
    const s = { ...initialRpcRemediationState(), failoversSinceHealthy: 3, failStreak: 1 };
    const r = decideRpcRemediation({ rpcHealthy: false, state: s, config: cfg(), nowMs: 0 });
    expect(r.outcome).toMatchObject({ kind: "escalate", reason: expect.stringContaining("still failing") });
    expect(r.state.breakerTripped).toBe(true);
  });

  it("trips the breaker on the rate cap (flapping across recover cycles)", () => {
    const s = { ...initialRpcRemediationState(), failStreak: 1, windowActions: [1, 2, 3, 4, 5] };
    const r = decideRpcRemediation({ rpcHealthy: false, state: s, config: cfg(), nowMs: 10 });
    expect(r.outcome).toMatchObject({ kind: "escalate", reason: expect.stringContaining("rate cap") });
  });

  it("stays quiet once the breaker is tripped, until health returns", () => {
    const tripped = { ...initialRpcRemediationState(), breakerTripped: true, failStreak: 5 };
    expect(decideRpcRemediation({ rpcHealthy: false, state: tripped, config: cfg(), nowMs: 0 }).outcome.kind).toBe("none");
    const recovered = decideRpcRemediation({ rpcHealthy: true, state: tripped, config: cfg(), nowMs: 0 });
    expect(recovered.outcome.kind).toBe("resolved");
    expect(recovered.state.breakerTripped).toBe(false);
  });
});

describe("buildRemediationAlert", () => {
  it("audits a failover, pages an escalation, and is silent for none/resolved", () => {
    expect(buildRemediationAlert({ kind: "failover", from: "a", to: "b", reason: "x" }, "url")?.text).toContain("failover");
    expect(buildRemediationAlert({ kind: "escalate", reason: "no backup" }, "url")?.text).toContain("HALTED");
    expect(buildRemediationAlert({ kind: "none" }, "url")).toBeNull();
    expect(buildRemediationAlert({ kind: "resolved", endpoint: "b" }, "url")).toBeNull();
  });
});

describe("loadRemediationConfig", () => {
  it("is off by default; endpoints = primary + csv backups", () => {
    const c = loadRemediationConfig({ PRODUCT_HEALTH_RPC_BACKUPS: "rpc-b, rpc-c" }, "rpc-a");
    expect(c.enabled).toBe(false);
    expect(c.endpoints).toEqual(["rpc-a", "rpc-b", "rpc-c"]);
  });

  it("enables only on an explicit 'true'", () => {
    expect(loadRemediationConfig({ OPS_AUTOREMEDIATE_ENABLED: "true" }, "rpc-a").enabled).toBe(true);
    expect(loadRemediationConfig({ OPS_AUTOREMEDIATE_ENABLED: "1" }, "rpc-a").enabled).toBe(false);
  });
});
