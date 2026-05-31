import { describe, expect, it } from "vitest";

import {
  createHermesDecisionRecord,
} from "../../packages/averray-mcp/src/decision-records.js";
import {
  buildDecisionRecordsMonitorResponse,
  listDecisionRecordsForMonitor,
} from "../../services/slack-operator/src/decision-record-store.js";
import type { CodexTask } from "../../services/slack-operator/src/codex-task-queue.js";

describe("Hermes decision records", () => {
  it("creates a human-readable, sanitized record", () => {
    const record = createHermesDecisionRecord({
      kind: "routing",
      subject: { type: "task", id: "task-1", repo: "owner/repo" },
      decision: "routed to claude",
      reasons: ["Claude had the best UI score.", "Bearer abc.def.ghi was never supposed to appear."],
      inputs: {
        riskTier: "low",
        scorecardSnapshot: [{ agent: "claude", score: 0.91 }],
        privateKey: "0x".padEnd(66, "a"),
        nested: { apiToken: "secret-token" },
      },
      outcome: { summary: "Task proposed.", waitingNext: "Operator approval." },
      safety: { readOnly: true, mutates: false },
      generatedAt: "2026-05-31T12:00:00.000Z",
    });

    expect(record).toMatchObject({
      schemaVersion: 1,
      recordType: "hermes_decision_record",
      kind: "routing",
      decision: "routed to claude",
      subject: { type: "task", id: "task-1", repo: "owner/repo" },
      outcome: { summary: "Task proposed." },
    });
    expect(record.reasons.join(" ")).not.toContain("abc.def.ghi");
    expect(record.inputs.privateKey).toBe("[redacted]");
    expect((record.inputs.nested as Record<string, unknown>).apiToken).toBe("[redacted]");
  });

  it("monitor response returns newest records and respects limit", () => {
    const oldRecord = createHermesDecisionRecord({
      kind: "auto_approval",
      subject: { type: "task", id: "old" },
      decision: "approved",
      reasons: ["older"],
      outcome: { summary: "older" },
      safety: { readOnly: false, mutates: true },
      generatedAt: "2026-05-31T10:00:00.000Z",
    });
    const newRecord = createHermesDecisionRecord({
      kind: "anomaly_pause",
      subject: { type: "autopilot_session", id: "hermes" },
      decision: "paused_soft",
      reasons: ["newer"],
      outcome: { summary: "newer" },
      safety: { readOnly: false, mutates: true },
      generatedAt: "2026-05-31T12:00:00.000Z",
    });

    const response = buildDecisionRecordsMonitorResponse({
      records: [oldRecord, newRecord],
      limit: 1,
      now: new Date("2026-05-31T13:00:00.000Z"),
    });

    expect(response.records).toEqual([newRecord]);
    expect(response.limit).toBe(1);
    expect(response.safety).toMatchObject({ readOnly: true, mutates: false });
  });

  it("combines durable audit records with task routing records", async () => {
    const auditRecord = createHermesDecisionRecord({
      kind: "escalation",
      subject: { type: "task", id: "task-escalated" },
      decision: "escalated",
      reasons: ["high risk"],
      outcome: { summary: "operator alerted" },
      safety: { readOnly: false, mutates: false },
      generatedAt: "2026-05-31T11:00:00.000Z",
    });
    const taskRecord = createHermesDecisionRecord({
      kind: "routing",
      subject: { type: "task", id: "task-routed" },
      decision: "routed to claude",
      reasons: ["scorecard"],
      outcome: { summary: "task proposed" },
      safety: { readOnly: true, mutates: false },
      generatedAt: "2026-05-31T12:00:00.000Z",
    });
    const task: CodexTask = {
      schemaVersion: 1,
      kind: "codex_task",
      id: "task-routed",
      repo: "owner/repo",
      prompt: "Do work",
      status: "proposed",
      createdAt: "2026-05-31T12:00:00.000Z",
      updatedAt: "2026-05-31T12:00:00.000Z",
      decisionRecord: taskRecord,
    };

    const response = await listDecisionRecordsForMonitor({
      query: async () => [{ decision_record: auditRecord }],
      tasks: [task],
      limit: 2,
      now: new Date("2026-05-31T13:00:00.000Z"),
    });

    expect(response.records.map((record) => record.subject.id)).toEqual(["task-routed", "task-escalated"]);
  });
});
