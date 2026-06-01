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
    expect(env?.HERMES_MONITOR_REPLY_MODEL).toBe("${HERMES_MONITOR_REPLY_MODEL:-deepseek-v4-pro:cloud}");
  });

  it("keeps bootstrap-generated env files on the documented Hermes pin", () => {
    const envExample = readText("../../ops/.env.example");
    const bootstrap = readText("../../scripts/bootstrap-wallet.sh");
    const pin = envExample.match(/^HERMES_IMAGE=(.+)$/m)?.[1];

    expect(pin).toBeTruthy();
    expect(bootstrap).toContain(`HERMES_IMAGE=${pin}`);
    expect(envExample).toContain("HERMES_MONITOR_REPLY_MODEL=deepseek-v4-pro:cloud");
    expect(bootstrap).toContain("HERMES_MONITOR_REPLY_MODEL=deepseek-v4-pro:cloud");
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
});
