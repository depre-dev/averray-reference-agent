import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

function readText(path: string): string {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

describe("compose environment wiring", () => {
  it("passes Hermes monitor voice provider settings into slack-operator", () => {
    const compose = parse(readText("../../ops/compose.yml")) as {
      services?: Record<string, { environment?: Record<string, string> }>;
    };

    const env = compose.services?.["slack-operator"]?.environment;
    expect(env?.OLLAMA_API_KEY).toBe("${OLLAMA_API_KEY:-}");
    expect(env?.OLLAMA_BASE_URL).toBe("${OLLAMA_BASE_URL:-https://ollama.com/v1}");
    expect(env?.HERMES_MONITOR_REPLY_MODEL).toBe("${HERMES_MONITOR_REPLY_MODEL:-glm-5.2:cloud}");
    expect(env?.LLM_USAGE_LOG_PATH).toBe("${LLM_USAGE_LOG_PATH:-/data/llm-usage.jsonl}");
  });

  it("forwards every product-health source control into slack-operator", () => {
    const compose = parse(readText("../../ops/compose.yml")) as {
      services?: Record<string, { environment?: Record<string, string> }>;
    };
    const env = compose.services?.["slack-operator"]?.environment;
    const source = [
      readText("../../services/slack-operator/src/product-health.ts"),
      readText("../../services/slack-operator/src/routines.ts"),
      readText("../../services/slack-operator/src/ops-remediation.ts"),
    ].join("\n");
    const sourceControls = new Set(
      source.match(/(?:PRODUCT_HEALTH|OPS_AUTOREMEDIATE)_[A-Z0-9_]+/g) ?? [],
    );

    for (const control of sourceControls) {
      expect(env, `${control} is present in source but missing from Compose`).toHaveProperty(control);
    }

    expect(env?.PRODUCT_HEALTH_INTERVAL_MINUTES).toBe("${PRODUCT_HEALTH_INTERVAL_MINUTES:-2}");
    expect(env?.PRODUCT_HEALTH_ALERT_COOLDOWN_MINUTES).toBe("${PRODUCT_HEALTH_ALERT_COOLDOWN_MINUTES:-360}");
    expect(env?.PRODUCT_HEALTH_CHAIN_MAX_STALE_SECONDS).toBe("${PRODUCT_HEALTH_CHAIN_MAX_STALE_SECONDS:-600}");
    expect(env?.PRODUCT_HEALTH_HALT_SEVERITY).toBe("${PRODUCT_HEALTH_HALT_SEVERITY:-auto}");
    expect(env?.PRODUCT_HEALTH_MIN_GAS_NATIVE).toBe("${PRODUCT_HEALTH_MIN_GAS_NATIVE:-0}");
    expect(env?.PRODUCT_HEALTH_MIN_REWARD_BANK).toBe("${PRODUCT_HEALTH_MIN_REWARD_BANK:-0}");
    expect(env?.PRODUCT_HEALTH_MIN_TREASURY_RESERVE).toBe("${PRODUCT_HEALTH_MIN_TREASURY_RESERVE:-5}");
    expect(env?.PRODUCT_HEALTH_TREASURY_RESERVE_ZERO_REASON).toBe("${PRODUCT_HEALTH_TREASURY_RESERVE_ZERO_REASON:-}");
    expect(env?.PRODUCT_HEALTH_RPC_BACKUPS).toBe("${PRODUCT_HEALTH_RPC_BACKUPS:-}");
    expect(env?.OPS_AUTOREMEDIATE_ENABLED).toBe("${OPS_AUTOREMEDIATE_ENABLED:-false}");
    expect(env?.GITHUB_MONITOR_ENRICH_TIMEOUT_MS).toBe("${GITHUB_MONITOR_ENRICH_TIMEOUT_MS:-2500}");
  });

  it("records the mainnet-only monitor calibration without changing testnet defaults", () => {
    const calibration = readText("../../ops/.env.mainnet-monitor.example");

    expect(calibration).toContain("PRODUCT_HEALTH_INTERVAL_MINUTES=5");
    expect(calibration).toContain("PRODUCT_HEALTH_ALERT_COOLDOWN_MINUTES=30");
    expect(calibration).toContain("PRODUCT_HEALTH_MIN_TREASURY_RESERVE=0");
    expect(calibration).toContain(
      "PRODUCT_HEALTH_TREASURY_RESERVE_ZERO_REASON=Mainnet payouts are funded from the signer reward bank; the treasury multisig intentionally holds no USDC float.",
    );
    expect(calibration).toContain("PRODUCT_HEALTH_RPC_URL=https://services.polkadothub-rpc.com/mainnet/");
    expect(calibration).toContain("PRODUCT_HEALTH_RPC_BACKUPS=https://eth-rpc.polkadot.io/");
    expect(calibration).toContain("OPS_AUTOREMEDIATE_ENABLED=true");
    expect(calibration).toContain("GITHUB_MONITOR_ENRICH_TIMEOUT_MS=5000");
  });

  it("passes the shared LLM usage log path into Hermes and its MCP env", () => {
    const compose = parse(readText("../../ops/compose.yml")) as {
      services?: Record<string, { environment?: Record<string, string> }>;
    };

    expect(compose.services?.hermes?.environment?.LLM_USAGE_LOG_PATH).toBe("${LLM_USAGE_LOG_PATH:-/data/llm-usage.jsonl}");
    expect(compose.services?.["mcp-env"]?.environment?.LLM_USAGE_LOG_PATH).toBe("${LLM_USAGE_LOG_PATH:-/data/llm-usage.jsonl}");
  });

  it("keeps bootstrap-generated env files on the documented Hermes pin", () => {
    const envExample = readText("../../ops/.env.example");
    const bootstrap = readText("../../scripts/bootstrap-wallet.sh");
    const pin = envExample.match(/^HERMES_IMAGE=(.+)$/m)?.[1];

    expect(pin).toBeTruthy();
    expect(bootstrap).toContain(`HERMES_IMAGE=${pin}`);
    expect(envExample).toContain("HERMES_MONITOR_REPLY_MODEL=glm-5.2:cloud");
    expect(envExample).toContain("LLM_USAGE_LOG_PATH=/data/llm-usage.jsonl");
    expect(bootstrap).toContain("HERMES_MONITOR_REPLY_MODEL=glm-5.2:cloud");
  });

  it("wires the T3 test-wallet signer sidecar behind an opt-in localhost profile", () => {
    const compose = parse(readText("../../ops/compose.yml")) as {
      services?: Record<string, { profiles?: string[]; ports?: string[]; environment?: Record<string, string> }>;
    };
    const service = compose.services?.["test-wallet-signer"];

    expect(service?.profiles).toEqual(["test-wallet-signer"]);
    expect(service?.ports).toEqual(["127.0.0.1:${TEST_WALLET_SIGNER_PORT:-8791}:${TEST_WALLET_SIGNER_PORT:-8791}"]);
    expect(service?.environment?.TEST_WALLET_SIGNER_ENABLED).toBe("${TEST_WALLET_SIGNER_ENABLED:-0}");
    expect(service?.environment?.TEST_WALLET_ADMIN_PRIVATE_KEY).toBe("${TEST_WALLET_ADMIN_PRIVATE_KEY:-}");

    const envExample = readText("../../ops/.env.example");
    const bootstrap = readText("../../scripts/bootstrap-wallet.sh");
    expect(envExample).toContain("TEST_WALLET_SIGNER_ENABLED=0");
    expect(envExample).toContain("TEST_WALLET_VERIFIER_PRIVATE_KEY=");
    expect(bootstrap).toContain("TEST_WALLET_AGENT_PRIVATE_KEY=");
    expect(bootstrap).toContain("TEST_WALLET_ADMIN_PRIVATE_KEY=");
    expect(bootstrap).toContain("TEST_WALLET_VERIFIER_PRIVATE_KEY=");
  });

  it("keeps C3 security/docs specialist runners off by default and pinned to their agents", () => {
    const compose = parse(readText("../../ops/compose.yml")) as {
      services?: Record<string, { profiles?: string[]; environment?: Record<string, string> }>;
    };

    const security = compose.services?.["security-task-runner"];
    const docs = compose.services?.["docs-task-runner"];

    expect(security?.profiles).toEqual(["security-runner"]);
    expect(security?.environment?.CLAUDE_TASK_RUNNER_ENABLED).toBe("${SECURITY_TASK_RUNNER_ENABLED:-0}");
    expect(security?.environment?.CLAUDE_TASK_RUNNER_AGENT).toBe("security");
    expect(security?.environment?.CLAUDE_TASK_RUNNER_ARGS).toBe("${SECURITY_TASK_RUNNER_ARGS:-services/slack-operator/dist/security-branch-worker.js}");
    expect(docs?.profiles).toEqual(["docs-runner"]);
    expect(docs?.environment?.CLAUDE_TASK_RUNNER_ENABLED).toBe("${DOCS_TASK_RUNNER_ENABLED:-0}");
    expect(docs?.environment?.CLAUDE_TASK_RUNNER_AGENT).toBe("docs");
    expect(docs?.environment?.CLAUDE_TASK_RUNNER_ARGS).toBe("${DOCS_TASK_RUNNER_ARGS:-services/slack-operator/dist/docs-branch-worker.js}");

    const envExample = readText("../../ops/.env.example");
    expect(envExample).toContain("SECURITY_TASK_RUNNER_ENABLED=0");
    expect(envExample).toContain("DOCS_TASK_RUNNER_ENABLED=0");
  });

  it("wires ORCH-P4b Hermes router off by default with bounded proposal controls", () => {
    const compose = parse(readText("../../ops/compose.yml")) as {
      services?: Record<string, { environment?: Record<string, string> }>;
    };

    const env = compose.services?.["slack-operator"]?.environment;
    expect(env?.HERMES_ROUTER_ENABLED).toBe("${HERMES_ROUTER_ENABLED:-0}");
    expect(env?.HERMES_ROUTER_INTERVAL_MINUTES).toBe("${HERMES_ROUTER_INTERVAL_MINUTES:-5}");
    expect(env?.HERMES_ROUTER_COOLDOWN_MINUTES).toBe("${HERMES_ROUTER_COOLDOWN_MINUTES:-30}");
    expect(env?.HERMES_ROUTER_MAX_PROPOSALS_PER_TICK).toBe("${HERMES_ROUTER_MAX_PROPOSALS_PER_TICK:-1}");
    expect(env?.HERMES_ROUTER_RECENTLY_DONE_LOOKBACK_HOURS).toBe("${HERMES_ROUTER_RECENTLY_DONE_LOOKBACK_HOURS:-72}");
    expect(env?.HERMES_ROUTER_BACKLOG_LIMIT).toBe("${HERMES_ROUTER_BACKLOG_LIMIT:-12}");
    expect(env?.HERMES_ROUTER_DEFAULT_REPO).toBe("${HERMES_ROUTER_DEFAULT_REPO:-}");

    const envExample = readText("../../ops/.env.example");
    expect(envExample).toContain("HERMES_ROUTER_ENABLED=0");
    expect(envExample).toContain("HERMES_ROUTER_MAX_PROPOSALS_PER_TICK=1");
    expect(envExample).toContain("HERMES_ROUTER_DEFAULT_REPO=");
  });

  it("passes observable bounded Claude branch-worker defaults into Claude-family runners", () => {
    const compose = parse(readText("../../ops/compose.yml")) as {
      services?: Record<string, { environment?: Record<string, string> }>;
    };
    for (const serviceName of ["claude-task-runner", "test-writer-task-runner", "security-task-runner", "docs-task-runner"]) {
      const env = compose.services?.[serviceName]?.environment;
      expect(env?.CLAUDE_TASK_RUNNER_TIMEOUT_MS).toBe("${CLAUDE_TASK_RUNNER_TIMEOUT_MS:-5400000}");
      expect(env?.CLAUDE_BRANCH_WORKER_OUTPUT_FORMAT).toBe("${CLAUDE_BRANCH_WORKER_OUTPUT_FORMAT:-stream-json}");
      expect(env?.CLAUDE_BRANCH_WORKER_PERMISSION_MODE).toBe("${CLAUDE_BRANCH_WORKER_PERMISSION_MODE:-acceptEdits}");
      expect(env?.CLAUDE_BRANCH_WORKER_VERBOSE).toBe("${CLAUDE_BRANCH_WORKER_VERBOSE:-1}");
    }

    const envExample = readText("../../ops/.env.example");
    expect(envExample).toContain("CLAUDE_BRANCH_WORKER_OUTPUT_FORMAT=stream-json");
    expect(envExample).toContain("CLAUDE_BRANCH_WORKER_PERMISSION_MODE=acceptEdits");
    expect(envExample).toContain("CLAUDE_BRANCH_WORKER_VERBOSE=1");
    expect(envExample).toContain("CLAUDE_TASK_RUNNER_TIMEOUT_MS=5400000");
  });
});
