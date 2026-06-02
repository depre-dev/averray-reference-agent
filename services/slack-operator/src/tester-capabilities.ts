import type {
  TestbedMissionMode,
  TestbedMissionRun,
  TestbedMissionRunnerHeartbeat,
  TestbedMissionVerdict,
} from "./monitor-testbed-missions.js";
import { resolveTestbedMutationBinding, type TestbedMissionEnvironment, type TestbedMissionMutationMode } from "./testbed-mutation-binding.js";
import { isSweepSessionConfigured, parseSweepSessionConfig } from "./testbed-session.js";

export interface TesterCapabilitiesDeps {
  now?: Date;
  env?: Record<string, string | undefined>;
  runner?: TestbedMissionRunnerHeartbeat | null;
  missionRuns?: TestbedMissionRun[];
  savedSuites?: TesterSavedSuite[];
}

export interface TesterSavedSuite {
  id?: string;
  name: string;
  flow: string;
  target: string;
  status?: "available" | "unavailable";
  lastRun?: TesterInventoryLastRun;
}

export interface TesterInventoryLastRun {
  missionId?: string;
  verdict: TestbedMissionVerdict | "requested" | "ready" | "running" | "failed" | "unknown";
  at: string;
}

export function buildTesterCapabilitiesManifest(deps: TesterCapabilitiesDeps = {}) {
  const env = deps.env ?? process.env;
  const now = deps.now ?? new Date();
  const runnerEnabled = truthy(env.TESTBED_MISSION_RUNNER_ENABLED);
  const signerEnabled = truthy(env.TEST_WALLET_SIGNER_ENABLED);
  const runnerExecutor = runnerExecutorMode(env);
  const runnerConfigured = runnerExecutor === "command" ? Boolean(env.TESTBED_MISSION_RUNNER_COMMAND?.trim()) : true;
  const runnerReady = runnerEnabled && runnerConfigured;
  const goldPathLive = truthy(env.TESTBED_GOLDPATH_LIVE);
  const goldPathAutonomy = truthy(env.TESTBED_GOLDPATH_AUTONOMY_ENABLED);
  const missionEnvironment = env.TESTBED_MISSION_ENVIRONMENT || env.AVERRAY_TESTBED_ENVIRONMENT || "inferred_from_target_url";
  // T2: the runner now injects a pre-seeded session into the sweep. The authed
  // sweep is genuinely available once a session SOURCE is configured (the
  // signer sidecar URL, or a manual storageState path / token).
  const sessionConfigured = isSweepSessionConfigured(parseSweepSessionConfig(env as NodeJS.ProcessEnv));
  const goldPathSessionConfigured = sessionConfigured || Boolean(env.TEST_WALLET_SIGNER_BASE_URL?.trim());
  const runnerUnavailableStatus = !runnerEnabled ? "unavailable_runner_disabled" : "unavailable_runner_misconfigured";
  const basicFlowStatus = runnerReady ? "available" : runnerUnavailableStatus;
  const authedSweepStatus = !runnerReady
    ? runnerUnavailableStatus
    : sessionConfigured
      ? "available"
      : "ready_needs_session";
  const siweStatus = !runnerReady
    ? runnerUnavailableStatus
    : signerEnabled
      ? "available"
      : "planned";
  const goldPathStatus = !runnerReady
    ? runnerUnavailableStatus
    : !goldPathLive
      ? "ready_needs_live_driver"
      : goldPathSessionConfigured
        ? "available_live_driver"
        : "ready_needs_session";
  const missionRuns = deps.missionRuns ?? [];
  const missionTypes = [
    {
      id: "surface_sweep",
      status: basicFlowStatus,
      tier: 1,
      scope: "read_only",
      mutation: "never",
      supportedEnvs: ["local", "preview", "testnet", "mainnet-read-only"],
      request: {
        body: {
          mode: "surface_sweep",
          targetUrl: "https://app-or-site.example",
          routes: ["/", "/jobs", "/agents"],
          requester: "agent-name",
        },
      },
      evidence: ["http status", "screenshots", "trace", "video", "visible text", "console errors", "network failures", "artifact manifest"],
      result: "structured mission report with verdict, scores, blockers, findings, and evidence links",
    },
    {
      id: "targeted_read_only",
      status: basicFlowStatus,
      tier: 1,
      scope: "read_only",
      mutation: "stop_before_mutation",
      supportedEnvs: ["local", "preview", "testnet", "mainnet-read-only"],
      request: {
        body: {
          targetUrl: "https://app-or-site.example/path",
          goal: "Inspect the changed route like a new outside agent; stop before mutation.",
          allowTestMutations: false,
          requester: "agent-name",
        },
      },
      evidence: ["http status", "screenshots", "trace", "video", "visible text", "console errors", "network failures", "artifact manifest", "baseline comparison when available"],
      result: "structured mission report with verdict, blockers, confusing moments, mutation boundary notes, and evidence links",
    },
    {
      id: "authed_surface_sweep",
      status: authedSweepStatus,
      tier: 1,
      scope: "read_only",
      mutation: "never",
      supportedEnvs: ["testnet", "mainnet-read-only"],
      request: {
        body: {
          mode: "surface_sweep",
          targetUrl: "https://app.example",
          requester: "agent-name",
        },
      },
      note: sessionConfigured
        ? "Runner session injection (T2) is wired and a session source is configured: the sweep covers the authed operator pages (overview/runs/sessions/receipts/treasury/disputes/policies/agents/audit-log/capabilities) and applies the boundary-honesty check there. Read-only."
        : "Runner session injection (T2) is wired; set a session source on the runner (TESTBED_SESSION_SIGNER_URL via the T3 sidecar, or a manual TESTBED_SESSION_STORAGE_STATE_PATH/TOKEN). Until then the sweep runs public-only.",
    },
    {
      id: "siwe_auth_role_gating",
      status: siweStatus,
      tier: 1,
      scope: "read_only",
      mutation: "never",
      supportedEnvs: ["testnet"],
      dependsOn: ["T3 signer sidecar"],
      request: {
        body: {
          mode: "siwe_auth",
          targetUrl: env.AVERRAY_API_BASE_URL || "https://api.testnet.example",
          goal: "Verify SIWE sessions for agent/admin/verifier and prove wrong-role requests are rejected.",
          requester: "agent-name",
        },
      },
      evidence: ["JWT role claims by role", "agent -> admin 403 missing_role", "agent -> verifier 403", "no token -> wallet_sign_in"],
      result: "structured mission report with per-check findings and no token/key material",
    },
    {
      id: "gold_path",
      status: goldPathStatus,
      tier: 2,
      scope: "testbed_mutation_only",
      mutation: "testnet-only, never mainnet (T5 env->mutation binding; mainnet is structurally read-only)",
      supportedEnvs: ["local", "testnet", "staging"],
      dependsOn: ["T3 signer sidecar", "T5 env-to-mutation binding"],
      request: {
        body: {
          mode: "gold_path",
          targetUrl: "https://app.testnet.example",
          goal: "Attempt the agent gold path (onboard -> claim -> submit -> verify -> payout/SBT -> receipt) and judge honestly.",
          allowTestMutations: true,
          requester: "agent-name",
        },
      },
      note: goldPathLive
        ? `T4: the live Claude + Playwright-MCP gold-path driver is enabled. Operator-scheduled/per-deploy gold-path runs ${goldPathAutonomy ? "auto-run within TESTBED_GOLDPATH_* spend/safety caps" : "need TESTBED_GOLDPATH_AUTONOMY_ENABLED=1 plus budget caps before mutating"}; external agent requests still use the T6 request->approve gate. It uses the T3 signer sidecar for sessions and obeys T5 mutation binding (mainnet read-only).`
        : "T4: the live Claude + Playwright-MCP driver is wired but disabled by default. Until TESTBED_GOLDPATH_LIVE=1, the runner emits an honest \"not executed\" report rather than a fake pass.",
    },
  ];

  return {
    schemaVersion: 1,
    kind: "hermes_tester_capabilities",
    generatedAt: now.toISOString(),
    owner: "Hermes tester",
    truthBoundary: "This manifest lists only tester paths the reference-agent stack can currently request or observe.",
    endpoints: {
      capabilities: {
        method: "GET",
        path: "/monitor/tester/capabilities",
        auth: "same monitor auth as /monitor",
      },
      requestMission: {
        method: "POST",
        path: "/monitor/testbed-missions",
        auth: "monitor auth plus the mission-spawn role gate when configured",
        contentType: "application/json",
      },
      requestBoardGatedMission: {
        method: "POST",
        path: "/monitor/testbed-missions/request",
        auth: "same monitor auth as /monitor",
        contentType: "application/json",
      },
      approveRequestedMission: {
        method: "POST",
        path: "/monitor/testbed-missions/{id}/approve",
        auth: "monitor auth plus the mission-spawn role gate when configured",
      },
      listMissions: {
        method: "GET",
        path: "/monitor/testbed-missions?limit=20",
      },
      missionDetail: {
        method: "GET",
        path: "/monitor/testbed-missions/{id}",
      },
    },
    runtime: {
      runnerEnabled,
      runnerExecutor,
      runnerConfigured,
      missionEnvironment,
      evidenceCapture: {
        trace: env.TESTBED_MISSION_CAPTURE_TRACE === "0" || env.TESTBED_MISSION_CAPTURE_TRACE === "false" ? "disabled" : "enabled",
        video: env.TESTBED_MISSION_CAPTURE_VIDEO === "0" || env.TESTBED_MISSION_CAPTURE_VIDEO === "false" ? "disabled" : "enabled",
      },
      runner: deps.runner ?? null,
      signerSidecarEnabled: signerEnabled,
      authedSessionConfigured: sessionConfigured,
      authedSessionSource: sessionConfigured
        ? (env.TESTBED_SESSION_SIGNER_URL ? "test-wallet-signer sidecar" : "manual storageState/token")
        : (signerEnabled ? "signer sidecar available; set TESTBED_SESSION_SIGNER_URL on the runner" : "not configured"),
    },
    safety: {
      agentRequestedDefault: "read_only",
      mutationRule: "Mission env binds mutation mode: only local/testnet/staging can enable testbed-only mutations; unknown/preview/mainnet are read-only.",
      mainnetRule: "mainnet is read-only by design, even when allowTestMutations is requested",
      haltFile: "all runners remain subject to HALT_FILE",
      privateContextRule: "browser missions must use page-visible evidence, not private repo or monitor internals",
    },
    missionTypes,
    inventory: buildReadyToTestInventory({
      env,
      missionRuns,
      missionTypes,
      savedSuites: deps.savedSuites ?? [],
      runnerReady,
    }),
    approvalGate: {
      agentRequestedRuns: "external-agent requests use /monitor/testbed-missions/request and land as requested; runners ignore them until operator approval",
      currentEnforcement: "POST /monitor/testbed-missions still creates ready operator missions; POST /monitor/testbed-missions/{id}/approve is the T6 requested -> ready gate",
      goldPathAutonomy: "operator-scheduled/per-deploy gold-path missions can auto-run only when TESTBED_GOLDPATH_AUTONOMY_ENABLED=1 and the spend/safety budget, HALT_FILE, D3 anomaly pause, sponsored ready-job, and preflight checks pass",
      proposedMissionApproval: "available; board-gated and never automatic from agent request",
    },
    resultShape: {
      verdict: "pass | partial | fail",
      scores: "mission-specific numeric scores",
      blockers: "visible blockers or empty array",
      confusingMoments: "where the page required guessing",
      mutationBoundaryNotes: "what the tester stopped before or safely exercised",
      evidence: "bounded screenshots, Playwright trace/video artifacts, URLs, console/network findings, visible text, artifact manifest links, and baseline comparison when available",
      recommendations: "smallest product changes that help the next outside agent",
    },
    platformHelper: {
      status: "planned",
      repository: "averray-agent/agent",
      expectedShape: "thin helper that POSTs to /monitor/testbed-missions and prints the board link",
    },
  };
}

