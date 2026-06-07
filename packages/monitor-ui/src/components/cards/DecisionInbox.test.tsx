// @vitest-environment jsdom
import { afterEach, describe, expect, test } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { Card } from "./Card.js";
import type { BoardCard, HermesDecisionRecord } from "../../lib/monitor/card-types.js";

afterEach(cleanup);

function record(over: Partial<HermesDecisionRecord> = {}): HermesDecisionRecord {
  return {
    schemaVersion: 1,
    recordType: "hermes_decision_record",
    id: "dr-1",
    kind: "routing",
    subject: { kind: "pr", id: "agent #547" } as never,
    decision: "route to operator",
    reasons: ["review-gated surface"],
    inputs: {},
    outcome: { summary: "Routed to you for a risk decision", waitingNext: "On approval, Hermes merges and verifies the deploy." },
    safety: { readOnly: true, mutates: false },
    generatedAt: "2026-06-06T09:00:00Z",
    ...over,
  };
}

function decisionCard(decisionRecord: HermesDecisionRecord): BoardCard {
  return {
    id: "agent #547",
    type: "pr",
    lane: "needs-attention",
    agentType: "claude",
    title: "Allow operator override of agent claim-stake floor",
    summary: "",
    repo: "averray-agent/agent",
    freshness: 1,
    state: "fresh",
    risk: ["review-gated"],
    waitingOn: { actor: "operator", tone: "warn" },
    isAction: true,
    decisionRecord,
  } as unknown as BoardCard;
}

describe("PR-E2 — Decision-Inbox card grammar", () => {
  test("a decision card shows reason + what-happens-next from the decision record", () => {
    const { container, getByText } = render(<Card card={decisionCard(record())} />);
    const context = container.querySelector(".hm-decision-grammar");
    expect(context).toBeTruthy();
    expect(getByText(/Why you're seeing this/)).toBeTruthy();
    expect(getByText(/review-gated surface/)).toBeTruthy();
    expect(getByText(/What happens next/)).toBeTruthy();
    expect(getByText(/Hermes merges and verifies the deploy/)).toBeTruthy();
    expect(container.querySelector(".hm-decision-inbox")).toBeNull();
  });

  test("reason copy remains traceable on mutating decisions", () => {
    const { getByText } = render(
      <Card card={decisionCard(record({ safety: { readOnly: false, mutates: true, mutatesGithub: true, mutatesAverray: true } }))} />
    );
    expect(getByText(/review-gated surface/)).toBeTruthy();
  });

  test("uses an honest fallback when no reason was recorded", () => {
    const noReason = record({ reasons: [] });
    const card = decisionCard(noReason);
    card.freshness = 0;
    const { getByText } = render(<Card card={card} />);
    expect(getByText(/Reason not recorded; open the drawer before acting/)).toBeTruthy();
  });

  test("renders no inbox context on a non-decision lane card", () => {
    const card = decisionCard(record());
    (card as { isAction?: boolean }).isAction = false;
    (card as { lane?: string }).lane = "hermes-checking";
    card.waitingOn = { actor: "CI", tone: "info" };
    const { container } = render(<Card card={card} />);
    expect(container.querySelector(".hm-decision-grammar")).toBeNull();
  });
});
