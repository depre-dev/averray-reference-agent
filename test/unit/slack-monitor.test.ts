import vm, { Script } from "node:vm";
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
    expect(guardMonitorCommand("agent browser mission https://testbed.example/app goal: complete onboarding")).toMatchObject({ allowed: true });
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
    expect(html).toContain("renderMergeStewardPacket(item, summary, verdict, action)");
    expect(html).toContain("mergeStewardPacketForItem(item, summary, verdict, action)");
    expect(html).toContain("Merge steward packet");
    expect(html).toContain("This PR is release-ready, not merged");
    expect(html).toContain("Button does not");
    expect(html).toContain("GitHub deploy workflow runs");
    expect(html).toContain("watch Deploying");
    expect(html).toContain("renderCodexTaskPrompt(item, summary, verdict, action)");
    expect(html).toContain("codexWorkState(item, stage)");
    expect(html).toContain("codexTaskCompletedAfterHermesReview(item)");
    expect(html).toContain("latestHermesReviewMs(item)");
    expect(html).toContain("HERMES RECHECK");
    expect(html).toContain("Ask Hermes to re-check");
    expect(html).toContain("Codex task runner reported this task completed. Hermes should re-check");
    expect(html).toContain("CODEX FAILED");
    expect(html).toContain("Review failed task");
    expect(html).toContain("Create smaller retry task");
    expect(html).toContain("Show failed runner output and retry prompt");
    expect(html).toContain("Proof signals");
    expect(html).toContain("renderDrawerDisclosureSection");
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
    expect(html).toContain("verdict.level !== \"needs-review\" || isDraftPullRequest(item) || locallyApproved");
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
    expect(html).toContain("buildBoardBriefingMessages(kind)");
    expect(html).toContain("Here is the live shape of the board");
    expect(html).toContain("nothing here needs your decision right this second");
    expect(html).toContain("captureBoardNarrations(latestPipelineItems)");
    expect(html).toContain("shouldBoardNarrationOpenThread()");
    expect(html).toContain("preserveSelectedActionContext(key, item)");
    expect(html).toContain("selected ? renderSelectedCollaborationThread(selected) : renderCollaborationThread({ kind: \"all\" })");
    expect(html).toContain("selectedConversationMemoryMessages(item)");
    expect(html).toContain("collabMessageMatchesItem(message, item)");
    expect(html).toContain("boardNarrationMatchesItem(message, item)");
    expect(html).toContain("codexTasksForItem(item)");
    expect(html).toContain("selectedPrRoomBriefingForItem(item, verdict, action, lane)");
    expect(html).toContain("selectedPrRoomHandoffForItem(item, verdict, action, lane)");
    expect(html).toContain("PR room briefing");
    expect(html).toContain("I am treating \" + title + \" as its own PR room");
    expect(html).toContain("not just a card on the board");
    expect(html).toContain("latest signal is");
    expect(html).toContain("your next turn is not a rubber stamp");
    expect(html).toContain("Confirm branch protection, merge timing, and who watches the deploy");
    expect(html).toContain("This PR room is quiet so far");
    expect(html).toContain("nextStepNarrationForItem(item, verdict, action, lane)");
    expect(html).toContain("Right move now:");
    expect(html).toContain("The card button just");
    expect(html).toContain("I will move it once");
    expect(html).toContain("boardNarrationForChange(item, verdict, action, lane, previous)");
    expect(html).toContain("Update on \" + title");
    expect(html).toContain("First useful move:");
    expect(html).toContain("latestBoardNarrations");
    expect(html).toContain("board changed · ");
    expect(html).toContain("Start by opening the failed runner output");
    expect(html).toContain("Finish the draft work or mark it ready for review");
    expect(html).toContain("merge ownership, and deploy follow-up are explicit");
    expect(html).toContain("Waiting / Drafts");
    expect(html).toContain("isExternalDraftPullRequest(item)");
    expect(html).toContain("no Codex task starts from the card");
    expect(html).toContain("PR author");
    expect(html).toContain("Delegate takeover");
    expect(html).toContain("data-codex-task-action=\"delegate-draft\"");
    expect(html).toContain("Draft delegated to Codex. Task approved");
    expect(html).toContain("codexDelegationPromptForItem(item");
    expect(html).toContain("postDraftDelegationConversation(item, \"operator\")");
    expect(html).toContain("Got it. I will treat this as a deliberate draft takeover");
    expect(html).toContain("testbedMissionPipelineItems(payload.testbedMissions");
    expect(html).toContain("isTestbedMissionItem(item)");
    expect(html).toContain("renderTestbedMissionPanel(item, summary)");
    expect(html).toContain("Fresh-agent browser mission");
    expect(html).toContain("Copy mission prompt");
    expect(html).toContain("Copy report template");
    expect(html).toContain("testbedMissionReportTemplate(run, mission)");
    expect(html).toContain("renderTestbedMissionReportPacket(result)");
    expect(html).toContain("Browser-agent report");
    expect(html).toContain("Structured result JSON");
    expect(html).toContain("Comparison brief");
    expect(html).toContain("testbedMissionComparisonBrief(run)");
    expect(html).toContain("testbedMissionFixBrief(run)");
    expect(html).toContain("renderTestbedMissionFixBrief(fixBrief)");
    expect(html).toContain("Fix brief");
    expect(html).toContain("Hermes distilled the failed browser-agent report");
    expect(html).toContain("testbedProductUxGap(primaryBlocker, weakScores)");
    expect(html).toContain("testbedMissionChatSummary(testbedMissionRun(item))");
    expect(html).toContain("testbedMissionBoardDigest(counts)");
    expect(html).toContain("testbedMissionNextMove(lead, title)");
    expect(html).toContain("testbedMissionSignature(item)");
    expect(html).toContain("selectedTestbedMissionBriefing(item, title)");
    expect(html).toContain("selectedTestbedMissionEvidence(item)");
    expect(html).toContain("selectedTestbedMissionBoundary(item)");
    expect(html).toContain("selectedTestbedMissionHandoff(item, title)");
    expect(html).toContain("I opened testbed mission context");
    expect(html).toContain("what evidence is attached or missing");
    expect(html).toContain("I am treating testbed missions as evidence work");
    expect(html).toContain("evidence instead of vibes");
    expect(html).toContain("The browser-agent report passed, so I am treating it as a baseline");
    expect(html).toContain("The browser-agent report needs a follow-up run");
    expect(html).toContain("Mission timeline");
    expect(html).toContain("testbedMissionHistoryList(run.history)");
    expect(html).toContain("Baseline for future runs");
    expect(html).toContain("Copy baseline prompt");
    expect(html).toContain("testbedMissionBaselinePrompt(run, mission)");
    expect(html).toContain("Rerun after fix");
    expect(html).toContain("Copy rerun prompt");
    expect(html).toContain("testbedMissionRerunPrompt(run, mission)");
    expect(html).toContain("browser-only report");
    expect(html).toContain("result.testbedMissionRun");
    expect(html).toContain("data-codex-task-action=\"send-back\"");
    expect(html).toContain("Send back to Codex");
    expect(html).toContain("codexOperatorSendBackPromptForItem(item");
    expect(html).toContain("postOperatorSendBackConversation(item, \"operator\"");
    expect(html).toContain("operator sent review back to Codex");
    expect(html).toContain("Sent back to Codex. Task approved");
    expect(html).toContain("I recorded the operator send-back");
    expect(html).toContain("Only operator-review cards can be sent back to Codex");
    expect(html).toContain("postActionReceipt(item");
    expect(html).toContain("postMonitorDecisionReceipt(item, decision, verdict)");
    expect(html).toContain("postCommandSuggestionReceipt(value, item)");
    expect(html).toContain("postFailedTaskReviewReceipt(item)");
    expect(html).toContain("postCodexTaskActionReceipt(item, \"approve\"");
    expect(html).toContain("This button does not merge the PR");
    expect(html).toContain("I opened the failed task output");
    expect(html).toContain("You are allowed to pick it up now");
    expect(html).toContain("I reopened my local review");
    expect(html).toContain("please re-check \" + repo + \"#\" + pr + \" now");
    expect(html).toContain("forceThreadMode();\n          renderAutoCollaborationThread();\n          setComposeStatus(\"Codex task approved");
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
    expect(html).toContain("renderDecisionActions(item, verdict)");
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
    expect(html).toContain("the PR author or owning agent must mark it ready");
    expect(html).toContain("finish the draft or mark it ready for review");
    expect(html).toContain("Inspect draft");
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
    expect(html).toContain("Approve operator review");
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
    expect(html).toContain('--z-detail-drawer: 40');
    expect(html).toContain('z-index: var(--z-selected-card)');
    expect(html).toContain('z-index: var(--z-detail-drawer)');

    // Hermes LLM voice (PR: monitor-hermes-llm): the client poll
    // window stretches to cover Ollama Cloud latency, and the
    // synthesized agent lines got a personality pass.
    expect(html).toContain('maxAttempts = 9');
    // Codex template refresh — v2 keeps the generated chat lines
    // conversational while avoiding the old passive "queued for pickup"
    // phrasing.
    expect(html).not.toContain('I am queued for pickup');
    expect(html).toContain("you are up on");
    expect(html).toContain('I am working on " + title');
    expect(html).toContain("please take it back through the checks");

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

    // Done-row inline expansion (PR: monitor-done-inline): clicking a
    // closed PR row toggles a small detail strip below it instead of
    // opening the full slide-over drawer.
    expect(html).toContain('expandedDoneKey');
    expect(html).toContain('renderDoneRowDetail');
    expect(html).toContain('classList.contains("done-row")');
    expect(html).toContain('done-row-detail');
    expect(html).toContain('done-caret');
    expect(html).toContain('done-detail-open');
    // The expansion toggles via data-expanded.
    expect(html).toContain('expanded ? "true" : "false"');

    // Chat dedupe (PR: monitor-chat-dedup): when the board briefing
    // already covers a PR, the per-item ask loop skips it so the
    // thread doesn't show two near-identical lines per item. The
    // proposed-task branch collapses two Hermes lines into one.
    expect(html).toContain('briefingCoveredKeys');
    expect(html).toContain('briefingCoveredKeys.has(boardItemKey(item))');
    expect(html).toContain('Pascal, approve it when you want the runner to start');
    expect(html).toContain('task proposed · approval needed');
    // The old "is still draft. " redundancy is gone (title already
    // describes the draft state via pipelineTitle).
    expect(html).not.toContain('" is still draft. Finish the draft');

    // Chat liveness (PR: monitor-chat-alive): typing indicator while
    // a Hermes reply is in flight; slide-in animation on fresh rows;
    // synthesized lines get addressedTo so the thread reads as
    // dialogue; page title flashes when tab is hidden and posted
    // messages arrive.
    expect(html).toContain('renderHermesTypingRow');
    expect(html).toContain('hermesTypingSinceMs');
    expect(html).toContain('typing-dots');
    expect(html).toContain('@keyframes typing-bounce');
    expect(html).toContain('@keyframes collab-slide-in');
    expect(html).toContain('data-fresh="true"');
    expect(html).toContain('function inferAddressedTo(');
    expect(html).toContain('function updateUnreadTitle()');
    expect(html).toContain('"(" + unreadPostedCount + ") " + baseDocumentTitle');

    // Top-strip polish (PR: monitor-top-polish): counter chips use
    // a stacked number-over-label layout with data-empty driving the
    // zero-state dim; setCounterChip toggles it; the redundant
    // "system idle" pill is hidden via CSS when idle.
    expect(html).toContain('setCounterChip');
    expect(html).toContain('chip.setAttribute("data-empty"');
    expect(html).toContain('.counter-chip[data-empty="true"]');
    expect(html).toContain('.sys[data-state="idle"] { display: none; }');
    expect(html).toContain('id="waiting-chip"');
    expect(html).toContain('action needed');
    expect(html).toContain('waiting drafts');
    expect(html).toContain('operator review');
    expect(html).toContain('merge queue');
    // The old setText("attention-chip", ...) plumbing is replaced
    // by setCounterChip so the zero-dim toggle stays in sync.
    expect(html).not.toContain('setText("attention-chip"');
    expect(html).not.toContain('setText("blocked-chip"');

    // Chat liveness round 2 (PR: monitor-chat-alive-2): presence footer
    // at the bottom of the thread, @operator chime + mute toggle,
    // auto-scroll behavior + "N new ↓" pill.
    expect(html).toContain('renderCollabPresenceFooter');
    expect(html).toContain('collab-presence-agent');
    expect(html).toContain('describeCodexPresence');
    expect(html).toContain('describeHermesPresence');
    expect(html).toContain('describeOperatorPresence');
    expect(html).toContain('@keyframes collab-presence-pulse');
    expect(html).toContain('playOperatorChime');
    expect(html).toContain('id="collab-sound-toggle"');
    expect(html).toContain('SOUND_STORAGE_KEY');
    expect(html).toContain('maybeChimeForOperator');
    expect(html).toContain('isCollabScrolledToBottom');
    expect(html).toContain('updateCollabUnreadPill');
    expect(html).toContain('ensureCollabScrollListeners');
    expect(html).toContain('collab-unread-pill');

    // Board-now polish: the board and chat both get a current read
    // before the older collaboration history; draft cards show as
    // parked/waiting instead of shouting stale red.
    expect(html).toContain('id="board-now"');
    expect(html).toContain('renderBoardNowSummary');
    expect(html).toContain('boardNowSnapshot');
    expect(html).toContain('renderCollabNowPanel');
    expect(html).toContain('Current read');
    expect(html).toContain('boardCardAge');
    expect(html).toContain('label: age.state === "fresh" ? "Fresh" : "Parked"');
    expect(html).toContain('.handoff-card[data-lane="waiting"] .stale-dot[data-stale="waiting"]');
    expect(html).toContain('.slice(-18)');

    // Lane rails (PR: monitor-lane-rails): empty active lanes collapse
    // to narrow vertical rails (Done-rail idiom). Click expands them
    // for the session via forcedExpandedLaneKeys; clicking the head
    // re-collapses. Grid template is inline so each lane gets a
    // per-render width.
    expect(html).toContain('forcedExpandedLaneKeys');
    expect(html).toContain('anyActiveItems');
    expect(html).toContain('target.style.gridTemplateColumns');
    expect(html).toContain('data-collapsed="true"');
    expect(html).toContain('data-force-expanded="true"');
    expect(html).toContain('.lane[data-collapsed="true"]');
    expect(html).toContain('.lane[data-collapsed="true"] .lane-title .pill');
    // The previous static data-active-lanes CSS table is gone — the
    // grid template comes from the inline style now.
    expect(html).not.toContain('.kanban-board[data-active-lanes="3"]');
    expect(html).not.toContain('target.dataset.activeLanes = String(activeLaneCount)');

    // Chat collapse (PR: monitor-chat-collapse): long synthesized
    // messages render as a 1-2 sentence summary with a "more ↓"
    // affordance to expand. Expand state lives in
    // expandedCollabRowKeys per session. Rail width bumped 60→66px.
    expect(html).toContain('expandedCollabRowKeys');
    expect(html).toContain('collapsedCollabSummary');
    expect(html).toContain('data-collab-more');
    expect(html).toContain('.collab-more');
    expect(html).toContain('"66px"'); // rail width bump
    // Old 60px rail width is gone.
    expect(html).not.toContain('? "60px" : "minmax(186px, 1fr)"');
    // The summary cap constants used to live at module scope but that
    // hit a TDZ ReferenceError because setComposeMode() runs at boot
    // before the declarations were reached. Guard against the
    // regression: the constant names must NOT appear at script level.
    expect(html).not.toContain('const COLLAB_SUMMARY_MAX_CHARS');
    expect(html).not.toContain('const COLLAB_SUMMARY_MAX_SENTENCES');

    // Filter pills + stale tiers (PR: monitor-polish-filters-stale):
    // bottom filter pills dim when their count is 0 (same idiom as
    // the top-strip counter chips); stale badges escalate yellow →
    // orange → red as the age grows past 12h / 24h.
    expect(html).toContain('setFilterPillCount');
    expect(html).toContain('pill.setAttribute("data-empty"');
    expect(html).toContain('.toggle-pill[data-empty="true"]:not([aria-pressed="true"])');
    expect(html).toContain('staleTier');
    expect(html).toContain('data-stale-tier="warn"');
    expect(html).toContain('data-stale-tier="high"');
    expect(html).toContain('data-stale-tier="critical"');
    // The thresholds: 12h (720m) → high, 24h (1440m) → critical.
    expect(html).toContain('minutes >= 1440');
    expect(html).toContain('minutes >= 720');

    // Responsive polish (PR: monitor-responsive-polish): chat meta
    // shrinks/truncates instead of overflowing; min lane width bumped
    // 186px → 210px; chat compose stacks below thread at mid-width
    // (≤1180px). Together these stop the cramped/overflow look at
    // medium viewports.
    expect(html).toContain('"minmax(210px, 1fr)"');
    expect(html).not.toContain('? "66px" : "minmax(186px, 1fr)"');
    expect(html).toContain('text-overflow: ellipsis');
    expect(html).toContain('@media (max-width: 1180px) and (min-width: 761px)');
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

  it("inline browser JavaScript boots without throwing (catches TDZ)", () => {
    // Run the inline <script> in a Node vm context with a catchall
    // stub for all the browser globals it touches. We only care that
    // the top-level evaluation doesn't throw — i.e. no TDZ, no
    // undefined-reference, no syntax-tripping order-of-declaration
    // bug. We don't assert any rendered output; that would require
    // a real DOM. This guards against bugs like the COLLAB_SUMMARY_
    // MAX_CHARS TDZ that took the monitor down in production.
    const html = renderMonitorHtml();
    const script = html.split("<script>")[1]?.split("</script>")[0] ?? "";
    const makeStub = () => {
      // Function-typed Proxy: callable (event handlers etc.),
      // constructable (new AudioContext()), every property access
      // resolves to another stub, every assignment is silently
      // accepted. Surfaces TDZ + undefined-reference errors at boot
      // without a real DOM.
      const fn = function () {};
      return new Proxy(fn, {
        get(_target, prop) {
          if (prop === "then") return undefined; // not a thenable
          if (prop === Symbol.toPrimitive) return () => "";
          if (prop === "length") return 0;
          return makeStub();
        },
        set: () => true,
        apply: () => makeStub(),
        construct: () => makeStub(),
        has: () => true,
      });
    };
    const context = vm.createContext({
      document: makeStub(),
      window: makeStub(),
      localStorage: makeStub(),
      location: { search: "" },
      navigator: { clipboard: makeStub() },
      fetch: makeStub(),
      EventSource: function () { return makeStub(); },
      AudioContext: function () { return makeStub(); },
      Notification: function () {},
      MutationObserver: function () { return makeStub(); },
      IntersectionObserver: function () { return makeStub(); },
      ResizeObserver: function () { return makeStub(); },
      AbortController: function () { return makeStub(); },
      AbortSignal: makeStub(),
      URL,
      TextEncoder,
      TextDecoder,
      atob: (s: string) => Buffer.from(s, "base64").toString(),
      btoa: (s: string) => Buffer.from(s).toString("base64"),
      performance: { now: () => 0 },
      URLSearchParams,
      setTimeout: () => 0,
      clearTimeout: () => {},
      setInterval: () => 0,
      clearInterval: () => {},
      requestAnimationFrame: () => 0,
      console,
      Date,
      Math,
      Number,
      String,
      Boolean,
      Array,
      Object,
      JSON,
      Set,
      Map,
      WeakSet,
      WeakMap,
      Symbol,
      Error,
      RegExp,
      Promise,
      Proxy,
      Reflect,
    });
    expect(() => vm.runInContext(script, context, { timeout: 2000 })).not.toThrow();
  });

  it("keeps draft PRs in Waiting / Drafts before task-failure urgency", () => {
    const html = renderMonitorHtml();
    const draftLaneIndex = html.indexOf('if (isExternalDraftPullRequest(item)) return { key: "waiting" };');
    const failedAttentionIndex = html.indexOf('if (codexTaskFailedForItem(item)) return { key: "attention" };');

    expect(draftLaneIndex).toBeGreaterThan(-1);
    expect(failedAttentionIndex).toBeGreaterThan(-1);
    expect(draftLaneIndex).toBeLessThan(failedAttentionIndex);
    expect(html).not.toContain('if (codexTaskFailedForItem(item)) return false;');
  });
});
