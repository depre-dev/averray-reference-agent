import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assertAuthRouteOrHalt,
  buildClaudeInvocationEnv,
  resolveAuthMode,
  type ActiveAuthRoute,
  type ClaudeWorkerAuthEnv,
} from "./claude-worker-auth.js";
import {
  GOLD_PATH_STEPS,
  type GoldPathDriver,
  type GoldPathDriverInput,
  type GoldPathObservation,
  type GoldPathStep,
  type GoldPathStepResult,
  type GoldPathStepStatus,
} from "./gold-path-mission.js";
import { redact } from "./codex-branch-worker.js";

export interface ClaudeGoldPathDriverConfig {
  enabled: boolean;
  command: string;
  args: string[];
  timeoutMs: number;
  cwd?: string;
  signerBaseUrl?: string;
  probedRoute?: ActiveAuthRoute;
}

export interface ClaudeGoldPathDriverDeps {
  exec?: ExecClaudeFn;
  now?: () => number;
}

export interface ExecClaudeInput {
  command: string;
  args: string[];
  cwd?: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
}

export interface ExecClaudeResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type ExecClaudeFn = (input: ExecClaudeInput) => Promise<ExecClaudeResult>;

const DEFAULT_CLAUDE_ARGS = ["-p", "{prompt}"];

interface GoldPathSessionArtifacts {
  role?: string;
  token?: string;
  storageStatePath?: string;
}

export function parseClaudeGoldPathDriverConfig(
  env: NodeJS.ProcessEnv = process.env
): ClaudeGoldPathDriverConfig {
  return {
    enabled: env.TESTBED_GOLDPATH_LIVE === "1" || env.TESTBED_GOLDPATH_LIVE === "true",
    command: env.TESTBED_GOLDPATH_CLAUDE_COMMAND?.trim() || "claude",
    args: parseArgs(env.TESTBED_GOLDPATH_CLAUDE_ARGS, DEFAULT_CLAUDE_ARGS),
    timeoutMs: positiveInt(env.TESTBED_GOLDPATH_TIMEOUT_MS, 20 * 60_000),
    ...(env.TESTBED_GOLDPATH_CWD ? { cwd: env.TESTBED_GOLDPATH_CWD } : {}),
    ...(env.TEST_WALLET_SIGNER_BASE_URL || env.TESTBED_SESSION_SIGNER_URL
      ? { signerBaseUrl: env.TEST_WALLET_SIGNER_BASE_URL || env.TESTBED_SESSION_SIGNER_URL }
      : {}),
    ...(parseProbedRoute(env.TESTBED_GOLDPATH_AUTH_PROBED_ROUTE) ? { probedRoute: parseProbedRoute(env.TESTBED_GOLDPATH_AUTH_PROBED_ROUTE) } : {}),
  };
}

