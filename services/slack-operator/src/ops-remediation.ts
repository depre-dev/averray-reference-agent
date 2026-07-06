// Ops auto-remediation — the safe, opt-in, allowlisted harness.
//
// See docs/OPS_AUTO_REMEDIATION.md. This is the ONE ops capability that acts
// rather than just suggests, so it is deliberately narrow:
//   • OFF by default (a dedicated OPS_AUTOREMEDIATE_ENABLED switch).
//   • ONE allowlisted action in v1 — rpc_failover: rotate the monitor's OWN read
//     RPC off a flaky/1006 endpoint to a configured backup. Never touches funds,
//     never touches the product; fully reversible (rotate on).
//   • Edge-triggered + a circuit-breaker: once every endpoint has been tried and
//     none work, or the rate cap trips, it STOPS and escalates to a human.
//   • A verify-loop: the next cycle's RPC health decides resolve vs. escalate.
//
// The decision is PURE (decideRpcRemediation) so the whole state machine —
// gate, flap-guard, failover, breaker, rate-cap, resolve — is deterministic and
// unit-tested; index.ts owns the effect (rotate the active URL, dispatch alerts).

import type { AlertPayload } from "./alert-bridge.js";

export interface RemediationConfig {
  /** Master switch. OFF by default — nothing executes unless this is true. */
  enabled: boolean;
  /** [primary, ...backups]; failover cycles through these. */
  endpoints: string[];
  /** Consecutive unhealthy cycles on the active endpoint before we fail over
   *  (a flap guard — one hiccup never triggers an action). */
  failThreshold: number;
  /** Failovers since the last healthy cycle before the breaker trips + escalates. */
  maxAttempts: number;
  /** Max failovers within `windowMs` before the breaker trips (rate cap). */
  maxPerWindow: number;
  windowMs: number;
}

