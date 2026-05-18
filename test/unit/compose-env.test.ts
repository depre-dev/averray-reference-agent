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
});
