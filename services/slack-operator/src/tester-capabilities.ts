import type { TestbedMissionRunnerHeartbeat } from "./monitor-testbed-missions.js";
import { isSweepSessionConfigured, parseSweepSessionConfig } from "./testbed-session.js";

export interface TesterCapabilitiesDeps {
  now?: Date;
  env?: Record<string, string | undefined>;
  runner?: TestbedMissionRunnerHeartbeat | null;
}

export function buildTesterCapabilitiesManifest(deps: TesterCapabilitiesDeps = {}) {
  const env = deps.env ?? process.env;
  const now = deps.now ?? new Date();
  const runnerEnabled = truthy(env.TESTBED_MISSION_RUNNER_ENABLED);
  const signerEnabled = truthy(env.TEST_WALLET_SIGNER_ENABLED);
  const runnerExecutor = env.TESTBED_MISSION_RUNNER_EXECUTOR || "playwright";
  const missionEnvironment = env.TESTBED_MISSION_ENVIRONMENT || env.AVERRAY_TESTBED_ENVIRONMENT || "inferred_from_target_url";
  // T2: the runner now injects a pre-seeded session into the sweep. The authed
  // sweep is genuinely available once a session SOURCE is configured (the
  // signer sidecar URL, or a manual storageState path / token).
  const sessionConfigured = isSweepSessionConfigured(parseSweepSessionConfig(env as NodeJS.ProcessEnv));

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
    missionTypes: [
      {
        id: "surface_sweep",
        status: "available",
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
        status: "available",
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
        status: sessionConfigured ? "available" : "ready_needs_session",
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
        status: signerEnabled ? "available" : "planned",
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
        status: "operator_only_design",
        tier: 2,
        scope: "testbed_mutation_only",
        mutation: "testnet-only, never mainnet",
        supportedEnvs: ["testnet"],
        dependsOn: ["T3 signer sidecar", "T4 tier-2 agent executor", "T5 env-to-mutation binding"],
        note: "Not agent-requestable from this manifest yet.",
      },
    ],
    approvalGate: {
      agentRequestedRuns: "read-only requests are monitor-gated; mutating missions remain operator-only",
      currentEnforcement: "POST /monitor/testbed-missions requires monitor auth and, when configured, a Cloudflare Access mission operator/admin allowlist",
      proposedMissionApproval: "planned T6 board approval flow; not advertised as automatic here",
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