export function createClaudeGoldPathDriver(
  config: ClaudeGoldPathDriverConfig = parseClaudeGoldPathDriverConfig(),
  env: NodeJS.ProcessEnv = process.env,
  deps: ClaudeGoldPathDriverDeps = {},
): GoldPathDriver {
  const exec = deps.exec ?? execClaudeCommand;
  return {
    async run(input: GoldPathDriverInput): Promise<GoldPathObservation> {
      if (!config.enabled) {
        return failedObservation(input, "Live gold-path driver is disabled; TESTBED_GOLDPATH_LIVE is not set.");
      }
      if (!input.allowMutations && input.mutationScope !== "none; stop at mutation boundary") {
        // Defense-in-depth wording for read-only envs; not a failure by itself.
      }
      const routeEnv = claudeAuthEnv(env);
      const authMode = resolveAuthMode(routeEnv);
      if ("error" in authMode) return failedObservation(input, authMode.error);
      try {
        await assertAuthRouteOrHalt(routeEnv, "testbed-gold-path-live-driver", {
          probedRoute: config.probedRoute,
          log: () => undefined,
        });
      } catch (error) {
        return failedObservation(input, error instanceof Error ? error.message : String(error));
      }

      const runDir = await mkdtemp(join(tmpdir(), "averray-gold-path-live-"));
      const observationPath = join(runDir, "observation.json");
      const sessionArtifacts = await materializeGoldPathSession(input.session, runDir);
      const prompt = buildClaudeGoldPathPrompt(input, {
        observationPath,
        signerBaseUrl: input.signerBaseUrl ?? config.signerBaseUrl,
        hasSessionToken: Boolean(sessionArtifacts.token),
        ...(sessionArtifacts.role ? { sessionRole: sessionArtifacts.role } : {}),
        ...(sessionArtifacts.storageStatePath ? { sessionStorageStatePath: sessionArtifacts.storageStatePath } : {}),
      });
      const childEnv = buildClaudeInvocationEnv({
        ...env,
        TESTBED_GOLDPATH_OBSERVATION_PATH: observationPath,
        TESTBED_TARGET_URL: input.targetUrl,
        TESTBED_MISSION_GOAL: input.goal,
        TESTBED_GOLDPATH_MODEL: input.model,
        TESTBED_ALLOW_TEST_MUTATIONS: String(input.allowMutations),
        TESTBED_MUTATION_SCOPE: input.mutationScope,
        ...(input.signerBaseUrl ?? config.signerBaseUrl
          ? { TEST_WALLET_SIGNER_BASE_URL: input.signerBaseUrl ?? config.signerBaseUrl }
          : {}),
        ...(input.signerBaseUrl ?? config.signerBaseUrl
          ? { TESTBED_SESSION_SIGNER_URL: input.signerBaseUrl ?? config.signerBaseUrl }
          : {}),
        ...(sessionArtifacts.role ? { TESTBED_SESSION_ROLE: sessionArtifacts.role } : {}),
        ...(sessionArtifacts.token ? { TESTBED_SESSION_TOKEN: sessionArtifacts.token } : {}),
        ...(sessionArtifacts.storageStatePath
          ? {
            TESTBED_SESSION_TYPE: "browser",
            TESTBED_SESSION_STORAGE_STATE_PATH: sessionArtifacts.storageStatePath,
          }
          : {}),
      }, authMode.mode);

      const started = deps.now?.() ?? Date.now();
      const result = await exec({
        command: config.command,
        args: renderClaudeArgs(config.args, prompt),
        cwd: config.cwd,
        env: childEnv,
        timeoutMs: config.timeoutMs,
      });
      const elapsedMs = Math.max(0, (deps.now?.() ?? Date.now()) - started);
      const rawObservation = await readFile(observationPath, "utf8")
        .then((text) => redactGoldPathOutput(text, childEnv))
        .catch(() => result.stdout);
      if (result.exitCode !== 0) {
        const reason = lastNonEmptyLine(result.stderr) || lastNonEmptyLine(result.stdout) || `Claude live driver exited with ${result.exitCode}.`;
        return failedObservation(input, redactGoldPathOutput(reason, childEnv), elapsedMs, redactExecResult(result, childEnv));
      }
      const parsed = parseClaudeGoldPathObservation(rawObservation, input, elapsedMs);
      if (!parsed) {
        return failedObservation(
          input,
          "Claude live driver finished without a valid gold-path observation JSON.",
          elapsedMs,
          redactExecResult(result, childEnv),
        );
      }
      return parsed;
    },
  };
}

function claudeAuthEnv(env: NodeJS.ProcessEnv): ClaudeWorkerAuthEnv {
  return {
    ...(env.CLAUDE_WORKER_AUTH_MODE !== undefined ? { CLAUDE_WORKER_AUTH_MODE: env.CLAUDE_WORKER_AUTH_MODE } : {}),
    ...(env.ANTHROPIC_API_KEY !== undefined ? { ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY } : {}),
    ...(env.CLAUDE_CODE_OAUTH_TOKEN !== undefined ? { CLAUDE_CODE_OAUTH_TOKEN: env.CLAUDE_CODE_OAUTH_TOKEN } : {}),
    ...(env.CLAUDE_WORKER_DAILY_BUDGET !== undefined ? { CLAUDE_WORKER_DAILY_BUDGET: env.CLAUDE_WORKER_DAILY_BUDGET } : {}),
  };
}

