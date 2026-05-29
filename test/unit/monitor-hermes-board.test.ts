import { describe, expect, it } from "vitest";

import { buildHermesBoardSnapshotFromMonitor } from "../../services/slack-operator/src/monitor-hermes-board.js";

describe("buildHermesBoardSnapshotFromMonitor", () => {
  it("turns live monitor data into lane/owner context for Hermes", () => {
    const board = buildHermesBoardSnapshotFromMonitor({
      generatedAt: "2026-05-20T08:54:42.000Z",
      status: "attention",
      counts: { active: 0, running: 0, recent: 20 },
      recent: [
        {
          correlationId: "github-live-pr-averray-agent-agent-439",
          repo: "averray-agent/agent",
          pullRequestNumber: 439,
          status: "completed",
          reason: "pr_is_draft",
          updatedAt: "2026-05-19T22:08:42.000Z",
          summary: {
            finalVerdict: "needs_review",
            currentPullRequest: {
              repo: "averray-agent/agent",
              number: 439,
              draft: true,
              state: "open",
              title: "PR is still marked as draft.",
            },
            reviewSignals: { touchedAreas: ["backend", "secrets"] },
          },
        },
        {
          correlationId: "github-live-pr-averray-reference-agent-176",
          repo: "averray-reference-agent",
          pullRequestNumber: 176,
          status: "completed",
          reason: "pr_critical_files",
          updatedAt: "2026-05-20T08:49:42.000Z",
          summary: {
            finalVerdict: "needs_review",
            reviewReasons: [
              { code: "pr_critical_files", message: "1 changed file(s) touch secrets, contracts, or database migrations." },
            ],
            currentPullRequest: {
              repo: "averray-reference-agent",
              number: 176,
              draft: false,
              state: "open",
              title: "Critical deploy review",
            },
            reviewSignals: { touchedAreas: ["ops"] },
          },
        },
      ],
      codexTasks: {
        counts: { proposed: 0, approved: 0, running: 0 },
        runner: {
          status: "idle",
          message: "Codex runner is online; no approved task is waiting.",
          stale: false,
        },
      },
    });

    expect(board?.headline).toContain("1 draft");
    expect(board?.counts?.waiting).toBe(1);
    expect(board?.counts?.operator).toBe(1);
    expect(board?.runner).toContain("status=idle");
    expect(board?.items?.[0]).toMatchObject({
      repo: "averray-agent/agent",
      number: 439,
      lane: "Waiting / Drafts",
      owner: "PR author",
      verdict: "draft",
    });
    expect(board?.items?.[0]?.next).toMatch(/explicitly delegates/);
    expect(board?.items?.[1]).toMatchObject({
      repo: "averray-reference-agent",
      number: 176,
      lane: "Operator Review",
      owner: "Operator",
      verdict: "needs review",
    });
  });

  it("moves draft PRs with active Codex tasks into Codex context", () => {
    const board = buildHermesBoardSnapshotFromMonitor({
      generatedAt: "2026-05-20T08:54:42.000Z",
      status: "attention",
      recent: [
        {
          correlationId: "github-live-pr-averray-agent-agent-439",
          repo: "averray-agent/agent",
          pullRequestNumber: 439,
          status: "completed",
          reason: "pr_is_draft",
          summary: {
            currentPullRequest: {
              repo: "averray-agent/agent",
              number: 439,
              draft: true,
              state: "open",
              title: "Delegated draft",
            },
          },
        },
      ],
      codexTasks: {
        items: [
          {
            repo: "averray-agent/agent",
            pullRequestNumber: 439,
            status: "approved",
          },
        ],
      },
    });

    expect(board?.items?.[0]).toMatchObject({
      lane: "Codex Needed",
      owner: "Codex",
      verdict: "delegated draft",
      why: "Codex task is approved.",
    });
  });

  it("forwards the PR head branch (flat headBranch and nested head.ref)", () => {
    const board = buildHermesBoardSnapshotFromMonitor({
      generatedAt: "2026-05-20T08:54:42.000Z",
      recent: [
        {
          correlationId: "github-live-pr-flat",
          repo: "averray-agent/agent",
          pullRequestNumber: 501,
          status: "completed",
          summary: {
            currentPullRequest: {
              repo: "averray-agent/agent",
              number: 501,
              state: "open",
              title: "Codex PR (flat headBranch)",
              headBranch: "codex/widen-claim",
            },
          },
        },
        {
          correlationId: "github-live-pr-nested",
          repo: "averray-agent/agent",
          pullRequestNumber: 502,
          status: "completed",
          summary: {
            pullRequest: {
              repo: "averray-agent/agent",
              number: 502,
              state: "open",
              title: "Claude PR (nested head.ref)",
              head: { ref: "claude/board-polish" },
            },
          },
        },
      ],
    });

    const flat = board?.items?.find((item) => item.number === 501);
    const nested = board?.items?.find((item) => item.number === 502);
    expect(flat?.headBranch).toBe("codex/widen-claim");
    expect(nested?.headBranch).toBe("claude/board-polish");
  });
});
