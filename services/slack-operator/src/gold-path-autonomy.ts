import { readFile } from "node:fs/promises";

import { isHaltFilePresent } from "./anomaly-pause.js";
import { isAutopilotSuspended } from "./autopilot-state.js";
import {
  basicAuthHeadersForUrl,
  cloudflareAccessHeaders,
  resolveSweepSession,
  type CloudflareAccessServiceToken,
  type SweepSession,
  type TestbedBasicAuth,
} from "./testbed-session.js";
import type { TestbedMissionRun } from "./monitor-testbed-missions.js";

export interface GoldPathAutonomyConfig {
  enabled: boolean;
  maxUsdcPerDay: number;
  maxStakeUsdPerRun: number;
  maxConcurrentRuns: number;
  readyJobsPath: string;
  readyJobId?: string;
  haltFile?: string;
  autopilotSuspendedPath?: string;
}

export interface ReadyToPostJobTemplate {
  id: string;
  rewardAsset?: string;
  rewardAmount?: number;
  stakeAmount?: number;
  stakeUsd?: number;
  requiresSponsoredGas?: boolean;
  [key: string]: unknown;
}

type GoldPathBudgetReservation = NonNullable<NonNullable<TestbedMissionRun["goldPathAutonomy"]>["budget"]>;
type GoldPathPreparedJob = NonNullable<NonNullable<TestbedMissionRun["goldPathAutonomy"]>["job"]>;
type GoldPathPreflight = NonNullable<NonNullable<TestbedMissionRun["goldPathAutonomy"]>["preflight"]>;

export interface GoldPathAutonomyPrepared {
  budget: GoldPathBudgetReservation;
  job: GoldPathPreparedJob;
  preflight: GoldPathPreflight;
}

export type GoldPathAutonomyDecision =
  | { ok: true; prepared?: GoldPathAutonomyPrepared }
  | { ok: false; reason: string; checks?: GoldPathAutonomyPrepared["preflight"]["checks"] };

export interface GoldPathAutonomyDeps {
  now?: Date;
  readFileImpl?: (path: string) => Promise<string>;
  fetchImpl?: typeof fetch;
  resolveSession?: (input: { role: "admin" | "agent" }) => Promise<SweepSession | undefined>;
  isHaltPresent?: (path?: string) => boolean;
  isSuspended?: (path?: string) => boolean;
}

export interface GoldPathAutonomyRuntime {
  apiBaseUrl?: string;
  appBaseUrl?: string;
  signerBaseUrl?: string;
  cloudflareAccess?: CloudflareAccessServiceToken;
  basicAuth?: TestbedBasicAuth;
}

export function parseGoldPathAutonomyConfig(
  env: NodeJS.ProcessEnv = process.env
): GoldPathAutonomyConfig {
  return {
    enabled: truthy(env.TESTBED_GOLDPATH_AUTONOMY_ENABLED),
    maxUsdcPerDay: nonNegativeNumber(env.TESTBED_GOLDPATH_MAX_USDC_PER_DAY, 0),
    maxStakeUsdPerRun: nonNegativeNumber(env.TESTBED_GOLDPATH_MAX_STAKE_USD_PER_RUN, 0),
    maxConcurrentRuns: positiveInt(env.TESTBED_GOLDPATH_MAX_CONCURRENT_RUNS, 1),
    readyJobsPath: env.TESTBED_GOLDPATH_READY_JOBS_PATH || "docs/ready-to-post-jobs.json",
    ...(env.TESTBED_GOLDPATH_READY_JOB_ID ? { readyJobId: env.TESTBED_GOLDPATH_READY_JOB_ID } : {}),
    ...(env.HALT_FILE ? { haltFile: env.HALT_FILE } : {}),
    ...(env.AVERRAY_AUTOPILOT_SUSPENDED_PATH ? { autopilotSuspendedPath: env.AVERRAY_AUTOPILOT_SUSPENDED_PATH } : {}),
  };
}

