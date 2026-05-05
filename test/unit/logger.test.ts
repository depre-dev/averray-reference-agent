import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("shared MCP logger", () => {
  it("writes diagnostics to stderr so stdio stdout remains JSON-RPC-only", () => {
    const script = [
      "import { logger } from './packages/mcp-common/src/logger.ts';",
      "logger.info({ component: 'mcp-stdio' }, 'mcp_stdio_log_test');",
      "await new Promise((resolve) => setTimeout(resolve, 20));"
    ].join("\n");

    const result = spawnSync(process.execPath, ["--import", "tsx", "-e", script], {
      cwd: process.cwd(),
      encoding: "utf8"
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toContain("mcp_stdio_log_test");
    expect(result.stdout).toBe("");
  });
});
