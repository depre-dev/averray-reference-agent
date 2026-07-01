/**
 * Co-pilot MCP elicitation — GROUNDWORK (feature #4), NOT a live approval gate.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * TRUTH BOUNDARY — READ THIS FIRST
 * ────────────────────────────────────────────────────────────────────────────
 * The intended feature is: when the agentic Hermes co-pilot (reached over the
 * gateway Session API — see `services/slack-operator/src/hermes-session-client.ts`)
 * hits a tool call that needs human confirmation, surface an inline approve/deny
 * in the co-pilot rail instead of failing or silently proceeding.
 *
 * That feature is NOT possible yet, because the Hermes gateway does not expose
 * MCP elicitation. The confirmed Session API surface is create / chat / fork
 * (`hermes-session-client.ts:11-15`), and the only documented stream events are
 * `assistant.delta` and `run.completed` (`hermes-session-client.ts:21-23`).
 * There is:
 *   - NO stream event that says "the agent is waiting for you to approve a tool
 *     call" (an elicitation / tool-confirmation request), and
 *   - NO endpoint to send an approve/deny answer back to a pending tool call.
 * See `docs/HERMES_COPILOT_ELICITATION.md` for the exact gateway support required.
 *
 * So this module ships as GROUNDWORK behind an OFF-by-default flag:
 *   - the request/decision TYPES the real feature will use,
 *   - a FAIL-CLOSED env gate, and
 *   - a DEGRADED-SAFE, NO-OP handler that gates nothing today and — crucially —
 *     can NEVER autonomously approve a tool call.
 *
 * It does NOT fake a gate. With the flag off (default) it does nothing. Even
 * with the flag on, because there is no gateway answer channel and no live
 * elicitation stream, every path resolves to DENY. A tool call is only ever
 * "approved" when a real operator explicitly approves AND a real answer channel
 * confirms the answer was delivered to the gateway — a path that does not exist
 * until the gateway support in the design doc lands. Until then this stays a
 * dormant scaffold: no UI claims to gate what it cannot gate.
 *
 * This is deliberately a self-contained pure module (no `@avg/*` imports, env
 * passed in) so its safety properties are exhaustively unit-testable in
 * isolation — mirroring `hermes-session-client.ts`.
 */

/** Env flag name. Default OFF. */
export const COPILOT_ELICITATION_FLAG = "HERMES_COPILOT_ELICITATION";

/**
 * How an operator (or the absence of one) resolved a pending tool-confirmation.
 * There is no "auto" / "default-approve" — the only ways a call proceeds are an
 * explicit operator approval that we could actually deliver.
 */
export type ElicitationDecisionKind = "approve" | "deny";

/**
 * A pending tool-confirmation the agent is (hypothetically) blocked on. Field
 * names mirror the shape the gateway WOULD have to emit; see the design doc.
 * Everything the UI needs to render an honest approve/deny prompt.
 */
export interface ElicitationRequest {
  /** Stable id used to correlate the operator's answer back to this request. */
  id: string;
  /** The session this elicitation belongs to (Session API session id). */
  sessionId: string;
  /** MCP tool the agent wants to call, e.g. `averray_submit`. */
  toolName: string;
  /** Human-readable summary of what the tool would do (for the rail prompt). */
  summary: string;
  /** Raw proposed arguments, shown to the operator. Never trusted blindly. */
  arguments?: Record<string, unknown>;
  /**
   * Server-side deadline (epoch ms) after which the gateway itself abandons the
   * call. Advisory: we ALSO fail closed locally on our own timeout regardless.
   */
  expiresAtMs?: number;
}

/** An operator's explicit answer to a specific `ElicitationRequest`. */
export interface ElicitationDecision {
  /** Must match `ElicitationRequest.id`. */
  requestId: string;
  decision: ElicitationDecisionKind;
  /** Who answered (audit); operator identity, not the agent. */
  decidedBy: string;
  /** Optional operator note recorded with the decision. */
  reason?: string;
}

/**
 * The resolved outcome for a pending tool call. `gated` is whether THIS surface
 * actually took responsibility for the decision. When `gated` is false, this
 * module did NOT gate the call — it fell closed to a DENY recommendation and the
 * caller must treat the tool call as denied/aborted (never "proceed anyway").
 */
export interface ElicitationOutcome {
  /**
   * True only when this surface actively delivered an operator decision to the
   * gateway. False for every fail-closed / disabled / no-support path. It is
   * NEVER true today, because no delivery channel exists.
   */
  gated: boolean;
  /** The effective decision. Fail-closed paths always yield "deny". */
  decision: ElicitationDecisionKind;
  /** Machine-readable reason, for logs + the honesty banner in the rail. */
  reason: ElicitationOutcomeReason;
}