export async function prepareGoldPathAutonomousRun(
  mission: TestbedMissionRun,
  input: {
    config: GoldPathAutonomyConfig;
    runtime: GoldPathAutonomyRuntime;
    runs: readonly TestbedMissionRun[];
  },
  deps: GoldPathAutonomyDeps = {},
): Promise<GoldPathAutonomyDecision> {
  if (mission.mode !== "gold_path" || mission.allowTestMutations !== true) {
    return { ok: true };
  }
  if (mission.goldPathAutonomy?.job?.jobId && mission.goldPathAutonomy.preflight?.status === "passed") {
    return { ok: true, prepared: mission.goldPathAutonomy as GoldPathAutonomyPrepared };
  }

  const now = deps.now ?? new Date();
  const config = input.config;
  if (!config.enabled) {
    return blocked("Gold-path autonomy is disabled; set TESTBED_GOLDPATH_AUTONOMY_ENABLED=1 and budget caps before running mutating gold-path missions.");
  }
  if (mission.environment !== "testnet") {
    return blocked(`Mutating gold-path autonomy is testnet-only; mission environment is ${mission.environment ?? "unknown"}.`);
  }
  if ((deps.isHaltPresent ?? isHaltFilePresent)(config.haltFile)) {
    return blocked("HALT_FILE present; mutating gold-path tester work is stopped.");
  }
  if ((deps.isSuspended ?? isAutopilotSuspended)(config.autopilotSuspendedPath)) {
    return blocked("D3 anomaly pause is active; mutating gold-path tester work is stopped.");
  }

  const template = await loadReadyJobTemplate(config, deps);
  if (!template) {
    return blocked(`No ready-to-post job template found at ${config.readyJobsPath}${config.readyJobId ? ` for ${config.readyJobId}` : ""}.`);
  }
  if (template.requiresSponsoredGas !== true) {
    return blocked(`Ready job template ${template.id} is not sponsored; gold-path autonomy only posts sponsored starter jobs.`);
  }

  const estimatedRewardUsd = estimatedRewardUsdForTemplate(template);
  const estimatedStakeUsd = estimatedStakeUsdForTemplate(template);
  const budgetCheck = evaluateBudget({
    mission,
    runs: input.runs,
    now,
    estimatedRewardUsd,
    estimatedStakeUsd,
    config,
  });
  if (!budgetCheck.ok) return blocked(budgetCheck.reason);

  const adminSession = await resolveRoleSession("admin", input.runtime, deps);
  if (!adminSession?.token) {
    return blocked("Gold-path autonomy could not get an admin API session from the signer sidecar; no job was posted.");
  }
  const agentSession = await resolveRoleSession("agent", input.runtime, deps);
  const jobId = buildAutonomousJobId(template.id, mission.id, now);
  const posted = await postReadyJob({
    job: buildAutonomousJob(template, mission, jobId),
    token: adminSession.token,
    runtime: input.runtime,
    fetchImpl: deps.fetchImpl ?? fetch,
  });
  if (!posted.ok) return blocked(posted.reason);

  const checks = await runGoldPathPreflight({
    mission,
    jobId,
    token: agentSession?.token,
    runtime: input.runtime,
    fetchImpl: deps.fetchImpl ?? fetch,
  });
  if (checks.some((check) => !check.ok)) {
    return {
      ok: false,
      reason: `Gold-path preflight failed: ${checks.filter((check) => !check.ok).map((check) => `${check.name}: ${check.detail}`).join("; ")}`,
      checks,
    };
  }

  const checkedAt = now.toISOString();
  return {
    ok: true,
    prepared: {
      budget: {
        reservedAt: checkedAt,
        estimatedRewardUsd,
        estimatedStakeUsd,
        maxUsdcPerDay: config.maxUsdcPerDay,
        maxStakeUsdPerRun: config.maxStakeUsdPerRun,
        maxConcurrentRuns: config.maxConcurrentRuns,
      },
      job: {
        templateId: template.id,
        jobId,
        postedAt: checkedAt,
      },
      preflight: {
        checkedAt,
        status: "passed",
        checks,
      },
    },
  };
}