function truthy(value: string | undefined): boolean {
  return value === "1" || value === "true";
}

function runnerExecutorMode(env: Record<string, string | undefined>): "playwright" | "command" {
  const normalized = env.TESTBED_MISSION_RUNNER_EXECUTOR?.trim().toLowerCase();
  if (normalized === "command" || normalized === "external") return "command";
  if (normalized === "playwright" || normalized === "browser" || normalized === "real-browser") return "playwright";
  return env.TESTBED_MISSION_RUNNER_COMMAND?.trim() ? "command" : "playwright";
}

function buildReadyToTestInventory(input: {
  env: Record<string, string | undefined>;
  missionRuns: TestbedMissionRun[];
  missionTypes: Array<{ id: string; status: string; scope: string; mutation: string }>;
  savedSuites: TesterSavedSuite[];
  runnerReady: boolean;
}) {
  const missionTypesById = new Map(input.missionTypes.map((flow) => [flow.id, flow]));
  const recentRuns = input.missionRuns
    .slice()
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 20)
    .map((run) => ({
      id: run.id,
      name: run.title,
      flow: missionFlowId(run),
      target: run.targetUrl,
      status: run.status,
      environment: run.environment,
      mutationMode: run.mutationMode,
      lastRun: lastRunFromMission(run),
    }));

  return {
    status: input.runnerReady ? "ready" : "not_ready",
    savedSuitesAvailable: input.savedSuites.length > 0,
    savedSuitesStore: input.savedSuites.length > 0 ? "provided" : "not_wired",
    savedSuites: input.savedSuites.map((suite) => {
      const flow = missionTypesById.get(suite.flow);
      const lastRun = suite.lastRun ?? lastRunForSuite(suite, input.missionRuns);
      return {
        ...suite,
        status: suite.status ?? (flow?.status === "available" || flow?.status === "available_live_driver" ? "available" : "unavailable"),
        flowStatus: flow?.status ?? "unknown_flow",
        ...(lastRun ? { lastRun } : {}),
      };
    }),
    recentRuns,
    targets: buildTargetInventory(input.env, input.missionRuns),
  };
}

