import { describe, expect, it } from "vitest";

import {
  isMonitorAuthorized,
  parseMonitorConfig,
  renderMonitorHtml,
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

  it("renders a self-refreshing monitor shell without executing operator commands", () => {
    const html = renderMonitorHtml({
      title: "Pascal Monitor",
      eventsPath: "/monitor/events",
    });

    expect(html).toContain("<title>Pascal Monitor</title>");
    expect(html).toContain("Live private view of agent-to-agent handoffs.");
    expect(html).toContain("Active / Just Finished");
    expect(html).toContain("Blocked / Human Review");
    expect(html).toContain("Live Lane");
    expect(html).toContain("Live state");
    expect(html).toContain("JUST FINISHED");
    expect(html).toContain("state-pill");
    expect(html).toContain("PR Board");
    expect(html).toContain("release queue");
    expect(html).toContain("data-pipeline-filter=\"all\"");
    expect(html).toContain("data-pipeline-filter=\"block\"");
    expect(html).toContain("data-pipeline-filter=\"needs-review\"");
    expect(html).toContain("data-pipeline-filter=\"pass\"");
    expect(html).toContain("data-pipeline-filter=\"running\"");
    expect(html).toContain("PR Pipeline");
    expect(html).toContain("stage view");
    expect(html).toContain("Next actor");
    expect(html).toContain("PR");
    expect(html).toContain("CI");
    expect(html).toContain("Hermes");
    expect(html).toContain("Testbed");
    expect(html).toContain("Gate");
    expect(html).toContain("Deploy");
    expect(html).toContain("const eventsPath = \"/monitor/events\";");
    expect(html).toContain("Release Gate");
    expect(html).toContain("blocks + human review");
    expect(html).toContain("Release Timeline");
    expect(html).toContain("auto-refresh 5s");
    expect(html).toContain("activeWindowMinutes: \"240\"");
    expect(html).toContain("limit: \"50\"");
    expect(html).toContain("releaseVerdict(item)");
    expect(html).toContain("renderPipelineBoard(latestPipelineItems)");
    expect(html).toContain("latestPipelineItems = collectPipelineItems(payload)");
    expect(html).toContain("filterPipelineItems(entries)");
    expect(html).toContain("updatePipelineFilterButtons()");
    expect(html).toContain("pipelineStage(item, verdict)");
    expect(html).toContain("nextPipelineActor(item, verdict)");
    expect(html).toContain("renderPipelineSteps(stage, verdict)");
    expect(html).toContain("classifyReleaseGate(status, finalVerdict, mergeRecommendation, reason, reviewReasons)");
    expect(html).toContain("reviewSignalRows(summary)");
    expect(html).toContain("reviewReasonRows(summary)");
    expect(html).toContain("Missing tests");
    expect(html).toContain("Rollout notes");
    expect(html).toContain("Touched");
    expect(html).toContain("Review why");
    expect(html).toContain("releaseReason(summary, item, terminal.level)");
    expect(html).toContain("derivePullRequestUrl(item)");
    expect(html).toContain("deriveCommitUrl(item)");
    expect(html).toContain("deriveWorkflowRunUrl(item)");
    expect(html).toContain("Health failures");
    expect(html).toContain("Failed runs");
    expect(html).toContain("Active runs");
    expect(html).toContain("https://github.com/");
    expect(html).not.toContain("handleOperatorCommand");
  });
});
