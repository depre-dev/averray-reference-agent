import { describe, expect, it } from "vitest";

import {
  guardMonitorCommand,
  isMonitorAuthorized,
  parseMonitorConfig,
  renderMonitorHtml,
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
      codexTasksPath: "/monitor/codex-tasks",
      recheckPath: "/monitor/recheck",
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
    expect(html).toContain("what is happening now");
    expect(html).toContain("agent-activity");
    expect(html).toContain("Live agent activity");
    expect(html).toContain("Activity stream");
    expect(html).toContain("Needs Attention");
    expect(html).toContain("Codex Needed");
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
    expect(html).toContain("renderActionRecipe(item, summary, verdict, action)");
    expect(html).toContain("actionRecipeForItem(item, summary, verdict, action)");
    expect(html).toContain("renderCodexTaskPrompt(item, summary, verdict, action)");
    expect(html).toContain("codexWorkState(item, stage)");
    expect(html).toContain("codexTaskCompletedAfterHermesReview(item)");
    expect(html).toContain("latestHermesReviewMs(item)");
    expect(html).toContain("HERMES RECHECK");
    expect(html).toContain("Ask Hermes to re-check");
    expect(html).toContain("Codex task runner reported this task completed. Hermes should re-check");
    expect(html).toContain("CODEX FAILED");
    expect(html).toContain("Propose retry");
    expect(html).toContain("data-hermes-recheck");
    expect(html).toContain("handleHermesRecheckAction(recheckButton)");
    expect(html).toContain("fetch(recheckUrl");
    expect(html).toContain("isCodexActivelyWorking");
    expect(html).toContain("Copy for Codex app");
    expect(html).toContain("Propose Codex task");
    expect(html).toContain("Approve Codex task");
    expect(html).toContain("Codex task queue");
    expect(html).toContain("codex-queue-progress");
    expect(html).toContain("codex-task-events");
    expect(html).toContain("renderCodexTaskProgress(task)");
    expect(html).toContain("renderCodexTaskEvents(task)");
    expect(html).toContain("latestCodexTasks");
    expect(html).toContain("normalizeCodexTasks(payload.codexTasks)");
    expect(html).toContain("codexTaskForItem(item)");
    expect(html).toContain("data-codex-task-action");
    expect(html).toContain("handleCodexTaskAction(codexTaskButton)");
    expect(html).toContain("fetch(codexTasksUrl");
    expect(html).toContain("Waiting for Codex");
    expect(html).toContain("CI after Codex");
    expect(html).toContain("No active Codex run detected");
    expect(html).toContain("paste it into a Codex thread/app");
    expect(html).toContain("isCodexTaskPromptText(text)");
    expect(html).toContain("verdict.level === \"needs-review\" && !isDraftPullRequest(item) && !locallyApproved");
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
    expect(html).toContain("renderAgentActivity(latestPipelineItems");
    expect(html).toContain("codexAgentSnapshot(items)");
    expect(html).toContain("hermesAgentSnapshot(items, activeEntries)");
    expect(html).toContain("renderActivityStream(items, activeEntries, recentEntries)");
    expect(html).toContain("buildActivityStreamItems(items, activeEntries, recentEntries)");
    expect(html).toContain("Codex task runner is actively working on this task");
    expect(html).toContain("setMonitorPaused");
    expect(html).toContain("toggleChecklistItem(decisionKey, itemId, checked)");
    expect(html).toContain("data-command-suggestion=\"what is happening now\"");
    expect(html).toContain("data-command-suggestion=\"what is Codex doing\"");
    expect(html).toContain("data-command-suggestion=\"what is Hermes doing\"");
    expect(html).toContain("data-command-suggestion=\"what needs my action\"");
    expect(html).toContain("isMonitorInsightCommand(text)");
    expect(html).toContain("renderMonitorConsoleInsight(text, item)");
    expect(html).toContain("renderNowConsoleInsight()");
    expect(html).toContain("renderLaneConsoleInsight(\"Codex\"");
    expect(html).toContain("renderSelectedConsoleInsight(item)");
    expect(html).toContain("currentMonitorMetrics(items)");
    expect(html).toContain("data-command-suggestion=\"handoff monitor details\"");
    expect(html).toContain("data-command-suggestion=\"merge steward details\"");
    expect(html).toContain("data-command-suggestion=\"github status\"");
    expect(html).toContain("data-command-suggestion=\"ops health\"");
    expect(html).toContain("const eventsPath = \"/monitor/events\";");
    expect(html).toContain("const streamPath = \"/monitor/stream\";");
    expect(html).toContain("const commandPath = \"/monitor/command\";");
    expect(html).toContain("const codexTasksPath = \"/monitor/codex-tasks\";");
    expect(html).toContain("const recheckPath = \"/monitor/recheck\";");
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
    expect(html).toContain("keepCurrentDeployItems(entries)");
    expect(html).toContain("prIdentityKey(item)");
    expect(html).toContain("renderPipelineSteps(stage, verdict)");
    expect(html).toContain("renderPrTimeline(item, stage, verdict, action)");
    expect(html).toContain("renderDecisionActions(item)");
    expect(html).toContain("buildFixRequest(item, summary, verdict, action)");
    expect(html).toContain("Fix this block");
    expect(html).toContain("Handoff owner");
    expect(html).toContain("Action recipe");
    expect(html).toContain("Clears when");
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

    // Mobile surface — PWA, lane tabs, FAB, bottom-sheet drawer, pull-to-refresh.
    expect(html).toContain('<link rel="manifest" href="/monitor/manifest.webmanifest">');
    expect(html).toContain('<meta name="theme-color" content="#0c1713">');
    expect(html).toContain('apple-touch-icon');
    expect(html).toContain('id="mobile-tabs"');
    expect(html).toContain('data-mobile-tab="attention"');
    expect(html).toContain('data-mobile-tab="operator"');
    expect(html).toContain('id="fab-ask"');
    expect(html).toContain('id="ask-sheet"');
    expect(html).toContain('id="ask-sheet-scrim"');
    expect(html).toContain('id="pull-indicator"');
    expect(html).toContain('@media (max-width: 640px)');
    expect(html).toContain('isMobileViewport');
    expect(html).toContain('updateMobileTabCounts(filtered)');
    expect(html).toContain('submitMonitorCommandFrom(text');
    expect(html).toContain('drawer-handle');
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