export type ElicitationOutcomeReason =
  /** Flag off (default): the surface is dormant. */
  | "feature-disabled"
  /** Flag on, but the gateway exposes no elicitation channel yet (today). */
  | "no-gateway-support"
  /** The request frame was absent or malformed — nothing to gate. */
  | "no-request"
  /** No operator answered within the window → fail closed. */
  | "no-operator-response"
  /** We had an operator answer but could not deliver it to the gateway. */
  | "delivery-unreachable"
  /** Local hard timeout elapsed → fail closed. */
  | "timeout"
  /** Operator explicitly denied. */
  | "operator-denied"
  /** Operator explicitly approved AND delivery to the gateway was confirmed. */
  | "operator-approved";

/** Resolved config for the elicitation surface. */
export interface CopilotElicitationConfig {
  /** Master switch. False ⇒ the whole surface is a no-op. */
  enabled: boolean;
  /**
   * Whether the gateway actually exposes an elicitation channel we can answer.
   * Hardcoded FALSE today: no such stream event or answer endpoint exists. When
   * the gateway support in the design doc lands, this becomes a real probe.
   */
  gatewaySupported: boolean;
  /** Local fail-closed timeout for an operator answer (ms). */
  timeoutMs: number;
}

/**
 * There is no gateway elicitation support today. This is a single, honest
 * source of truth the handler and tests key off, rather than sprinkling `false`
 * around. Flipping this to true is meaningless until the answer endpoint + the
 * stream event exist AND `deliverDecision` is implemented against them.
 */
export const GATEWAY_ELICITATION_SUPPORTED = false;

const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * FAIL-CLOSED env gate. Returns `enabled: false` unless the flag is explicitly
 * "1" / "true". Any other value (unset, "0", "", "off", garbage) ⇒ disabled.
 * Never throws.
 */
export function resolveCopilotElicitationConfig(
  env: Record<string, string | undefined> = process.env
): CopilotElicitationConfig {
  const raw = (env[COPILOT_ELICITATION_FLAG] ?? "").trim().toLowerCase();
  const enabled = raw === "1" || raw === "true";
  const timeoutMs = parsePositiveInt(env.HERMES_COPILOT_ELICITATION_TIMEOUT_MS) ?? DEFAULT_TIMEOUT_MS;
  return {
    enabled,
    // Even when the operator opts in, we tell the truth about the gateway.
    gatewaySupported: GATEWAY_ELICITATION_SUPPORTED,
    timeoutMs,
  };
}

/**
 * Tolerant parser for an elicitation request frame off the session stream.
 *
 * The gateway emits no such frame today, so in practice this returns null for
 * everything real. It exists so that (a) the type contract is exercised by
 * tests, and (b) when the gateway support lands, the stream reader has a single,
 * strict entry point that rejects anything not shaped like a real elicitation
 * request (fail closed: a malformed frame is NOT a gate-able request).
 */
export function parseElicitationRequest(frame: unknown): ElicitationRequest | null {
  const root = asRecord(frame);
  if (!root) return null;
  // Require an explicit elicitation discriminator so we never mistake an
  // ordinary `assistant.delta` / `run.completed` event for a tool prompt.
  const type = asText(root.type) ?? asText(root.event);
  if (type !== "tool.confirmation" && type !== "elicitation.request") return null;
  const id = asText(root.id) ?? asText(root.request_id) ?? asText(root.requestId);
  const sessionId = asText(root.session_id) ?? asText(root.sessionId);
  const toolName = asText(root.tool) ?? asText(root.tool_name) ?? asText(root.toolName);
  if (!id || !sessionId || !toolName) return null;
  const summary =
    asText(root.summary) ?? asText(root.description) ?? `Approve tool call: ${toolName}`;
  return {
    id,
    sessionId,
    toolName,
    summary,
    arguments: asRecord(root.arguments) ?? asRecord(root.args) ?? undefined,
    expiresAtMs: asPositiveNumber(root.expires_at_ms) ?? asPositiveNumber(root.expiresAtMs),
  };
}

/**
 * The fail-closed decision truth table, as a pure function so every branch is
 * unit-testable. A tool call proceeds ("approve") ONLY when:
 *   - the feature is enabled, AND
 *   - the gateway actually supports elicitation, AND
 *   - an operator explicitly approved, AND
 *   - that approval was actually delivered to the gateway (`deliveredOk`).
 * EVERY other combination — disabled, unsupported, no request, no operator
 * answer, undelivered, explicit deny — yields "deny". There is deliberately no
 * code path where the absence of an operator decision yields "approve".
 */
