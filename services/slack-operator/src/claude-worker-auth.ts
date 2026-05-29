// Claude worker — model-provider auth & billing wiring (O2).
//
// Resolves how the Claude worker authenticates to Anthropic and guards the
// billing route so the worker can never *silently* bill the API when the
// operator intended to run on the subscription. See
// docs/HERMES_WORKER_AUTH_BILLING.md for the policy ("sub now → API key at
// scale"), the June 15 2026 unbundling, and the two footguns this defuses:
//
//   1. Key precedence — ANTHROPIC_API_KEY > CLAUDE_CODE_OAUTH_TOKEN >
//      interactive login. An API key in the worker env silently wins and
//      bypasses the subscription → API billing.
//   2. Silent-billing — headless `claude -p` has billed the API for some
//      users even with no key set. A live route probe (claude /status
//      equivalent) catches this; pass it in via `probedRoute`.
//
// SECRETS: this module reads token/key env vars but NEVER logs or returns
// their values — only whether each is present and which route is active.
// The operator provisions CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_API_KEY; the
// worker only reads them. The worker's *command* output is sanitized by the
// runner's existing sanitizeTail (codex-task-runner.ts); this module emits
// no secret-bearing output of its own.
//
// Invocation-agnostic: whether the worker calls Claude via `claude -p` or
// the Agent SDK, auth resolves through this same logic, and
// buildClaudeInvocationEnv() guarantees no API key leaks into the child env
// when the intent is "sub".

/** What the operator INTENDS — the source of truth for the billing route. */
export type ClaudeWorkerAuthMode = "sub" | "api";

/** The route auth would actually take. "none" = no usable credential. */
export type ActiveAuthRoute = "api" | "sub" | "none";

/** Just the env vars this module reads (keeps callers + tests honest). */
export interface ClaudeWorkerAuthEnv {
  CLAUDE_WORKER_AUTH_MODE?: string;
  ANTHROPIC_API_KEY?: string;
  CLAUDE_CODE_OAUTH_TOKEN?: string;
  CLAUDE_WORKER_DAILY_BUDGET?: string;
}

export class ClaudeWorkerAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClaudeWorkerAuthError";
  }
}