async function materializeGoldPathSession(
  session: GoldPathDriverInput["session"] | undefined,
  runDir: string,
): Promise<GoldPathSessionArtifacts> {
  if (!session) return {};
  const artifacts: GoldPathSessionArtifacts = {};
  if (session.role) artifacts.role = session.role;
  if (typeof session.token === "string" && session.token.trim()) {
    artifacts.token = session.token;
  }
  if (session.storageState !== undefined) {
    const storageStatePath = join(runDir, "siwe-storage-state.json");
    await writeFile(storageStatePath, `${JSON.stringify(session.storageState, null, 2)}\n`, "utf8");
    artifacts.storageStatePath = storageStatePath;
  }
  return artifacts;
}

export function buildClaudeGoldPathPrompt(
  input: GoldPathDriverInput,
  opts: {
    observationPath: string;
    signerBaseUrl?: string;
    sessionRole?: string;
    hasSessionToken?: boolean;
    sessionStorageStatePath?: string;
  }
): string {
  const mutationLine = input.allowMutations
    ? `Mutation profile: TESTNET/STAGING test-only mutations are allowed only inside clearly fake/sandbox Averray flows. Scope: ${input.mutationScope}`
    : "Mutation profile: READ ONLY. Stop before claim, submit, payout/SBT, wallet signature, payment, deploy, merge, or any irreversible action.";
  const edgeAuthLine = input.cloudflareAccess
    ? "Cloudflare Access edge auth is configured in this process environment. When loading the gated app or its API, attach CF-Access-Client-Id and CF-Access-Client-Secret headers from env; never print, screenshot, or report their values."
    : "No Cloudflare Access service token was configured; if the target is behind Cloudflare Access, report that as an auth blocker instead of treating the product as broken.";
  const basicAuthLine = input.basicAuth
    ? "The gated host is behind Caddy HTTP Basic Auth. Open the browser context with httpCredentials { username, password } from TESTBED_BASIC_AUTH_USER / TESTBED_BASIC_AUTH_PASS in this environment so the 401 challenge is answered automatically; never print, screenshot, or report the username or password. (Basic Auth only loads the pages — authed claim/submit/verify still needs the SIWE session via the signer sidecar.)"
    : "No HTTP Basic Auth credential was configured; if the host returns 401 with a Basic realm, report that as an auth blocker instead of treating the product as broken.";
  const siweSessionLine = opts.sessionStorageStatePath || opts.hasSessionToken
    ? [
      `A SIWE session is already minted for role ${opts.sessionRole ?? input.session?.role ?? "agent"}.`,
      opts.sessionStorageStatePath
        ? `For browser work, create the Playwright context with storageState loaded from TESTBED_SESSION_STORAGE_STATE_PATH (${opts.sessionStorageStatePath}).`
        : "No browser storageState file was materialized; request a browser session from the signer sidecar if the UI requires it.",
      opts.hasSessionToken
        ? "For same-origin API checks, use the Bearer token from TESTBED_SESSION_TOKEN. Never print or report the token."
        : "No API Bearer token was materialized; request an API session from the signer sidecar if the API requires it.",
      "When the host is Basic-Auth-gated, combine the SIWE storageState with Basic Auth httpCredentials in the same browser context.",
    ].join(" ")
    : "No pre-minted SIWE session was resolved; if authentication is required, request a browser/api session from the signer sidecar or report the missing session as an auth blocker.";
  const preparedJobLine = input.preparedJobId
    ? `A sponsored starter job was already auto-posted for this mission: ${input.preparedJobId}. Prefer claiming that exact job id unless the product clearly shows it is unavailable.`
    : "No pre-posted starter job id was provided; if no claimable test job exists, report that as a claim-readiness blocker instead of asking the operator to post one.";
  return [
    "You are Hermes running the Averray Tier-2 gold-path tester as a normal browser-capable outside agent.",
    "Use the Claude Agent SDK browser tooling / Playwright MCP tools available in this runtime. Do not use private repo state, Slack, GitHub, SSH, databases, or Averray monitor internals.",
    "Reuse T3 only through the local signer sidecar when you need authentication. The wallet private keys must never enter your prompt, output, logs, screenshots, or report.",
    edgeAuthLine,
    basicAuthLine,
    siweSessionLine,
    opts.signerBaseUrl ? `Signer sidecar: ${opts.signerBaseUrl}. Request browser/api sessions by role as needed; do not print returned tokens.` : "No signer sidecar URL was provided; report that as a blocker if authentication is required.",
    mutationLine,
    `Target URL: ${input.targetUrl}`,
    `Goal: ${input.goal}`,
    preparedJobLine,
    `Model/effort policy selected: ${input.model}.`,
    `Fresh memory: ${input.freshMemory ? "yes" : "returning-agent memory allowed"}.`,
    "",
    "Drive this gold path honestly: onboard -> discover -> claim -> submit -> verify -> payout_sbt -> receipt.",
    "If the run is read-only, mark mutating steps as skipped and stop before them. If the run is testnet-mutating, attempt only clearly safe testbed actions.",
    "Capture real evidence: screenshot/trace paths, URL path, visible text, console errors, network failures, and what you tried.",
    "Write ONLY the observation JSON to this path:",
    opts.observationPath,
    "",
    "Observation JSON schema:",
    JSON.stringify({
      steps: GOLD_PATH_STEPS.map((step) => ({
        step,
        status: "ok | degraded | empty | blocked | skipped | error",
        detail: "visible, concrete outcome",
        evidence: "optional screenshot/trace/url/visible text reference",
        latencyMs: "number, omit if not measured",
        mutating: "boolean, true only for claim/submit/payout_sbt attempts",
      })),
      notes: ["what I tried, bounded and non-secret"],
      evidence: [{ type: "screenshot | trace | console | network | observation | url", value: "bounded reference" }],
      blockers: [{ head: "short blocker", body: "real detail from the run", evidence: ["optional evidence refs"] }],
      confusingMoments: [{ head: "short confusion", body: "real detail from the run" }],
      runs: 1,
      latencyMs: "total run latency in ms",
      scores: { success: "0-5", clarity: "0-5", latency: "0-5" },
      mutationsAttempted: ["test-only mutation descriptions, or []"],
      stoppedBeforeMutation: true,
    }, null, 2),
    "",
    "Truth boundary: never fabricate a pass, score, latency, screenshot, trace, or successful mutation. Omit fields you did not produce.",
  ].join("\n");
}

