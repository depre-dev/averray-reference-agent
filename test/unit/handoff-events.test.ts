import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";

import {
  getHandoffMonitor,
  recordHandoffEvent,
} from "../../packages/averray-mcp/src/handoff-events.js";

describe("handoff event monitor", () => {
  it("groups active and recent handoffs by correlation id", async () => {
    const dir = await mkdtemp(join(tmpdir(), "averray-handoff-events-"));
    const previous = process.env.AVERRAY_HANDOFF_EVENTS_PATH;
    process.env.AVERRAY_HANDOFF_EVENTS_PATH = join(dir, "events.jsonl");
    try {
      await recordHandoffEvent({
        correlationId: "github-pr-218-sha-run",
        requester: "github-actions",
        intent: "pr_handoff",
        phase: "started",
        status: "running",
        repo: "averray-agent/agent",
        pullRequestNumber: 218,
        testCaseIds: ["TBE2E-004"],
        reason: "post-CI PR handoff",
        timestamp: "2026-05-09T17:24:30.000Z",
      });
      await recordHandoffEvent({
        correlationId: "github-pr-218-sha-run",
        requester: "github-actions",
        intent: "pr_handoff",
        phase: "completed",
        status: "completed",
        repo: "averray-agent/agent",
        pullRequestNumber: 218,
        testCaseIds: ["TBE2E-004"],
        summary: {
          finalVerdict: "ok_to_merge",
          mergeRecommendation: "ok_to_merge",
        },
        safety: {
          githubMutated: false,
          wikipediaEdited: false,
        },
        timestamp: "2026-05-09T17:28:30.000Z",
      });
      await recordHandoffEvent({
        correlationId: "github-deploy-25608715158",
        requester: "github-actions",
        intent: "testbed_suite",
        phase: "started",
        status: "running",
        repo: "averray-agent/agent",
        testCaseIds: ["TBE2E-001", "TBE2E-002"],
        timestamp: "2026-05-09T18:36:00.000Z",
      });

      const monitor = await getHandoffMonitor({
        now: new Date("2026-05-09T18:40:00.000Z"),
        activeWindowMinutes: 60,
        limit: 10,
      });

      expect(monitor).toMatchObject({
        kind: "agent_handoff_monitor",
        status: "active",
        counts: {
          events: 3,
          correlations: 2,
          active: 1,
          recent: 2,
        },
        active: [
          {
            correlationId: "github-deploy-25608715158",
            requester: "github-actions",
            intent: "testbed_suite",
            status: "running",
            active: true,
            activeState: "running",
            testCaseIds: ["TBE2E-001", "TBE2E-002"],
          },
        ],
        recent: [
          expect.objectContaining({ correlationId: "github-deploy-25608715158" }),
          expect.objectContaining({
            correlationId: "github-pr-218-sha-run",
            status: "completed",
            summary: {
              finalVerdict: "ok_to_merge",
              mergeRecommendation: "ok_to_merge",
            },
          }),
        ],
      });
    } finally {
      if (previous === undefined) {
        delete process.env.AVERRAY_HANDOFF_EVENTS_PATH;
      } else {
        process.env.AVERRAY_HANDOFF_EVENTS_PATH = previous;
      }
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps just-finished handoffs visible briefly in the active lane", async () => {
    const dir = await mkdtemp(join(tmpdir(), "averray-handoff-events-"));
    const previous = process.env.AVERRAY_HANDOFF_EVENTS_PATH;
    process.env.AVERRAY_HANDOFF_EVENTS_PATH = join(dir, "events.jsonl");
    try {
      await recordHandoffEvent({
        correlationId: "github-pr-240-sha-run",
        requester: "github-actions",
        intent: "pr_handoff",
        phase: "started",
        status: "running",
        repo: "averray-agent/agent",
        pullRequestNumber: 240,
        testCaseIds: ["TBE2E-004"],
        timestamp: "2026-05-12T14:36:00.000Z",
      });
      await recordHandoffEvent({
        correlationId: "github-pr-240-sha-run",
        requester: "github-actions",
        intent: "pr_handoff",
        phase: "completed",
        status: "completed",
        repo: "averray-agent/agent",
        pullRequestNumber: 240,
        testCaseIds: ["TBE2E-004"],
        summary: {
          finalVerdict: "needs_review",
          mergeRecommendation: "needs_review",
        },
        timestamp: "2026-05-12T14:36:58.000Z",
      });

      const monitor = await getHandoffMonitor({
        now: new Date("2026-05-12T14:37:30.000Z"),
        activeWindowMinutes: 60,
        limit: 10,
      });

      expect(monitor).toMatchObject({
        status: "recently_active",
        counts: {
          active: 1,
          running: 0,
          justFinished: 1,
        },
        active: [
          {
            correlationId: "github-pr-240-sha-run",
            status: "completed",
            active: false,
            activeState: "just_finished",
          },
        ],
      });
    } finally {
      if (previous === undefined) {
        delete process.env.AVERRAY_HANDOFF_EVENTS_PATH;
      } else {
        process.env.AVERRAY_HANDOFF_EVENTS_PATH = previous;
      }
      await rm(dir, { recursive: true, force: true });
    }
  });
});