export function evaluateBudget(input: {
  mission: TestbedMissionRun;
  runs: readonly TestbedMissionRun[];
  now: Date;
  estimatedRewardUsd: number;
  estimatedStakeUsd: number;
  config: GoldPathAutonomyConfig;
}): { ok: true } | { ok: false; reason: string } {
  const config = input.config;
  if (config.maxUsdcPerDay <= 0) {
    return { ok: false, reason: "TESTBED_GOLDPATH_MAX_USDC_PER_DAY must be greater than zero." };
  }
  if (config.maxStakeUsdPerRun <= 0 && input.estimatedStakeUsd > 0) {
    return { ok: false, reason: "TESTBED_GOLDPATH_MAX_STAKE_USD_PER_RUN must be greater than zero when the ready job requires stake." };
  }
  if (input.estimatedStakeUsd > config.maxStakeUsdPerRun) {
    return { ok: false, reason: `Ready job stake estimate ${input.estimatedStakeUsd} USD exceeds per-run cap ${config.maxStakeUsdPerRun} USD.` };
  }
  const running = input.runs.filter((run) =>
    run.id !== input.mission.id
    && run.mode === "gold_path"
    && run.allowTestMutations === true
    && run.status === "running"
  ).length;
  if (running >= config.maxConcurrentRuns) {
    return { ok: false, reason: `Gold-path concurrency cap reached (${running}/${config.maxConcurrentRuns}).` };
  }
  const day = input.now.toISOString().slice(0, 10);
  const spentToday = input.runs.reduce((total, run) => {
    if (run.id === input.mission.id || run.mode !== "gold_path" || run.allowTestMutations !== true) return total;
    const reservedAt = run.goldPathAutonomy?.budget?.reservedAt;
    if (!reservedAt?.startsWith(day)) return total;
    return total + (run.goldPathAutonomy?.budget?.estimatedRewardUsd ?? 0);
  }, 0);
  if (spentToday + input.estimatedRewardUsd > config.maxUsdcPerDay) {
    return { ok: false, reason: `Gold-path daily USDC cap would be exceeded (${spentToday + input.estimatedRewardUsd}/${config.maxUsdcPerDay}).` };
  }
  return { ok: true };
}

async function loadReadyJobTemplate(
  config: GoldPathAutonomyConfig,
  deps: GoldPathAutonomyDeps,
): Promise<ReadyToPostJobTemplate | undefined> {
  const raw = await (deps.readFileImpl
    ? deps.readFileImpl(config.readyJobsPath)
    : readFile(config.readyJobsPath, "utf8")
  ).catch(() => "");
  if (!raw.trim()) return undefined;
  const parsed = JSON.parse(raw) as unknown;
  const templates = Array.isArray(parsed) ? parsed.filter(isReadyJobTemplate) : [];
  if (config.readyJobId) return templates.find((job) => job.id === config.readyJobId);
  return templates.find((job) => job.requiresSponsoredGas === true) ?? templates[0];
}

async function resolveRoleSession(
  role: "admin" | "agent",
  runtime: GoldPathAutonomyRuntime,
  deps: GoldPathAutonomyDeps,
): Promise<SweepSession | undefined> {
  if (deps.resolveSession) return deps.resolveSession({ role });
  if (!runtime.signerBaseUrl) return undefined;
  return resolveSweepSession({
    signerBaseUrl: runtime.signerBaseUrl,
    role,
    sessionType: "api",
  });
}

