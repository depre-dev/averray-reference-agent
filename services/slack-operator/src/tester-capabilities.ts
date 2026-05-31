import type { TestbedMissionRunnerHeartbeat } from "./monitor-testbed-missions.js";

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
      runner: deps.runner ?? null,
      signerSidecarEnabled: signerEnabled,
      authedSessionSource: signerEnabled ? "test-wallet-signer sidecar" : "not currently advertised",
    },
    safety: {
      agentRequestedDefault: "read_only",
      mutationRule: "Agents may request read-only runs only. Testbed mutation and gold-path runs are operator-only.",
      mainnetRule: "mainnet is read-only by design",
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
        evidence: ["http status", "screenshots", "visible text", "console errors", "network failures", "artifact manifest"],
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
        evidence: ["http status", "screenshots", "visible text", "console errors", "network failures", "artifact manifest"],
        result: "structured mission report with verdict, blockers, confusing moments, mutation boundary notes, and evidence links",
      },
      {
        id: "authed_surface_sweep",
        status: signerEnabled ? "session_source_available" : "planned",
        tier: 1,
        scope: "read_only",
        mutation: "never",
        supportedEnvs: ["testnet", "mainnet-read-only"],
        dependsOn: ["T2 pre-seeded session runner wiring", "T3 signer sidecar"],
        note: signerEnabled
          ? "The signer sidecar can mint sessions, but runner session injection is still a separate capability."
          : "Requires the signer sidecar and runner session injection before agents should rely on it.",
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
      evidence: "bounded screenshots, URLs, console/network findings, visible text, and artifact manifest links",
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