export function resolveElicitationOutcome(input: {
  config: CopilotElicitationConfig;
  request: ElicitationRequest | null;
  /** The operator's explicit answer, if one was collected in time. */
  decision: ElicitationDecision | null;
  /** Whether an approve answer was confirmed delivered to the gateway. */
  deliveredOk: boolean;
  /** True if the local/gateway timeout elapsed before an answer. */
  timedOut?: boolean;
}): ElicitationOutcome {
  const { config, request, decision, deliveredOk, timedOut } = input;

  // 1. Dormant by default.
  if (!config.enabled) return deny("feature-disabled");

  // 2. Honest about the gateway: with no elicitation channel we cannot gate.
  //    Fail closed to DENY — we never let the call proceed ungated.
  if (!config.gatewaySupported) return deny("no-gateway-support");

  // 3. Nothing to gate.
  if (!request) return deny("no-request");

  // 4. Hard timeout beats any stale answer.
  if (timedOut) return deny("timeout");

  // 5. No operator answered → fail closed. NEVER auto-approve on silence.
  if (!decision || decision.requestId !== request.id) return deny("no-operator-response");

  // 6. Explicit deny.
  if (decision.decision === "deny") {
    return { gated: true, decision: "deny", reason: "operator-denied" };
  }

  // 7. Explicit approve, but we must have actually delivered it.
  if (!deliveredOk) return deny("delivery-unreachable");

  // 8. The only proceed path: enabled + supported + explicit approve + delivered.
  return { gated: true, decision: "approve", reason: "operator-approved" };
}

/**
 * DEGRADED-SAFE no-op handler — the wired entry point behind the OFF flag.
 *
 * Today this ALWAYS resolves to a fail-closed DENY (never gates, never
 * approves): with the flag off it short-circuits on "feature-disabled", and
 * even when enabled it short-circuits on "no-gateway-support" because
 * `GATEWAY_ELICITATION_SUPPORTED` is false. The `collectDecision` /
 * `deliverDecision` seams are where the real implementation will plug in once
 * the gateway exposes the elicitation stream + answer endpoint (see the design
 * doc). They are intentionally NOT called while unsupported, so there is no way
 * for this to accidentally proceed.
 */
export async function handleElicitationRequest(
  request: ElicitationRequest | null,
  config: CopilotElicitationConfig,
  hooks?: {
    /** Collect the operator's explicit answer (rail approve/deny). */
    collectDecision?: (req: ElicitationRequest, timeoutMs: number) => Promise<ElicitationDecision | null>;
    /** Deliver an approve answer to the gateway; resolves true iff confirmed. */
    deliverDecision?: (decision: ElicitationDecision) => Promise<boolean>;
  }
): Promise<ElicitationOutcome> {
  // Short-circuit while dormant or unsupported — do NOT engage the operator or
  // the gateway. resolveElicitationOutcome returns DENY for both.
  if (!config.enabled || !config.gatewaySupported || !request) {
    return resolveElicitationOutcome({
      config,
      request,
      decision: null,
      deliveredOk: false,
    });
  }

  // --- Unreachable today (gatewaySupported is false) ------------------------
  // This is the shape the real path takes once support lands. Kept minimal and
  // still fail-closed: any thrown/absent step degrades to DENY.
  let decision: ElicitationDecision | null = null;
  let timedOut = false;
  try {
    decision = hooks?.collectDecision
      ? await hooks.collectDecision(request, config.timeoutMs)
      : null;
  } catch {
    decision = null; // fail closed
  }
  if (!decision) timedOut = true;

  let deliveredOk = false;
  if (decision?.decision === "approve") {
    try {
      deliveredOk = hooks?.deliverDecision ? await hooks.deliverDecision(decision) : false;
    } catch {
      deliveredOk = false; // fail closed
    }
  }

  return resolveElicitationOutcome({ config, request, decision, deliveredOk, timedOut });
}

/** Convenience: is a tool call allowed to proceed given an outcome? */
export function isToolCallApproved(outcome: ElicitationOutcome): boolean {
  return outcome.gated && outcome.decision === "approve";
}

// --- helpers -----------------------------------------------------------------

function deny(reason: ElicitationOutcomeReason): ElicitationOutcome {
  return { gated: false, decision: "deny", reason };
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

function asText(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function asPositiveNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined;
}

function parsePositiveInt(v: string | undefined): number | null {
  if (!v) return null;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}