async function postReadyJob(input: {
  job: Record<string, unknown>;
  token: string;
  runtime: GoldPathAutonomyRuntime;
  fetchImpl: typeof fetch;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  const baseUrl = apiBaseUrl(input.runtime);
  if (!baseUrl) return { ok: false, reason: "AVERRAY_API_BASE_URL is required to auto-post a gold-path test job." };
  const url = joinUrl(baseUrl, "/admin/jobs");
  const response = await input.fetchImpl(url, {
    method: "POST",
    redirect: "follow",
    headers: requestHeaders(url, input.runtime, input.token, "application/json"),
    body: JSON.stringify(input.job),
  });
  if (!response.ok) {
    return { ok: false, reason: `/admin/jobs rejected the gold-path ready job with HTTP ${response.status}.` };
  }
  return { ok: true };
}

async function runGoldPathPreflight(input: {
  mission: TestbedMissionRun;
  jobId: string;
  token?: string;
  runtime: GoldPathAutonomyRuntime;
  fetchImpl: typeof fetch;
}): Promise<Array<{ name: string; ok: boolean; detail: string }>> {
  const checks: Array<{ name: string; ok: boolean; detail: string }> = [];
  checks.push(await fetchCheck({
    name: "read_only_smoke",
    url: input.mission.targetUrl,
    runtime: input.runtime,
    fetchImpl: input.fetchImpl,
  }));
  const baseUrl = apiBaseUrl(input.runtime);
  checks.push(baseUrl
    ? await fetchCheck({
      name: "claim_readiness_smoke",
      url: joinUrl(baseUrl, `/jobs/definition?jobId=${encodeURIComponent(input.jobId)}`),
      runtime: input.runtime,
      fetchImpl: input.fetchImpl,
      token: input.token,
    })
    : { name: "claim_readiness_smoke", ok: false, detail: "AVERRAY_API_BASE_URL is not configured." });
  return checks;
}

async function fetchCheck(input: {
  name: string;
  url: string;
  runtime: GoldPathAutonomyRuntime;
  fetchImpl: typeof fetch;
  token?: string;
}): Promise<{ name: string; ok: boolean; detail: string }> {
  try {
    const response = await input.fetchImpl(input.url, {
      method: "GET",
      redirect: "follow",
      headers: requestHeaders(input.url, input.runtime, input.token),
    });
    return {
      name: input.name,
      ok: response.ok,
      detail: `HTTP ${response.status}`,
    };
  } catch (error) {
    return {
      name: input.name,
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

function requestHeaders(
  url: string,
  runtime: GoldPathAutonomyRuntime,
  token?: string,
  contentType?: string,
): Record<string, string> {
  return {
    accept: "application/json, text/html;q=0.8",
    "user-agent": "Averray-Hermes-GoldPath-Autonomy/1.0",
    ...cloudflareAccessHeaders(runtime.cloudflareAccess),
    ...(basicAuthHeadersForUrl(url, runtime.basicAuth) ?? {}),
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...(contentType ? { "content-type": contentType } : {}),
  };
}

function buildAutonomousJob(
  template: ReadyToPostJobTemplate,
  mission: TestbedMissionRun,
  jobId: string,
): Record<string, unknown> {
  return {
    ...template,
    id: jobId,
    title: typeof template.title === "string" && template.title.trim()
      ? `${template.title.trim()} (Hermes gold-path)`
      : `Hermes gold-path test job ${jobId}`,
    description: [
      typeof template.description === "string" ? template.description.trim() : "",
      `Autonomous Hermes gold-path test job for mission ${mission.id}.`,
      "Use sponsored gas / starter flow; this is testnet-only.",
    ].filter(Boolean).join("\n\n"),
    requiresSponsoredGas: true,
    source: {
      ...(isRecord(template.source) ? template.source : {}),
      type: "hermes_gold_path_autonomy",
      missionId: mission.id,
      targetUrl: mission.targetUrl,
    },
  };
}

function buildAutonomousJobId(templateId: string, missionId: string, now: Date): string {
  const suffix = missionId.replace(/^testbed-mission-/, "").replace(/[^a-zA-Z0-9-]/g, "").slice(-16);
  return `${templateId}-gp-${now.getTime().toString(36)}${suffix ? `-${suffix}` : ""}`.slice(0, 96);
}

function estimatedRewardUsdForTemplate(template: ReadyToPostJobTemplate): number {
  const asset = typeof template.rewardAsset === "string" ? template.rewardAsset.toUpperCase() : "";
  if (asset === "USDC" && Number.isFinite(template.rewardAmount)) return Number(template.rewardAmount);
  return numberField(template.rewardUsd, template.estimatedRewardUsd, template.estimatedCostUsd) ?? 0;
}

function estimatedStakeUsdForTemplate(template: ReadyToPostJobTemplate): number {
  return numberField(template.stakeUsd, template.stakeAmount, template.stakeUSDC, template.stake) ?? 0;
}

function apiBaseUrl(runtime: GoldPathAutonomyRuntime): string | undefined {
  return runtime.apiBaseUrl || runtime.appBaseUrl;
}

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
}

function blocked(reason: string): GoldPathAutonomyDecision {
  return { ok: false, reason };
}

function isReadyJobTemplate(value: unknown): value is ReadyToPostJobTemplate {
  return isRecord(value) && typeof value.id === "string" && value.id.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function numberField(...values: unknown[]): number | undefined {
  for (const value of values) {
    const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function truthy(value: string | undefined): boolean {
  return value === "1" || value === "true";
}

function nonNegativeNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}