function buildTargetInventory(env: Record<string, string | undefined>, missionRuns: TestbedMissionRun[]) {
  const targets = new Map<string, {
    id: string;
    label: string;
    url: string;
    source: string;
    environment: TestbedMissionEnvironment;
    reachability: Record<string, unknown>;
    mutationProfile: {
      mode: TestbedMissionMutationMode;
      allowTestMutations: boolean;
      scope: string;
      reason: string;
    };
  }>();

  const add = (input: { id: string; label: string; url?: string; source: string; mode?: TestbedMissionMode; requestMutation?: boolean }) => {
    if (!input.url) return;
    const binding = resolveTestbedMutationBinding({
      targetUrl: input.url,
      mode: input.mode,
      requestedAllowTestMutations: input.requestMutation === true,
      configuredEnvironment: env.TESTBED_MISSION_ENVIRONMENT || env.AVERRAY_TESTBED_ENVIRONMENT,
    });
    targets.set(input.id, {
      id: input.id,
      label: input.label,
      url: input.url,
      source: input.source,
      environment: binding.environment,
      reachability: reachabilityForTarget(input.url, missionRuns),
      mutationProfile: {
        mode: binding.mutationMode,
        allowTestMutations: binding.allowTestMutations,
        scope: binding.mutationScope,
        reason: binding.reason,
      },
    });
  };

  add({
    id: "public_surface",
    label: "Public surface",
    url: env.TESTBED_SURFACE_SWEEP_BASE_URL || env.AVERRAY_PUBLIC_BASE_URL || "https://averray.com",
    source: env.TESTBED_SURFACE_SWEEP_BASE_URL || env.AVERRAY_PUBLIC_BASE_URL ? "env" : "default",
    mode: "surface_sweep",
  });
  add({
    id: "operator_app",
    label: "Operator app",
    url: env.AVERRAY_APP_BASE_URL,
    source: "env",
  });
  add({
    id: "platform_api",
    label: "Platform API",
    url: env.AVERRAY_API_BASE_URL,
    source: "env",
    mode: "siwe_auth",
  });

  for (const run of missionRuns) {
    const id = `recent:${stableTargetId(run.targetUrl)}`;
    if (targets.has(id)) continue;
    add({
      id,
      label: "Recent mission target",
      url: run.targetUrl,
      source: "mission_history",
      mode: run.mode,
      requestMutation: run.requestedAllowTestMutations === true,
    });
  }

  return Array.from(targets.values());
}