export function parseClaudeGoldPathObservation(
  text: string,
  input: GoldPathDriverInput,
  fallbackLatencyMs?: number,
): GoldPathObservation | undefined {
  const json = extractJsonObject(text);
  if (!json) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  const steps = normalizeSteps(value.steps, input);
  if (!steps.length) return undefined;
  const latencyMs = finiteNumber(value.latencyMs) ?? finiteNumber(value.durationMs) ?? fallbackLatencyMs;
  return {
    steps,
    notes: stringArray(value.notes),
    evidence: evidenceArray(value.evidence),
    blockers: findingArray(value.blockers),
    confusingMoments: findingArray(value.confusingMoments),
    ...(finiteNumber(value.runs) !== undefined ? { runs: finiteNumber(value.runs) } : {}),
    ...(latencyMs !== undefined ? { latencyMs } : {}),
    scores: scoreObject(value.scores),
    ...(isRecord(value.usage) ? { usage: value.usage } : {}),
    mutationsAttempted: stringArray(value.mutationsAttempted),
    stoppedBeforeMutation: typeof value.stoppedBeforeMutation === "boolean"
      ? value.stoppedBeforeMutation
      : !input.allowMutations,
  };
}

function failedObservation(
  input: GoldPathDriverInput,
  reason: string,
  latencyMs?: number,
  result?: ExecClaudeResult,
): GoldPathObservation {
  return {
    steps: input.steps.map((step) => ({ step, status: "error", detail: reason })),
    notes: [reason],
    evidence: [
      ...(result?.stderr ? [{ type: "stderr", value: redact(lastNonEmptyLine(result.stderr)) }] : []),
      ...(result?.stdout ? [{ type: "stdout", value: redact(lastNonEmptyLine(result.stdout)) }] : []),
    ],
    blockers: [{ head: "Live gold-path driver did not complete", body: reason }],
    ...(latencyMs !== undefined ? { latencyMs } : {}),
    mutationsAttempted: [],
    stoppedBeforeMutation: true,
  };
}

