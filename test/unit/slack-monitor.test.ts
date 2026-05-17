import { describe, expect, it } from "vitest";

import {
  guardMonitorCommand,
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

  it("guards the monitor command console to read-only and proposal commands", () => {
    expect(guardMonitorCommand("merge steward details")).toMatchObject({ allowed: true });
    expect(guardMonitorCommand("ops health")).toMatchObject({ allowed: true });
    expect(guardMonitorCommand("propose deploy for averray-agent/agent sha abc1234")).toMatchObject({ allowed: true });
    expect(guardMonitorCommand("merge steward approve averray-agent/agent#123")).toMatchObject({
      allowed: false,
      reason: "mutation_command_blocked",
    });
    expect(guardMonitorCommand("run one wikipedia citation repair if safe")).toMatchObject({
      allowed: false,
      reason: "mutation_command_blocked",
    });
  });

  it("renders the command-center monitor shell without executing operator commands", () => {
    const html = renderMonitorHtml({
      title: "Pascal Monitor",
      eventsPath: "/monitor/events",
      streamPath: "/monitor/stream",
      commandPath: "/monitor/command",
    });

    expect(html).toContain("<title>Pascal Monitor</title>");
    expect(html).toContain("handoff monitor · averray");
    expect(html).toContain("command-shell");
    expect(html).toContain("cmdbar");
    expect(html).toContain("filterbar");
    expect(html).toContain("kanban-board");
    expect(html).toContain("data-done-expanded");
    expect(html).toContain("done-rail");
    expect(html).toContain("detail-drawer");
    expect(html).toContain("command-console");
    expect(html).toContain("Ask Hermes");
    expect(html).toContain("Read-only command console");
    expect(html).toContain("Needs Attention");
    expect(html).toContain("Codex Working");
    expect(html).toContain("Hermes Checking");
    expect(html).toContain("Operator Review");
    expect(html).toContain("Release Queue");
    expect(html).toContain("Deploying");
    expect(html).toContain("done lane");
    // Mockup-parity surface additions:
    expect(html).toContain("sys-agents");
    expect(html).toContain("deploy-health-chip");
    expect(html).toContain("cmd-status-rich");
    expect(html).toContain("sorted by next-action urgency");
    expect(html).toContain("id=\"pause\"");
    expect(html).toContain("renderFailureCallout(verdict, summary)");
    expect(html).toContain("renderBlockResolutionPanel(item, summary, verdict, action)");
    expect(html).toContain("blockResolutionPlan(item, summary, verdict, action)");
    expect(html).toContain("renderHermesVerdictBox(verdict, age)");
    expect(html).toContain("renderHandoffOwnerContract(item, verdict, action)");
    expect(html).toContain("ownerContractForItem(item, verdict, action)");
    expect(html).toContain("renderOperatorChecklistPanel(item, verdict, action)");
    expect(html).toContain("renderAgentPrecheckList(item, summary, verdict, stage)");
    expect(html).toContain("renderCheckMatrix(summary, testSignals)");
    expect(html).toContain("renderTouchedFiles(touchedFiles, touchedAreas)");
    expect(html).toContain("renderTimelineList(stage, verdict, item)");
    expect(html).toContain("renderReferencesKv(item, prUrl, workflowRunUrl, commitUrl, rollout, action)");
    expect(html).toContain("renderPhaseHistorySection(item)");
    expect(html).toContain("activeAgentForItem(item, lane, stage)");
    expect(html).toContain("updateDeployHealth(latestPipelineItems)");
    expect(html).toContain("updateSysAgents(latestPipelineItems)");
    expect(html).toContain("setMonitorPaused");
    expect(html).toContain("toggleChecklistItem(decisionKey, itemId, checked)");
    expect(html).toContain("data-command-suggestion=\"handoff monitor details\"");
    expect(html).toContain("data-command-suggestion=\"merge steward details\"");
    expect(html).toContain("data-command-suggestion=\"github status\"");
    expect(html).toContain("data-command-suggestion=\"ops health\"");
    expect(html).toContain("data-command-suggestion=\"codex handoff protocol\"");
    expect(html).toContain("const eventsPath = \"/monitor/events\";");
    expect(html).toContain("const streamPath = \"/monitor/stream\";");
    expect(html).toContain("const commandPath = \"/monitor/command\";");
    expect(html).toContain("new EventSource(streamUrl)");
    expect(html).toContain("addEventListener(\"monitor\"");
    expect(html).toContain("startPolling(\"polling fallback 5s\")");
    expect(html).toContain("fetch(commandUrl");
    expect(html).toContain("submitMonitorCommand(text)");
    expect(html).toContain("selectedKey");
    expect(html).toContain("autoFocusPending");
    expect(html).toContain("data-review-card");
    expect(html).toContain("defaultFocusItem(filtered)");
    expect(html).toContain("renderBoard(latestPipelineItems)");
    expect(html).toContain("renderDrawer(selectedItem())");
    expect(html).toContain("renderCommandContext()");
    expect(html).toContain("operatorChecklistSection(item, verdict, action)");
    expect(html).toContain("groupPhaseBadges(item)");
    expect(html).toContain("groupPrPipelineItems(entries)");
    expect(html).toContain("finalizePrGroup(items)");
    expect(html).toContain("prIdentityKey(item)");
    expect(html).toContain("renderPipelineSteps(stage, verdict)");
    expect(html).toContain("renderPrTimeline(item, stage, verdict, action)");
    expect(html).toContain("renderDecisionActions(item)");
    expect(html).toContain("buildFixRequest(item, summary, verdict, action)");
    expect(html).toContain("Fix this block");
    expect(html).toContain("Handoff owner");
    expect(html).toContain("Codex owns finishing it or marking it ready");
    expect(html).toContain("finish the draft or mark it ready for review");
    expect(html).toContain("Codex draft");
    expect(html).toContain("open a follow-up fix PR or rollback proposal");
    expect(html).toContain("hosted app/config health failure");
    expect(html).toContain("hosted health is ok and the post-deploy suite returns PASS");
    expect(html).toContain("Operator decision");
    expect(html).toContain("Operator decision request");
    expect(html).toContain("Approve only if");
    expect(html).toContain("Send back to Codex if");
    expect(html).toContain("Hermes has already done the code-level pre-check");
    expect(html).toContain("Request metadata preservation");
    expect(html).toContain("you are not being asked for line-by-line code review");
    expect(html).toContain("Operator approved");
    expect(html).toContain("No operator sign-off needed.");
    expect(html).toContain("private monitor decision only");
    expect(html).toContain("Missing tests");
    expect(html).toContain("Rollout notes");
    expect(html).toContain("Touched");
    expect(html).toContain("Review why");
    expect(html).toContain("Health failures");
    expect(html).toContain("Failed runs");
    expect(html).toContain("Active runs");
    expect(html).toContain("https://github.com/");
    expect(html).not.toContain("Blocked / Human Review");
    expect(html).not.toContain("Human needs");
    expect(html).not.toContain("handleOperatorCommandText");
  });
});
