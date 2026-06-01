import { describe, expect, test } from "vitest";
import { buildHermesActivityFeed } from "./activity-feed.js";
import type { BoardNowBanner } from "./board-state.js";
import type { BoardCard, HermesDecisionRecord } from "./card-types.js";
import type { CollaborationMessage } from "./collaboration.js";

const banner: BoardNowBanner = {
  tone: "action",
  eyebrow: "Board now",
  headline: "1 card needs your review decision; automation has gone as far as it safely can.",
  sub: "Most urgent: Self-healing fix.",
  primaryActionId: "task-1",
};

function task(overrides: Partial<BoardCard> = {}): BoardCard {
  return {
    id: "task-1",
    lane: "codex-needed",
    type: "task",
    agentType: "codex",
    title: "Self-healing fix",
    summary: "Hermes self-healing proposal for a failed testbed mission.",
    repo: "depre-dev/averray-reference-agent",
    freshness: 3,
    state: "fresh",
    risk: [],
    waitingOn: { actor: "operator", tone: "warn" },
    prompt: "Fix the failed mission.",
    taskStatus: "proposed",
    riskTier: "low",
    ...overrides,
  };
}

function decision(overrides: Partial<HermesDecisionRecord> = {}): HermesDecisionRecord {
  return {
    schemaVersion: 1,
    recordType: "hermes_decision_record",
    id: "hdr-routing-task-1",
    kind: "routing",
    subject: { type: "task", id: "task-1" },
    decision: "codex",
    reasons: ["The failure is low-risk and maps to Codex."],
    inputs: { riskTier: "low", routingReason: "testbed failure" },
    outcome: { summary: "Task proposed.", waitingNext: "Operator dispatch approval." },
    safety: { readOnly: true, mutates: false },
    generatedAt: "2026-05-28T10:01:00Z",
    ...overrides,
  };
}

function message(overrides: Partial<CollaborationMessage> = {}): CollaborationMessage {
  return {
    id: "msg-1",
    ts: Date.parse("2026-05-28T10:02:00Z"),
    author: "codex",
    kind: "request_help",
    addressedTo: "operator",
    text: "I need a second review before this moves forward.",
    relatedPr: { repo: "depre-dev/averray-reference-agent", number: 316 },
    ...overrides,
  };
}

describe("buildHermesActivityFeed", () => {
  test("turns real task state, decision records, and collaboration turns into activity", () => {
    const entries = buildHermesActivityFeed({
      cards: [task({ decisionRecord: decision() })],
      messages: [message()],
      banner,
      boardAt: "2026-05-28T10:04:00Z",
      now: () => Date.parse("2026-05-28T10:05:00Z"),
    });
    const text = entries.map((entry) => entry.text).join("\n");
    expect(text).toContain("Proposed Codex work for Self-healing fix");
    expect(text).toContain("Routed Self-healing fix");
    expect(text).toContain("Codex asked for help on depre-dev/averray-reference-agent#316");
    expect(entries.at(-1)).toMatchObject({
      source: "summary",
      text: "Needs you: review the current action lane, starting with task-1.",
      cardId: "task-1",
    });
  });

  test("says so when no real activity exists and still ends with the board summary", () => {
    const entries = buildHermesActivityFeed({
      cards: [],
      messages: [],
      banner: { ...banner, tone: "calm", headline: "Nothing waits on you.", primaryActionId: undefined },
      now: () => Date.parse("2026-05-28T10:05:00Z"),
    });
    expect(entries[0]?.text).toContain("No real Hermes activity has been logged yet");
    expect(entries.at(-1)?.text).toBe("Needs you: nothing right now.");
  });

  test("narrates review-panel responses without creating pretend chatter", () => {
    const entries = buildHermesActivityFeed({
      cards: [task({
        reviewRequests: [{
          id: "review-codex",
          requestedBy: "hermes",
          reviewer: "codex",
          reason: "High-risk work needs a panel.",
          status: "responded",
          reviewMode: "panel",
          panelId: "panel-1",
          panelSize: 3,
          response: {
            verdict: "block",
            reasoning: "Codex found an unresolved deploy risk.",
            respondedAt: "2026-05-28T10:03:00Z",
          },
          createdAt: "2026-05-28T10:00:00Z",
          updatedAt: "2026-05-28T10:03:00Z",
        }],
      })],
      messages: [],
      banner,
      now: () => Date.parse("2026-05-28T10:05:00Z"),
    });
    expect(entries.map((entry) => entry.text).join("\n")).toContain(
      "Codex returned a block review on Self-healing fix: Codex found an unresolved deploy risk.",
    );
  });

  test("humanizes guardrail enums in proactive narration", () => {
    const entries = buildHermesActivityFeed({
      cards: [task({
        lane: "needs-attention",
        isAction: true,
        summary: "dispatch_budget_exhausted",
      })],
      messages: [],
      banner,
      now: () => Date.parse("2026-05-28T10:05:00Z"),
    });
    const text = entries.map((entry) => entry.text).join("\n");
    expect(text).toContain("Dispatch budget used up - paused until reset");
    expect(text).not.toContain("dispatch_budget_exhausted");
  });
});