async function execClaudeCommand(input: ExecClaudeInput): Promise<ExecClaudeResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      env: input.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!settled) child.kill("SIGKILL");
      }, 5_000).unref();
      reject(new Error(`Claude gold-path driver timed out after ${input.timeoutMs}ms.`));
    }, input.timeoutMs);
    timeout.unref();
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      settled = true;
      clearTimeout(timeout);
      resolve({
        exitCode: code ?? 1,
        stdout: redactGoldPathOutput(stdout, input.env),
        stderr: redactGoldPathOutput(stderr, input.env),
      });
    });
  });
}

function redactExecResult(result: ExecClaudeResult, env: NodeJS.ProcessEnv): ExecClaudeResult {
  return {
    ...result,
    stdout: redactGoldPathOutput(result.stdout, env),
    stderr: redactGoldPathOutput(result.stderr, env),
  };
}

function redactGoldPathOutput(value: string, env: NodeJS.ProcessEnv): string {
  let next = redact(value);
  for (const secret of [
    env.TESTBED_CF_ACCESS_CLIENT_ID,
    env.TESTBED_CF_ACCESS_CLIENT_SECRET,
    env.CF_ACCESS_CLIENT_ID,
    env.CF_ACCESS_CLIENT_SECRET,
    env.CLOUDFLARE_ACCESS_CLIENT_ID,
    env.CLOUDFLARE_ACCESS_CLIENT_SECRET,
  ]) {
    if (secret && secret.length >= 6) {
      next = next.split(secret).join("[redacted-cloudflare-access]");
    }
  }
  // Caddy HTTP Basic Auth — never let the credential surface in a report/log.
  for (const secret of [env.TESTBED_BASIC_AUTH_PASS, env.TESTBED_BASIC_AUTH_USER]) {
    if (secret && secret.length >= 4) {
      next = next.split(secret).join("[redacted-basic-auth]");
    }
  }
  if (env.TESTBED_SESSION_TOKEN && env.TESTBED_SESSION_TOKEN.length >= 6) {
    next = next.split(env.TESTBED_SESSION_TOKEN).join("[redacted-session-token]");
  }
  return next;
}

function normalizeSteps(value: unknown, input: GoldPathDriverInput): GoldPathStepResult[] {
  if (!Array.isArray(value)) return [];
  const allowed = new Set<GoldPathStep>(input.steps as GoldPathStep[]);
  return value
    .map((entry) => {
      if (!isRecord(entry)) return undefined;
      const step = typeof entry.step === "string" && allowed.has(entry.step as GoldPathStep)
        ? entry.step as GoldPathStep
        : undefined;
      if (!step) return undefined;
      const status = normalizeStepStatus(entry.status);
      const detail = firstString(entry.detail, entry.description, entry.body, entry.message) ?? `${step} ${status}`;
      const latencyMs = finiteNumber(entry.latencyMs) ?? finiteNumber(entry.durationMs) ?? finiteNumber(entry.elapsedMs);
      return {
        step,
        status,
        detail,
        ...(firstString(entry.evidence, entry.url, entry.screenshot, entry.trace) ? { evidence: firstString(entry.evidence, entry.url, entry.screenshot, entry.trace) } : {}),
        ...(latencyMs !== undefined ? { latencyMs } : {}),
        ...(entry.mutating === true ? { mutating: true } : {}),
      };
    })
    .filter((step): step is GoldPathStepResult => Boolean(step));
}

