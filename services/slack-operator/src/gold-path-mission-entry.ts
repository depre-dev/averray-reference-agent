// T4 — Tier-2 gold-path mission command entrypoint.
//
// Spawned by the testbed mission runner's `command` executor (the runner passes
// the mission via TESTBED_* env + a TESTBED_MISSION_REPORT_PATH; this writes the
// structured report there and the runner ingests it). This is glue: it resolves
// the T5 mutation binding, the T3 session, the A4 model, picks a driver, runs the
// gold path, and writes the report.
//
// CI never reaches the live path: the live Claude Agent SDK / Claude Code +
// Playwright-MCP driver is opt-in (TESTBED_GOLDPATH_LIVE=1). The default stays
// fake/unavailable so tests never call a live model.

import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { redact } from "./codex-branch-worker.js";
import {
  resolveTestbedMutationBinding,
  testbedEnvironmentFromEnv,
} from "./testbed-mutation-binding.js";
import {
  parseCloudflareAccessServiceToken,
  resolveSweepSession,
  parseSweepSessionConfig,
} from "./testbed-session.js";
import {
  runGoldPathMissionOnce,
  pickGoldPathModel,
  createUnavailableGoldPathDriver,
  type GoldPathDriver,
  type GoldPathMissionResult,
} from "./gold-path-mission.js";
import {
  createClaudeGoldPathDriver,
  parseClaudeGoldPathDriverConfig,
} from "./gold-path-live-driver.js";

interface GoldPathMissionEnv {
  id: string;
  targetUrl: string;
  goal: string;
  freshMemory: boolean;
  requestedAllowTestMutations: boolean;
  environment?: string;
}

function readMissionFromEnv(env: NodeJS.ProcessEnv): GoldPathMissionEnv {
  return {
    id: env.TESTBED_MISSION_ID || "gold-path-mission",
    targetUrl: env.TESTBED_TARGET_URL || "",
    goal: env.TESTBED_MISSION_GOAL || "Attempt the agent gold path as an outside agent and judge honestly.",
    freshMemory: env.TESTBED_FRESH_MEMORY !== "false",
    requestedAllowTestMutations: env.TESTBED_REQUESTED_TEST_MUTATIONS === "true",
    ...(env.TESTBED_MISSION_ENVIRONMENT ? { environment: env.TESTBED_MISSION_ENVIRONMENT } : {}),
  };
}

/** Choose the driver. Live LLM is opt-in; default remains the honest fake. */
export function selectGoldPathDriver(env: NodeJS.ProcessEnv): GoldPathDriver {
  if (env.TESTBED_GOLDPATH_LIVE === "1") {
    return createClaudeGoldPathDriver(parseClaudeGoldPathDriverConfig(env), env);
  }
  return createUnavailableGoldPathDriver(
    "Gold-path runner is not in live mode (set TESTBED_GOLDPATH_LIVE=1 to use the Claude + Playwright-MCP driver); no real run performed.",
  );
}

export async function runGoldPathMissionEntry(
  env: NodeJS.ProcessEnv = process.env,
  deps: { driver?: GoldPathDriver } = {},
): Promise<GoldPathMissionResult> {
  const mission = readMissionFromEnv(env);

  // T5: re-resolve the mutation binding from the env here too, so the safety
  // boundary is enforced at the executor regardless of upstream — mainnet (and
  // any non-mutating env) is read-only, making a mutating gold-path against
  // mainnet structurally impossible.
  const binding = resolveTestbedMutationBinding({
    targetUrl: mission.targetUrl,
    mode: "gold_path",
    requestedAllowTestMutations: mission.requestedAllowTestMutations,
    configuredEnvironment: mission.environment ?? testbedEnvironmentFromEnv(env),
  });

  const model = pickGoldPathModel({
    deep: env.TESTBED_GOLDPATH_DEEP === "1",
    ...(env.TESTBED_GOLDPATH_MODEL ? { override: env.TESTBED_GOLDPATH_MODEL } : {}),
  });

  const driver = deps.driver ?? selectGoldPathDriver(env);
  const cloudflareAccess = parseCloudflareAccessServiceToken(env);

  const result = await runGoldPathMissionOnce({
    mission: { id: mission.id, targetUrl: mission.targetUrl, goal: mission.goal, freshMemory: mission.freshMemory },
    binding,
    driver,
    model,
    signerBaseUrl: env.TEST_WALLET_SIGNER_BASE_URL || env.TESTBED_SESSION_SIGNER_URL,
    ...(cloudflareAccess ? { cloudflareAccess } : {}),
    // T3: the API Bearer (and/or browser storageState) from the signer sidecar —
    // the wallet key never enters this process. Undefined when unconfigured.
    resolveSession: () => resolveSweepSession({ ...parseSweepSessionConfig(env), sessionType: "api" }),
  });

  const reportPath = env.TESTBED_MISSION_REPORT_PATH;
  if (reportPath) {
    await writeFile(reportPath, result.reportText);
  } else {
    process.stdout.write(result.reportText);
  }
  return result;
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  runGoldPathMissionEntry().catch((error) => {
    console.error(redact(error instanceof Error ? error.message : String(error)));
    process.exitCode = 1;
  });
}