function reachabilityForTarget(targetUrl: string, missionRuns: TestbedMissionRun[]): Record<string, unknown> {
  const latest = missionRuns
    .filter((run) => run.targetUrl === targetUrl)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  if (!latest) {
    return {
      status: "not_checked_by_manifest",
      note: "This GET does not probe targets; reachability is reported only from previous mission evidence.",
    };
  }
  return {
    status: latest.status === "completed" ? "reachable_last_run_passed" : latest.status === "failed" ? "last_run_failed" : "last_run_incomplete",
    missionId: latest.id,
    checkedAt: latest.completedAt ?? latest.failedAt ?? latest.updatedAt,
    verdict: lastRunFromMission(latest).verdict,
  };
}

function missionFlowId(run: TestbedMissionRun): string {
  if (run.mode === "gold_path") return "gold_path";
  if (run.mode === "siwe_auth") return "siwe_auth_role_gating";
  if (run.mode === "surface_sweep") return "surface_sweep";
  return "targeted_read_only";
}

function lastRunForSuite(suite: TesterSavedSuite, runs: TestbedMissionRun[]): TesterInventoryLastRun | undefined {
  const run = runs
    .filter((candidate) => candidate.targetUrl === suite.target && missionFlowId(candidate) === suite.flow)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  return run ? lastRunFromMission(run) : undefined;
}

function lastRunFromMission(run: TestbedMissionRun): TesterInventoryLastRun {
  return {
    missionId: run.id,
    verdict: missionVerdict(run),
    at: run.completedAt ?? run.failedAt ?? run.updatedAt,
  };
}

function missionVerdict(run: TestbedMissionRun): TesterInventoryLastRun["verdict"] {
  const structured = run.result && typeof run.result === "object" && !Array.isArray(run.result)
    ? run.result as Record<string, unknown>
    : {};
  const nested = structured.structuredReport && typeof structured.structuredReport === "object" && !Array.isArray(structured.structuredReport)
    ? structured.structuredReport as Record<string, unknown>
    : {};
  const verdict = typeof nested.verdict === "string" ? nested.verdict : typeof structured.verdict === "string" ? structured.verdict : undefined;
  if (verdict === "pass" || verdict === "partial" || verdict === "fail") return verdict;
  if (run.status === "completed") return "pass";
  if (run.status === "failed") return "failed";
  if (run.status === "requested" || run.status === "ready" || run.status === "running") return run.status;
  return "unknown";
}

function stableTargetId(targetUrl: string): string {
  return targetUrl.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "target";
}
