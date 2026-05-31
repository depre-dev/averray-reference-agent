import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { buildAgentScorecard, getAgentScorecard } from "../../packages/averray-mcp/src/agent-scorecard.js";

describe("A1 agent scorecard", () => {
  it("aggregates PR, task, check, surface, and mission signals per agent", () => {
    const scorecard = buildAgentScorecard({
      active: [],
      recent: [
        {
          requester: "github-actions",
          status: "completed",
          summary: {
            finalVerdict: "ok_to_merge",
            currentPullRequest: {
              repo: "averray-agent/agent",
              number: 101,
              merged: true,
              draft: false,
              headBranch: "codex/agent-scorecard",
            },
            checks: [
              { name: "Backend", status: "completed", conclusion: "success" },
              { name: "Frontend", status: "completed", conclusion: "success" },
            ],
            reviewSignals: {
              touchedAreas: ["frontend"],
            },
          },
        },
        {
          requester: "github-actions",
          status: "completed",
          summary: {
            finalVerdict: "needs_review",
            currentPullRequest: {
              repo: "averray-agent/agent",
              number: 102,
              merged: false,
              draft: false,
              headBranch: "claude/docs-followup",
            },
            checks: [
              { name: "Backend", status: "completed", conclusion: "failure" },
            ],
            reviewSignals: {
              touchedAreas: ["docs", "backend"],
            },
          },
        },
      ],
      codexTasks: {
        items: [
          {
            id: "codex-task-1",
            agent: "codex",
            status: "completed",
            attemptCount: 1,
            startedAt: "2026-05-31T10:00:00.000Z",
            completedAt: "2026-05-31T10:10:00.000Z",
          },
          {
            id: "claude-task-1",
            agent: "claude",
            status: "failed",
            attemptCount: 2,
            startedAt: "2026-05-31T10:00:00.000Z",
            failedAt: "2026-05-31T10:05:00.000Z",
          },
        ],
      },
      testbedMissions: [
        {
          id: "testbed-mission-1",
          agentName: "Hermes",
          status: "completed",
          result: { verdict: "pass" },
        },
      ],
      llmUsageEvents: [
        {
          agent: "codex",
          model: "gpt-5-codex",
          taskId: "codex-task-1",
          inputTokens: 300,
          outputTokens: 70,
          ts: "2026-05-31T10:11:00.000Z",
        },
        {
          agent: "claude",
          model: "claude-sonnet-4-5",
          taskId: "claude-task-1",
          inputTokens: 200,
          outputTokens: 80,
          costUsd: 0.04,
          ts: "2026-05-31T10:06:00.000Z",
        },
      ],
    }, { now: new Date("2026-05-31T12:00:00.000Z") });

    expect(scorecard).toMatchObject({
      schemaVersion: 1,
      kind: "averray_agent_scorecard",
      generatedAt: "2026-05-31T12:00:00.000Z",
      totals: {
        agents: 3,
        samples: 5,
        tasks: 2,
        pullRequests: 2,
        missions: 1,
      },
      safety: {
        readOnly: true,
        mutatesGithub: false,
        mutatesRunnerQueue: false,
      },
    });
    expect(scorecard.llmUsage).toMatchObject({
      status: "recorded",
      inputTokens: 500,
      outputTokens: 150,
      totalTokens: 650,
      costUsd: 0.04,
    });

    const codex = scorecard.agents.find((agent) => agent.agent === "codex");
    expect(codex).toMatchObject({
      sampleCount: 2,
      quality: {
        pullRequests: {
          opened: 1,
          merged: 1,
          mergeReady: 1,
        },
        checks: {
          pass: 2,
          latestPassRate: 1,
        },
      },
      tasks: {
        total: 1,
        completed: 1,
        attempts: 1,
        successRate: 1,
      },
      speed: {
        avgTaskDurationMinutes: 10,
      },
      cost: {
        status: "not_recorded",
        totalUsd: null,
        totalTokens: 370,
      },
      tokens: {
        status: "recorded",
        inputTokens: 300,
        outputTokens: 70,
        totalTokens: 370,
      },
      trust: {
        status: "not_recorded",
      },
      surfaces: [
        {
          surface: "frontend",
          count: 1,
          ready: 1,
        },
      ],
    });

    const claude = scorecard.agents.find((agent) => agent.agent === "claude");
    expect(claude).toMatchObject({
      sampleCount: 2,
      quality: {
        pullRequests: {
          opened: 1,
          needsReview: 1,
        },
        checks: {
          fail: 1,
          latestPassRate: 0,
        },
      },
      tasks: {
        total: 1,
        failed: 1,
        attempts: 2,
        successRate: 0,
      },
      cost: {
        status: "recorded",
        totalUsd: 0.04,
        totalTokens: 280,
      },
      tokens: {
        status: "recorded",
        totalTokens: 280,
      },
    });

    const hermes = scorecard.agents.find((agent) => agent.agent === "hermes");
    expect(hermes).toMatchObject({
      sampleCount: 1,
      missions: {
        total: 1,
        passed: 1,
      },
    });
  });

  it("keeps empty snapshots explicit instead of inventing routing confidence", () => {
    const scorecard = buildAgentScorecard({}, { now: new Date("2026-05-31T12:00:00.000Z") });

    expect(scorecard.totals).toEqual({
      agents: 0,
      samples: 0,
      tasks: 0,
      pullRequests: 0,
      missions: 0,
    });
    expect(scorecard.agents).toEqual([]);
    expect(scorecard.gaps).toContain("Cost and token totals are not present in the current runner events.");
    expect(scorecard.safety.routingInfluence).toContain("A1 only observes");
  });

  it("reads task and browser mission stores without needing monitor internals", async () => {
    const dir = await mkdtemp(join(tmpdir(), "averray-agent-scorecard-"));
    try {
      const codexTasksPath = join(dir, "codex-tasks.json");
      const testbedMissionsPath = join(dir, "testbed-missions.json");
      const llmUsageLogPath = join(dir, "llm-usage.jsonl");
      await writeFile(codexTasksPath, JSON.stringify({
        items: [
          {
            id: "codex-task-2",
            agent: "codex",
            status: "completed",
            attemptCount: 1,
          },
        ],
      }));
      await writeFile(testbedMissionsPath, JSON.stringify({
        runs: [
          {
            id: "testbed-mission-2",
            agentName: "Hermes",
            status: "completed",
            result: { verdict: "partial" },
          },
        ],
      }));
      await writeFile(llmUsageLogPath, JSON.stringify({
        agent: "codex",
        model: "gpt-5-codex",
        taskId: "codex-task-2",
        inputTokens: 10,
        outputTokens: 4,
        ts: "2026-05-31T11:00:00.000Z",
      }) + "\n");

      const scorecard = await getAgentScorecard({
        eventLogPath: join(dir, "missing-events.jsonl"),
        codexTasksPath,
        testbedMissionsPath,
        llmUsageLogPath,
        now: new Date("2026-05-31T12:00:00.000Z"),
      });

      expect(scorecard.totals).toMatchObject({
        agents: 2,
        tasks: 1,
        missions: 1,
      });
      expect(scorecard.agents.find((agent) => agent.agent === "codex")).toMatchObject({
        tasks: { completed: 1 },
        tokens: { totalTokens: 14 },
      });
      expect(scorecard.agents.find((agent) => agent.agent === "hermes")).toMatchObject({
        missions: { partial: 1 },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