function normalizeStepStatus(value: unknown): GoldPathStepStatus {
  const status = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (status === "ok" || status === "degraded" || status === "empty" || status === "blocked" || status === "skipped" || status === "error") {
    return status;
  }
  if (status === "warn" || status === "warning") return "degraded";
  if (status === "err" || status === "failed" || status === "fail") return "error";
  return "error";
}

function evidenceArray(value: unknown): Array<{ type: string; value: string }> | undefined {
  if (!Array.isArray(value)) return undefined;
  const entries = value.map((entry) => {
    if (typeof entry === "string" && entry.trim()) return { type: "observation", value: entry.trim() };
    if (!isRecord(entry)) return undefined;
    const detail = firstString(entry.value, entry.url, entry.href, entry.path, entry.detail);
    if (!detail) return undefined;
    return { type: firstString(entry.type, entry.kind) ?? "evidence", value: detail };
  }).filter((entry): entry is { type: string; value: string } => Boolean(entry));
  return entries.length ? entries : undefined;
}

function findingArray(value: unknown): Array<{ head: string; body?: string; evidence?: string[] }> | undefined {
  if (!Array.isArray(value)) return undefined;
  const entries = value.map((entry) => {
    if (typeof entry === "string" && entry.trim()) return { head: entry.trim() };
    if (!isRecord(entry)) return undefined;
    const head = firstString(entry.head, entry.title, entry.summary, entry.label, entry.message);
    if (!head) return undefined;
    const body = firstString(entry.body, entry.detail, entry.details, entry.description);
    const evidence = stringArray(entry.evidence);
    return { head, ...(body ? { body } : {}), ...(evidence.length ? { evidence } : {}) };
  }).filter((entry): entry is { head: string; body?: string; evidence?: string[] } => Boolean(entry));
  return entries.length ? entries : undefined;
}

function scoreObject(value: unknown): GoldPathObservation["scores"] {
  if (!isRecord(value)) return undefined;
  return {
    ...(finiteNumber(value.success) !== undefined ? { success: clampScore(value.success) } : {}),
    ...(finiteNumber(value.successScore) !== undefined ? { success: clampScore(value.successScore) } : {}),
    ...(finiteNumber(value.clarity) !== undefined ? { clarity: clampScore(value.clarity) } : {}),
    ...(finiteNumber(value.clarityScore) !== undefined ? { clarity: clampScore(value.clarityScore) } : {}),
    ...(finiteNumber(value.latency) !== undefined ? { latency: clampScore(value.latency) } : {}),
    ...(finiteNumber(value.latencyScore) !== undefined ? { latency: clampScore(value.latencyScore) } : {}),
  };
}

function renderClaudeArgs(args: string[], prompt: string): string[] {
  return args.map((arg) => arg.split("{prompt}").join(prompt));
}

function parseArgs(value: string | undefined, fallback: string[]): string[] {
  const trimmed = value?.trim();
  if (!trimmed) return fallback;
  if (trimmed.startsWith("[")) {
    const parsed: unknown = JSON.parse(trimmed);
    if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
      throw new Error("TESTBED_GOLDPATH_CLAUDE_ARGS must be a JSON string array when it starts with '['.");
    }
    return parsed;
  }
  return trimmed.split(/\s+/);
}

function parseProbedRoute(value: string | undefined): ActiveAuthRoute | undefined {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "api" || normalized === "sub" || normalized === "none") return normalized;
  return undefined;
}

function extractJsonObject(text: string): string | undefined {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const source = fenced ? fenced[1]?.trim() ?? "" : text;
  const first = source.indexOf("{");
  const last = source.lastIndexOf("}");
  if (first < 0 || last <= first) return undefined;
  return source.slice(first, last + 1);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((entry) => String(entry ?? "").trim()).filter(Boolean)
    : [];
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function finiteNumber(value: unknown): number | undefined {
  const num = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(num) ? num : undefined;
}

function clampScore(value: unknown): number {
  const score = finiteNumber(value) ?? 0;
  return Math.max(0, Math.min(5, score));
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function lastNonEmptyLine(value: string): string {
  return value.trim().split(/\r?\n/).filter(Boolean).slice(-1)[0]?.trim() ?? "";
}
