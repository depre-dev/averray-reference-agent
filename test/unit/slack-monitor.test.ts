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
    expect(html).toContain("Next action owners");
    expect(html).toContain("Codex needs");
    expect(html).toContain("Human needs");
    expect(html).toContain("Merge queue");
    expect(html).toContain("Hermes active");
    expect(html).toContain("Owner Lanes");
    expect(html).toContain("who acts next");
    expect(html).toContain("Nothing waiting on Codex.");
    expect(html).toContain("Hermes has no active PR checks.");
    expect(html).toContain("No human review needed.");
    expect(html).toContain("Nothing ready to merge.");
    expect(html).toContain("No completed PRs in view.");
    expect(html).toContain("PR staleness summary");
    expect(html).toContain("Fresh");
    expect(html).toContain("Waiting");
    expect(html).toContain("Stale");
    expect(html).toContain("PR Pipeline");
    expect(html).toContain("grouped by repo");
    expect(html).toContain("No current work for this repo.");
    expect(html).toContain("Recent history");
    expect(html).toContain("Next action:");
    expect(html).toContain("Next actor");
    expect(html).toContain("Fix request");
    expect(html).toContain("Fix request for Codex");
    expect(html).toContain("Review request for owner");
    expect(html).toContain("Human approved");
    expect(html).toContain("Reset approval");
    expect(html).toContain("private monitor decision only");
    expect(html).toContain("PR timeline");
    expect(html).toContain("pr-timeline-item");
    expect(html).toContain("PR detail");
    expect(html).toContain("PR state");
    expect(html).toContain("Suggested owner");
    expect(html).toContain("Changed areas");
    expect(html).toContain("Test coverage");
    expect(html).toContain("Done");
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
    expect(html).toContain("renderOwnerLanes(latestPipelineItems)");
    expect(html).toContain("renderOwnerSummary(entries)");
    expect(html).toContain("renderStalenessSummary(entries)");
    expect(html).toContain("latestPipelineItems = collectPipelineItems(payload)");
    expect(html).toContain("filterPipelineItems(entries)");
    expect(html).toContain("renderRepoGroups(filtered)");
    expect(html).toContain("renderRepoGroup(repo, items)");
    expect(html).toContain("repoSummaryChips(items, current)");
    expect(html).toContain("repoSortScore(b[1])");
    expect(html).toContain("ownerLaneDefinitions()");
    expect(html).toContain("renderOwnerLane(lane, filtered)");
    expect(html).toContain("renderOwnerLaneCard(item)");
    expect(html).toContain("ownerLaneSortScore(item)");
    expect(html).toContain("isCurrentPipelineItem(item)");
    expect(html).toContain("updatePipelineFilterButtons()");
    expect(html).toContain("pipelineStage(item, verdict)");
    expect(html).toContain("nextPipelineAction(item, verdict)");
    expect(html).toContain("renderFixRequest(item, summary, verdict, action)");
    expect(html).toContain("renderDecisionActions(item)");
    expect(html).toContain("renderHumanDecisionNote(item)");
    expect(html).toContain("buildFixRequest(item, summary, verdict, action)");
    expect(html).toContain("fixRequestInstruction(verdict, action)");
    expect(html).toContain("firstReviewReason(reviewReasons)");
    expect(html).toContain("loadMonitorDecisions()");
    expect(html).toContain("setMonitorDecision(key, value)");
    expect(html).toContain("decisionForItem(item)");
    expect(html).toContain("decisionKeyForItem(item)");
    expect(html).toContain("baseReleaseVerdict(item)");
    expect(html).toContain("renderPipelineDetails(item, summary, verdict, action)");
    expect(html).toContain("handoffAge(item)");
    expect(html).toContain("pullRequestState(item, summary)");
    expect(html).toContain("isDonePullRequestState(prState)");
    expect(html).toContain("pullRequestStateLabel(prState)");
    expect(html).toContain("formatDuration(minutes)");
    expect(html).toContain("nextPipelineActor(item, verdict)");
    expect(html).toContain("renderPipelineSteps(stage, verdict)");
    expect(html).toContain("renderPrTimeline(item, stage, verdict, action)");
    expect(html).toContain("prTimelineItems(item, stage, verdict, action, prState)");
    expect(html).toContain("renderPrTimelineItem(item)");
    expect(html).toContain("prTimelineStateForGate(verdict)");
    expect(html).toContain("compactTestList(tests)");
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
