import { describe, expect, it } from "vitest";

import {
  guardMonitorCommand,
  isMonitorAuthorized,
  parseMonitorConfig,
  renderMonitorManifest,
} from "../../services/slack-operator/src/monitor.js";

describe("slack operator personal monitor", () => {
  it("is opt-in and supports optional token protection", () => {
    expect(parseMonitorConfig({})).toEqual({ enabled: false, token: undefined });
    expect(parseMonitorConfig({
      SLACK_OPERATOR_MONITOR_ENABLED: "1",
      SLACK_OPERATOR_MONITOR_TOKEN: "secret",
    })).toEqual({ enabled: true, token: "secret" });
  });

  it("authorizes local monitor requests when no token is configured", () => {
    expect(isMonitorAuthorized(
      { enabled: true },
      {},
      new URL("http://localhost/monitor")
    )).toBe(true);
  });

  it("requires bearer or query token when configured", () => {
    const config = { enabled: true, token: "secret" };
    expect(isMonitorAuthorized(config, {}, new URL("http://localhost/monitor"))).toBe(false);
    expect(isMonitorAuthorized(
      config,
      { authorization: "Bearer secret" },
      new URL("http://localhost/monitor")
    )).toBe(true);
    expect(isMonitorAuthorized(
      config,
      {},
      new URL("http://localhost/monitor?token=secret")
    )).toBe(true);
  });

  it("guards the monitor command console to read-only and proposal commands", () => {
    expect(guardMonitorCommand("merge steward details")).toMatchObject({ allowed: true });
    expect(guardMonitorCommand("ops health")).toMatchObject({ allowed: true });
    expect(guardMonitorCommand("what should Hermes build next")).toMatchObject({ allowed: true });
    expect(guardMonitorCommand("propose deploy for averray-agent/agent sha abc1234")).toMatchObject({ allowed: true });
    expect(guardMonitorCommand("agent browser mission https://testbed.example/app goal: complete onboarding")).toMatchObject({ allowed: true });
    expect(guardMonitorCommand("agent browser mission https://testbed.example/app goal: complete onboarding test mode allow test mutations")).toMatchObject({ allowed: true });
    expect(guardMonitorCommand("agent browser mission https://testbed.example/app test mode deploy now")).toMatchObject({
      allowed: false,
      reason: "mutation_command_blocked",
    });
    expect(guardMonitorCommand("merge steward approve averray-agent/agent#123")).toMatchObject({
      allowed: false,
      reason: "mutation_command_blocked",
    });
    expect(guardMonitorCommand("run one wikipedia citation repair if safe")).toMatchObject({
      allowed: false,
      reason: "mutation_command_blocked",
    });
  });

  it("serves a PWA manifest with the canonical name + scope", () => {
    const manifestJson = renderMonitorManifest();
    const manifest = JSON.parse(manifestJson);
    expect(manifest.name).toBe("Hermes Handoff Monitor");
    expect(manifest.short_name).toBe("Hermes");
    expect(manifest.start_url).toBe("/monitor");
    expect(manifest.scope).toBe("/monitor");
    expect(manifest.display).toBe("standalone");
    expect(manifest.theme_color).toBe("#0c1713");
    expect(Array.isArray(manifest.icons)).toBe(true);
    expect(manifest.icons.length).toBeGreaterThan(0);
    expect(manifest.icons[0].type).toBe("image/svg+xml");
  });
});
