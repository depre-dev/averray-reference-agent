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

describe("PR-D3b — compact Decision-Inbox context", () => {
  test("a read-only decision shows an ok grants chip + 'what happens next'", () => {
    const { container, getByText } = render(<Card card={decisionCard(record())} />);
    const inbox = container.querySelector(".hm-decision-inbox");
    expect(inbox).toBeTruthy();
    const chip = inbox?.querySelector(".h4-badge--gate");
    expect(chip?.textContent).toMatch(/read-only/);
    expect(chip?.className).toContain("h4-tone--ok");
    expect(getByText(/What happens next/)).toBeTruthy();
    expect(getByText(/Hermes merges and verifies the deploy/)).toBeTruthy();
  });

  test("a mutating decision names the surfaces it touches with a warn chip", () => {
    const { container } = render(
      <Card card={decisionCard(record({ safety: { readOnly: false, mutates: true, mutatesGithub: true, mutatesAverray: true } }))} />
    );
    const chip = container.querySelector(".hm-decision-inbox .h4-badge--gate");
    expect(chip?.textContent).toMatch(/mutates GitHub · Averray/);
    expect(chip?.className).toContain("h4-tone--warn");
  });

  test("renders no inbox context on a non-decision lane card", () => {
    const card = decisionCard(record());
    (card as { isAction?: boolean }).isAction = false;
    (card as { lane?: string }).lane = "hermes-checking";
    const { container } = render(<Card card={card} />);
    expect(container.querySelector(".hm-decision-inbox")).toBeNull();
  });
});
