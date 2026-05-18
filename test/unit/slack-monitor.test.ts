import { Script } from "node:vm";
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
    // Right-side 44px vertical Done expander rail. Clicking it triggers
    // the existing toggle-done button to expand the Done lane.
    expect(html).toContain("done-rail");
    expect(html).toContain('id="done-stub"');
    expect(html).toContain("renderDoneStub");
    expect(html).toContain("detail-drawer");
    expect(html).toContain("command-console");
    expect(html).toContain("Ask Hermes");
    expect(html).toContain("what is happening now");
    expect(html).toContain("Waiting for Hermes, Codex, and operator messages");
    expect(html).toContain('data-mode="thread"');
    expect(html).toContain("collab-thread");
    expect(html).toContain("collab-message");
    expect(html).toContain("console-compose");
    expect(html).toContain("Quick asks");
    expect(html).not.toContain("ci-grid");
    expect(html).toContain('data-auto="true"');
    expect(html).not.toContain('id="active" class="live-lane"');
    expect(html).not.toContain('id="agent-activity"');
    expect(html).not.toContain("Live agent activity");
    expect(html).toContain("Needs Attention");
    expect(html).toContain("Codex Needed");
    expect(html).toContain("Hermes Checking");
    expect(html).toContain("Operator Review");
    expect(html).toContain("Release Queue");
    expect(html).toContain("Deploying");
    expect(html).toContain("done lane");
    expect(html).toContain("flex-wrap: wrap");
    expect(html).toContain('setText("done-count"');
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
    expect(html).toContain("latestCodexRunner");
    expect(html).toContain("normalizeCodexTasks(payload.codexTasks)");
    expect(html).toContain("normalizeCodexRunner(payload.codexTasks && payload.codexTasks.runner)");
    expect(html).toContain("codexRunnerAgeLabel(runner)");
    expect(html).toContain("codexRunnerStatusLabel(latestCodexRunner)");
    expect(html).toContain("Codex worker online.");
    expect(html).toContain("Codex worker heartbeat is stale.");
    expect(html).toContain("No Codex heartbeat visible.");
    expect(html).toContain("runner heartbeat");
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
    expect(html).toContain("buildActivityStreamItems(items, activeEntries, recentEntries)");
    expect(html).toContain("renderMonitorLoadError(error)");
    expect(html).toContain("startPolling(\"polling 5s\")");
    expect(html).toContain("Codex task runner is actively working on this task");
    expect(html).toContain("setMonitorPaused");
    expect(html).toContain("toggleChecklistItem(decisionKey, itemId, checked)");
    expect(html).toContain("data-command-suggestion=\"what is happening now\"");
    expect(html).toContain("data-command-suggestion=\"what are agents doing\"");
    expect(html).toContain("data-command-suggestion=\"what is Codex doing\"");
    expect(html).toContain("data-command-suggestion=\"what is Hermes doing\"");
    expect(html).toContain("data-command-suggestion=\"what needs my action\"");
    expect(html).toContain("isMonitorInsightCommand(text)");
    expect(html).toContain("renderMonitorConsoleInsight(text, item)");
    expect(html).toContain("renderAutoCollaborationThread()");
    expect(html).toContain("renderCollaborationThread({ kind");
    expect(html).toContain("renderSelectedCollaborationThread(item)");
    expect(html).toContain("latestCodexTasks\n        .filter((task) => !isTerminalCodexTask(task))");
    expect(html).toContain("collaborationMessagesForTask(task)");
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
    expect(html).toContain("new AbortController()");
    expect(html).toContain("controller.abort()");
    expect(html).toContain("signal: controller.signal");
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
    expect(html).toContain("commandBoardLaneCounts(entries)");
    expect(html).toContain("renderDecisionActions(item)");
    expect(html).toContain("buildFixRequest(item, summary, verdict, action)");
    expect(html).toContain("Fix this block");
    expect(html).toContain("Handoff owner");
    expect(html).toContain("Action recipe");
    expect(html).toContain("Clears when");
    expect(html).toContain("Open fix plan");
    expect(html).toContain("Create Codex task");
    expect(html).toContain("Open risk review");
    expect(html).toContain("Ask merge steward");
    expect(html).toContain("waiting on");
    expect(html).toContain("Button");
    expect(html).toContain("After");
    expect(html).toContain("it does not start work yet");
    expect(html).toContain("this does not merge");
    expect(html).toContain("Codex owns finishing it or marking it ready");
    expect(html).toContain("finish the draft or mark it ready for review");
    expect(html).toContain("Open draft plan");
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
    expect(html).toContain("CRITICAL REVIEW");
    expect(html).toContain("Critical-file risk review");
    expect(html).toContain("Approve risk review");
    expect(html).toContain("Mark release reviewed");
    expect(html).toContain("Mark reviewed locally");
    expect(html).toContain("Operator review marked complete");
    expect(html).toContain("READY REVIEW");
    expect(html).toContain("Mark reviewed");
    expect(html).toContain("requiresReleaseReviewBeforeQueue(item, verdict)");
    expect(html).toContain("ready_for_operator_release_review");
    expect(html).toContain("quick release-packet review");
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

    // Real-message collaboration channel surface (PR: collab-room).
    expect(html).toContain('data-compose-mode="post"');
    expect(html).toContain('data-compose-mode="ask"');
    expect(html).toContain('id="compose-target"');
    expect(html).toContain('id="compose-intent"');
    expect(html).toContain('id="compose-status"');
    expect(html).toContain('"/monitor/collaboration"');
    expect(html).toContain('latestCollabMessages');
    expect(html).toContain('normalizeCollabMessages');
    expect(html).toContain('submitCollaborationPost');
    expect(html).toContain('data-posted="');
    expect(html).toContain('data-tag="proposal"');
    expect(html).toContain('data-tag="help"');
    expect(html).toContain('collab-addressed');

    // Collaboration thread (PR: collab-aesthetic): flat DOM, no avatar,
    // 3px left-rail in agent color, uppercase tracked speaker, system
    // note for idle, force-thread reset after Ask Hermes.
    expect(html).toContain('forceThreadMode');
    expect(html).toContain('data-speaker="operator"');
    expect(html).toContain('data-speaker="system"');
    // Bubble structure is intentionally flat — guard against a future
    // refactor reintroducing the chat-app avatar/bubble-stack wrappers.
    expect(html).not.toContain('collab-avatar');
    expect(html).not.toContain('collab-bubble-stack');

    // Conversation feel (PR: collab-conversation): group consecutive
    // same-speaker messages, relative "1m later" connector, pulse on
    // the newest row, polished Done rail.
    expect(html).toContain('COLLAB_GROUP_WINDOW_MS');
    expect(html).toContain('relativeFollowUpLabel');
    expect(html).toContain('data-grouped="true"');
    expect(html).toContain('data-newest="true"');
    // Chat-deboard PR: pulse animation moved from the message box-
    // shadow to the speaker label color (no card to glow on).
    expect(html).toContain('collab-speaker-pulse');
    expect(html).toContain('collab-follow');
    // Done rail polish: hover state, accent dot, pill enlargement.
    expect(html).toContain('.done-rail:hover');
    expect(html).toContain('.done-rail .lane-head::before');
    expect(html).toContain('.done-rail .lane-title .pill');

    // Hermes auto-reply (PR: monitor-hermes-replies): client polls the
    // collaboration buffer right after a post so the server-side
    // Hermes reply (~800ms later) surfaces in ~1s instead of waiting
    // for the next SSE snapshot.
    expect(html).toContain('pollCollaborationSince');
    expect(html).toContain('sinceMs=');

    // Drawer focus mode (PR: monitor-drawer-scrim): scrim element +
    // CSS, scrim click handler, Esc-to-close, done-row select-card
    // bug fix, stronger selected-card visual.
    expect(html).toContain('id="drawer-scrim"');
    expect(html).toContain('#drawer-scrim[data-open="true"]');
    expect(html).toContain('interactive === card');
    expect(html).toContain('event.key !== "Escape"');
    expect(html).toContain('scrim.dataset.open = "true"');

    // Hermes LLM voice (PR: monitor-hermes-llm): the client poll
    // window stretches to cover Ollama Cloud latency, and the
    // synthesized agent lines got a personality pass.
    expect(html).toContain('maxAttempts = 9');
    // Codex template refresh — pragmatic, terse voice. Old "I am
    // working on..." / "I am queued..." phrasing is gone.
    expect(html).not.toContain('I am queued for pickup');
    expect(html).not.toContain('I am working on " + title');
    expect(html).toContain("you're up on");
    expect(html).toContain('Working on " + title');
    expect(html).toContain("Hermes, your turn for the re-check");

    // Chat-deboard PR: chat rows are no longer rectangular kanban-style
    // panels. Drop the panel border + colored left-rail; switch to
    // minimal "author label on top, text below" chat lines. System
    // rows render as italic centered notes.
    expect(html).toContain('Minimal chat-line style');
    expect(html).toContain('.collab-message[data-newest="true"] .collab-speaker');
    expect(html).toContain('.collab-message[data-posted="true"] .collab-text { color: var(--cream)');
    // Dock sizing is back to compact-at-the-bottom (#145 reverted).
    expect(html).toContain('min-height: 218px');
    expect(html).toContain('max-height: min(32vh, 310px)');
    // Old kanban-style chat panel rules are gone.
    expect(html).not.toContain('border-left: 3px solid var(--speaker-accent');
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

  it("renders inline browser JavaScript that compiles", () => {
    const html = renderMonitorHtml();
    const script = html.split("<script>")[1]?.split("</script>")[0] ?? "";
    expect(script).toContain("function render(payload)");
    expect(() => new Script(script, { filename: "monitor-inline.js" })).not.toThrow();
  });
});
