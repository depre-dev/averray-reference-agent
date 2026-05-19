import { describe, expect, it } from "vitest";

import {
  formatStalePrAlertForSlack,
  shouldPostStalePrAlert,
  stalePrAlertItems,
} from "../../services/slack-operator/src/stale-pr-alerts.js";

describe("stale PR handoff alerts", () => {
  const now = new Date("2026-05-16T12:00:00.000Z");

  it("extracts stale PR handoffs and ignores fresh or deploy handoffs", () => {
    const items = stalePrAlertItems({
      now,
      staleAfterMinutes: 120,
      monitor: {
        recent: [
          {
            correlationId: "github-pr-10-run-1",
            intent: "pr_handoff",
            repo: "depre-dev/averray-reference-agent",
            pullRequestNumber: 10,
            updatedAt: "2026-05-16T09:30:00.000Z",
            status: "completed",
            summary: {
              finalVerdict: "hold",
              mergeRecommendation: "hold",
              reviewReasons: [{ message: "CI failed." }],
            },
          },
          {
            correlationId: "github-pr-11-run-1",
            intent: "pr_handoff",
            repo: "depre-dev/averray-reference-agent",
            pullRequestNumber: 11,
            updatedAt: "2026-05-16T11:10:00.000Z",
            status: "completed",
            summary: { finalVerdict: "ok_to_merge", mergeRecommendation: "ok_to_merge" },
          },
          {
            correlationId: "github-deploy-1-sha",
            intent: "testbed_suite",
            repo: "averray-agent/agent",
            updatedAt: "2026-05-16T08:00:00.000Z",
            status: "completed",
          },
        ],
      },
    });

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      correlationId: "github-pr-10-run-1",
      repo: "depre-dev/averray-reference-agent",
      pullRequestNumber: 10,
      owner: "Codex",
      ageMinutes: 150,
      ageLabel: "2h 30m",
      reason: "CI failed.",
      pullRequestUrl: "https://github.com/depre-dev/averray-reference-agent/pull/10",
    });
  });

  it("dedupes active and recent entries by correlation id", () => {
    const handoff = {
      correlationId: "github-pr-12-run-1",
      intent: "pr_handoff",
      repo: "depre-dev/averray-reference-agent",
      pullRequestNumber: 12,
      updatedAt: "2026-05-16T08:00:00.000Z",
      status: "completed",
      summary: { finalVerdict: "needs_review", mergeRecommendation: "needs_review" },
    };

    const items = stalePrAlertItems({
      now,
      staleAfterMinutes: 120,
      monitor: { active: [handoff], recent: [handoff] },
    });

    expect(items).toHaveLength(1);
    expect(items[0]?.owner).toBe("Operator");
  });

  it("routes stale draft PRs to the PR author instead of Codex", () => {
    const items = stalePrAlertItems({
      now,
      staleAfterMinutes: 120,
      monitor: {
        recent: [{
          correlationId: "github-pr-15-run-1",
          intent: "pr_handoff",
          repo: "depre-dev/averray-reference-agent",
          pullRequestNumber: 15,
          updatedAt: "2026-05-16T08:00:00.000Z",
          status: "completed",
          summary: {
            finalVerdict: "needs_review",
            mergeRecommendation: "needs_review",
            currentPullRequest: {
              state: "open",
              draft: true,
              merged: false,
            },
          },
        }],
      },
    });

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      owner: "PR author",
      nextAction: "finish the draft or mark it ready; Codex should only take over if explicitly delegated",
      reason: "PR is still draft; the author or owning agent must mark it ready before Hermes/operator can proceed.",
    });
  });

  it("only posts when stale handoffs exist and signature changes", () => {
    const items = stalePrAlertItems({
      now,
      staleAfterMinutes: 120,
      monitor: {
        recent: [{
          correlationId: "github-pr-13-run-1",
          intent: "pr_handoff",
          repo: "depre-dev/averray-reference-agent",
          pullRequestNumber: 13,
          updatedAt: "2026-05-16T08:00:00.000Z",
          status: "completed",
          summary: { finalVerdict: "needs_review", mergeRecommendation: "needs_review" },
        }],
      },
    });
    const first = shouldPostStalePrAlert(items, undefined);

    expect(first.shouldPost).toBe(true);
    expect(first.signature).toContain("github-pr-13-run-1");
    expect(shouldPostStalePrAlert(items, first.signature)).toEqual({
      shouldPost: false,
      signature: first.signature,
    });
    expect(shouldPostStalePrAlert([], undefined)).toEqual({ shouldPost: false });
  });

  it("formats a compact Slack alert with monitor link", () => {
    const text = formatStalePrAlertForSlack([
      {
        correlationId: "github-pr-14-run-1",
        repo: "depre-dev/averray-reference-agent",
        pullRequestNumber: 14,
        pullRequestUrl: "https://github.com/depre-dev/averray-reference-agent/pull/14",
        owner: "Operator",
        ageMinutes: 180,
        ageLabel: "3h",
        nextAction: "use the agent pre-check evidence to decide project intent, architecture, and rollout risk",
        reason: "Operator review recommended.",
      },
    ], "https://monitor.averray.com/monitor");

    expect(text).toContain("*Hermes stale PR handoffs*");
    expect(text).toContain("<https://github.com/depre-dev/averray-reference-agent/pull/14|depre-dev/averray-reference-agent #14>");
    expect(text).toContain("owner: `Operator`");
    expect(text).toContain("age: `3h`");
    expect(text).toContain("Open monitor: https://monitor.averray.com/monitor");
  });
});