function present(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Resolve the intended auth mode. Defaults to "sub" (per policy) when
 * unset/empty. An explicit unrecognized value is a configuration error, not
 * a silent fallback — fail loud so the operator's intent is never guessed.
 */
export function resolveAuthMode(
  env: ClaudeWorkerAuthEnv
): { mode: ClaudeWorkerAuthMode } | { error: string } {
  const raw = (env.CLAUDE_WORKER_AUTH_MODE ?? "").trim().toLowerCase();
  if (raw === "" || raw === "sub") return { mode: "sub" };
  if (raw === "api") return { mode: "api" };
  return { error: `CLAUDE_WORKER_AUTH_MODE must be "sub" or "api" (got "${env.CLAUDE_WORKER_AUTH_MODE}")` };
}

/**
 * The route auth takes purely from the env, by Anthropic's key precedence:
 * API key > OAuth token > interactive/none. This is the *static* read; the
 * live probe (claude /status) can override it to catch the silent-billing
 * footgun — see verifyAuthRoute's `probedRoute`.
 */
export function activeAuthRoute(env: ClaudeWorkerAuthEnv): ActiveAuthRoute {
  if (present(env.ANTHROPIC_API_KEY)) return "api";
  if (present(env.CLAUDE_CODE_OAUTH_TOKEN)) return "sub";
  return "none";
}

export type RouteVerification =
  | { ok: true; mode: ClaudeWorkerAuthMode; activeRoute: ActiveAuthRoute; message: string }
  | { ok: false; mode?: ClaudeWorkerAuthMode; reason: string };

/**
 * Route-verification health check (the core safeguard). Asserts the ACTIVE
 * route matches the INTENDED mode; on mismatch returns ok:false with a clear
 * reason. Pure + synchronous so it's trivially testable.
 *
 * @param opts.probedRoute optional live route from `claude /status` (or the
 *   SDK). When provided it is authoritative for the active route — this is
 *   what catches the silent-billing footgun where headless billing diverges
 *   from what the env implies.
 */
export function verifyAuthRoute(
  env: ClaudeWorkerAuthEnv,
  opts: { probedRoute?: ActiveAuthRoute } = {}
): RouteVerification {
  const resolved = resolveAuthMode(env);
  if ("error" in resolved) return { ok: false, reason: resolved.error };
  const mode = resolved.mode;
  const route = opts.probedRoute ?? activeAuthRoute(env);

  if (mode === "sub") {
    // Footgun 1 (static): an API key in the env would silently win and bill
    // the API. Refuse regardless of what the probe says — its mere presence
    // is the hazard.
    if (present(env.ANTHROPIC_API_KEY)) {
      return {
        ok: false,
        mode,
        reason:
          "CLAUDE_WORKER_AUTH_MODE=sub but ANTHROPIC_API_KEY is set in the worker env — " +
          "it takes precedence and would silently bypass the subscription and bill the API. " +
          "Unset ANTHROPIC_API_KEY for this worker.",
      };
    }
    // Footgun 2 (live): the probe reports the worker is actually billing the
    // API despite no key in env (the silent-billing bug).
    if (route === "api") {
      return {
        ok: false,
        mode,
        reason:
          "CLAUDE_WORKER_AUTH_MODE=sub but the live route probe reports the active billing route is API — " +
          "refusing to run rather than silently API-bill. Verify `claude /status` shows the subscription.",
      };
    }
    // Must actually hold a subscription credential, or it would fall through
    // to interactive/headless (where the silent-billing bug lives).
    if (!present(env.CLAUDE_CODE_OAUTH_TOKEN) && route !== "sub") {
      return {
        ok: false,
        mode,
        reason:
          "CLAUDE_WORKER_AUTH_MODE=sub but no CLAUDE_CODE_OAUTH_TOKEN is set and the route is not confirmed as " +
          "subscription — cannot confirm the sub route. Provision CLAUDE_CODE_OAUTH_TOKEN (claude setup-token).",
      };
    }
    return {
      ok: true,
      mode,
      activeRoute: "sub",
      message: "auth route confirmed: subscription (CLAUDE_CODE_OAUTH_TOKEN); no ANTHROPIC_API_KEY present",
    };
  }

  // mode === "api"
  if (!present(env.ANTHROPIC_API_KEY)) {
    return {
      ok: false,
      mode,
      reason: "CLAUDE_WORKER_AUTH_MODE=api but ANTHROPIC_API_KEY is not set in the worker env.",
    };
  }
  return {
    ok: true,
    mode,
    activeRoute: "api",
    message: "auth route confirmed: API key (ANTHROPIC_API_KEY) — metered billing; cap enforced via budget + Console",
  };
}

export interface AuthGuardDeps {
  /**
   * Persist a "misconfigured" runner heartbeat on failure (wire to
   * updateCodexRunnerHeartbeat). Injected so the guard is testable without
   * touching the queue file.
   */
  writeMisconfiguredHeartbeat?: (input: { runnerId: string; reason: string }) => Promise<void> | void;
  /** Logger (defaults to console.error). Never receives secret values. */
  log?: (message: string) => void;
  /** Live route from a `claude /status` / SDK probe (see verifyAuthRoute). */
  probedRoute?: ActiveAuthRoute;
}

/**
 * Startup guard the worker/runner calls before claiming any work. On a route
 * mismatch it FAILS LOUD: logs the reason, writes a "misconfigured"
 * heartbeat, and throws ClaudeWorkerAuthError — it never silently falls
 * through to API billing. On success it logs the confirmed route and returns
 * the verification.
 */
export async function assertAuthRouteOrHalt(
  env: ClaudeWorkerAuthEnv,
  runnerId: string,
  deps: AuthGuardDeps = {}
): Promise<Extract<RouteVerification, { ok: true }>> {
  const log = deps.log ?? ((m: string) => console.error(m));
  const result = verifyAuthRoute(env, { probedRoute: deps.probedRoute });
  if (!result.ok) {
    log(`[claude-worker-auth] REFUSING TO RUN (${runnerId}): ${result.reason}`);
    if (deps.writeMisconfiguredHeartbeat) {
      await deps.writeMisconfiguredHeartbeat({ runnerId, reason: `auth route check failed: ${result.reason}` });
    }
    throw new ClaudeWorkerAuthError(result.reason);
  }
  log(`[claude-worker-auth] ${runnerId}: ${result.message}`);
  return result;
}

// ── Budget (the in-process half of AGENTS invariant #6) ─────────────────

/** Parse CLAUDE_WORKER_DAILY_BUDGET (USD). Returns undefined when unset/invalid. */
export function parseDailyBudgetUsd(env: ClaudeWorkerAuthEnv): number | undefined {
  const raw = (env.CLAUDE_WORKER_DAILY_BUDGET ?? "").trim();
  if (raw === "") return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

export interface BudgetGate {
  mode: ClaudeWorkerAuthMode;
  capUsd?: number;
  /** Whether the runner may claim more work right now. */
  allowClaim: boolean;
  /** Human-readable note (cap reached, or no cap configured). */
  reason?: string;
}

/**
 * Gate the runner's claim loop on spend. In "api" mode, stop claiming new
 * work once today's spend reaches CLAUDE_WORKER_DAILY_BUDGET. In "sub" mode
 * there is no per-token charge (the plan throttles, it doesn't surprise-
 * bill), so claiming is always allowed. When api mode has no in-process cap
 * configured, claiming is allowed but flagged — the Anthropic Console cap is
 * then the only hard backstop.
 */
export function budgetGate(
  mode: ClaudeWorkerAuthMode,
  spentTodayUsd: number,
  env: ClaudeWorkerAuthEnv
): BudgetGate {
  if (mode === "sub") return { mode, allowClaim: true };
  const capUsd = parseDailyBudgetUsd(env);
  if (capUsd === undefined) {
    return {
      mode,
      allowClaim: true,
      reason: "api mode but no CLAUDE_WORKER_DAILY_BUDGET set — relying on the Anthropic Console cap only",
    };
  }
  const allowClaim = spentTodayUsd < capUsd;
  return {
    mode,
    capUsd,
    allowClaim,
    reason: allowClaim
      ? undefined
      : `daily budget reached: $${spentTodayUsd.toFixed(2)} ≥ cap $${capUsd.toFixed(2)} — not claiming new work`,
  };
}

// ── Child-invocation env (requirement: no API key leaks under intent=sub) ─

/**
 * Build the environment to pass to the Claude invocation (`claude -p` or the
 * Agent SDK). In "sub" mode ANTHROPIC_API_KEY is stripped so it can never
 * silently win in the child process; in "api" mode it is passed through.
 * Defense-in-depth — verifyAuthRoute already refuses to start a sub worker
 * that has an API key in its env.
 */
export function buildClaudeInvocationEnv<T extends NodeJS.ProcessEnv>(
  baseEnv: T,
  mode: ClaudeWorkerAuthMode
): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = { ...baseEnv };
  if (mode === "sub") {
    delete next.ANTHROPIC_API_KEY;
  }
  return next;
}