function numEnv(raw: string | undefined, fallback: number): number {
  const n = Number((raw ?? "").trim());
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Build the remediation config from env. `primaryRpc` is the monitor's configured
 *  read RPC; backups come from PRODUCT_HEALTH_RPC_BACKUPS (csv). */
export function loadRemediationConfig(
  env: Record<string, string | undefined>,
  primaryRpc: string | undefined,
): RemediationConfig {
  const backups = (env.PRODUCT_HEALTH_RPC_BACKUPS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const endpoints = [primaryRpc, ...backups].filter((x): x is string => !!x);
  return {
    enabled: (env.OPS_AUTOREMEDIATE_ENABLED ?? "").trim().toLowerCase() === "true",
    endpoints,
    failThreshold: numEnv(env.OPS_AUTOREMEDIATE_FAIL_THRESHOLD, 2),
    maxAttempts: numEnv(env.OPS_AUTOREMEDIATE_MAX_ATTEMPTS, 3),
    maxPerWindow: numEnv(env.OPS_AUTOREMEDIATE_MAX_PER_WINDOW, 5),
    windowMs: numEnv(env.OPS_AUTOREMEDIATE_WINDOW_MS, 3_600_000),
  };
}

export interface RpcRemediationState {
  /** Index into config.endpoints we are currently reading from. */
  activeIndex: number;
  /** Consecutive unhealthy cycles on the active endpoint. */
  failStreak: number;
  /** Failovers performed since the last healthy cycle (breaker budget). */
  failoversSinceHealthy: number;
  /** True once the breaker has tripped — we stop acting until health returns. */
  breakerTripped: boolean;
  /** Epoch-ms of recent failovers, for the rate cap. */
  windowActions: number[];
}

export function initialRpcRemediationState(): RpcRemediationState {
  return { activeIndex: 0, failStreak: 0, failoversSinceHealthy: 0, breakerTripped: false, windowActions: [] };
}

export type RpcRemediationOutcome =
  | { kind: "none" }
  | { kind: "failover"; from: string; to: string; reason: string }
  | { kind: "escalate"; reason: string }
  | { kind: "resolved"; endpoint: string };

/**
 * Decide the next auto-remediation step from the current RPC health. Pure.
 *
 * `rpcHealthy`: true = the active endpoint answered this cycle; false = it failed;
 * undefined = not judgeable (RPC/​signer not configured) → always `none`.
 *
 * Invariants: never acts while disabled; tolerates `failThreshold-1` hiccups;
 * fails over only to a configured backup; trips the breaker (→ escalate, then goes
 * quiet) on rate-cap, on exhausting the endpoints, or when there is no backup; and
 * a healthy cycle after any trouble resolves it (state reset, stays on the endpoint
 * that is currently working).
 */
export function decideRpcRemediation(input: {
  rpcHealthy: boolean | undefined;
  state: RpcRemediationState;
  config: RemediationConfig;
  nowMs: number;
}): { outcome: RpcRemediationOutcome; state: RpcRemediationState } {
  const { state, config, nowMs } = input;
  if (!config.enabled || input.rpcHealthy === undefined) {
    return { outcome: { kind: "none" }, state };
  }

  if (input.rpcHealthy) {
    if (state.failStreak > 0 || state.failoversSinceHealthy > 0 || state.breakerTripped) {
      // Reset the per-episode counters + breaker, but KEEP windowActions so the
      // rate cap still catches an endpoint that flaps (fail over → recover →
      // fail over …) many times within the window.
      return {
        outcome: { kind: "resolved", endpoint: config.endpoints[state.activeIndex] ?? "" },
        state: { ...state, failStreak: 0, failoversSinceHealthy: 0, breakerTripped: false },
      };
    }
    return { outcome: { kind: "none" }, state };
  }

  // Unhealthy. Once the breaker is tripped we stay quiet until health returns.
  if (state.breakerTripped) {
    return { outcome: { kind: "none" }, state };
  }

  const failStreak = state.failStreak + 1;
  if (failStreak < config.failThreshold) {
    return { outcome: { kind: "none" }, state: { ...state, failStreak } };
  }

  const trip = (reason: string): { outcome: RpcRemediationOutcome; state: RpcRemediationState } => ({
    outcome: { kind: "escalate", reason },
    state: { ...state, failStreak, breakerTripped: true },
  });

  const window = state.windowActions.filter((t) => nowMs - t < config.windowMs);
  if (config.endpoints.length <= 1) return trip("no backup RPC endpoint configured");
  if (window.length >= config.maxPerWindow) return trip(`rate cap — ${window.length} failovers within the window`);
  if (state.failoversSinceHealthy >= config.maxAttempts) {
    return trip(`tried ${state.failoversSinceHealthy} endpoints, still failing`);
  }

  const nextIndex = (state.activeIndex + 1) % config.endpoints.length;
  return {
    outcome: {
      kind: "failover",
      from: config.endpoints[state.activeIndex],
      to: config.endpoints[nextIndex],
      reason: `primary RPC unhealthy ${failStreak} cycles`,
    },
    state: {
      ...state,
      activeIndex: nextIndex,
      failStreak: 0,
      failoversSinceHealthy: state.failoversSinceHealthy + 1,
      windowActions: [...window, nowMs],
    },
  };
}

/** An alert for a remediation outcome — audit-level for a failover, page-level for
 *  an escalation. `null` for none/resolved (resolved is narrated, not paged). Pure. */
export function buildRemediationAlert(outcome: RpcRemediationOutcome, boardUrl: string): AlertPayload | null {
  if (outcome.kind === "failover") {
    return {
      count: 1,
      items: [{ id: "rpc-failover", title: `RPC failover → ${outcome.to}` }],
      boardUrl,
      text: `Auto-remediation: RPC failover — ${outcome.from} unhealthy (${outcome.reason}), rotated to ${outcome.to}. Reversible; monitor read-path only.`,
    };
  }
  if (outcome.kind === "escalate") {
    return {
      count: 1,
      items: [{ id: "rpc-escalate", title: "RPC auto-remediation halted" }],
      boardUrl,
      text: `Auto-remediation HALTED — ${outcome.reason}. The read RPC is still unhealthy and needs an operator.`,
    };
  }
  return null;
}

/** Board-facing snapshot of the remediation state, for the Ops "RPC failover" row. */
export interface RemediationStatus {
  /** off = disabled · armed = on primary, healthy · failover = reading a backup ·
   *  halted = breaker tripped, needs an operator. */
  state: "off" | "armed" | "failover" | "halted";
  enabled: boolean;
  /** The RPC endpoint currently in use. */
  activeEndpoint: string | null;
  onBackup: boolean;
  /** One-line board detail. */
  detail: string;
}

function hostOf(url: string | null): string {
  if (!url) return "—";
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** Derive the board status from the live config + state. Pure. `lastReason` is the
 *  most recent failover/escalate reason (index.ts threads it) for the halted line. */
export function describeRemediationStatus(input: {
  config: RemediationConfig;
  state: RpcRemediationState;
  lastReason?: string;
}): RemediationStatus {
  const active = input.config.endpoints[input.state.activeIndex] ?? input.config.endpoints[0] ?? null;
  const onBackup = input.state.activeIndex > 0;
  if (!input.config.enabled) {
    return { state: "off", enabled: false, activeEndpoint: active, onBackup, detail: "auto-remediation off" };
  }
  if (input.state.breakerTripped) {
    return {
      state: "halted",
      enabled: true,
      activeEndpoint: active,
      onBackup,
      detail: input.lastReason ? `halted — ${input.lastReason}` : "halted — RPC unhealthy, needs an operator",
    };
  }
  if (onBackup) {
    return { state: "failover", enabled: true, activeEndpoint: active, onBackup, detail: `reading backup ${hostOf(active)}` };
  }
  return { state: "armed", enabled: true, activeEndpoint: active, onBackup, detail: `armed · primary ${hostOf(active)}` };
}
