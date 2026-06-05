// @vitest-environment jsdom
import { afterEach, describe, expect, test } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { DrawerBody } from "./DrawerBody.js";
import type { BoardCard } from "../../lib/monitor/card-types.js";

afterEach(cleanup);

function deployCard(over: Record<string, unknown>): BoardCard {
  return {
    id: "deploy-1",
    type: "deploy",
    lane: "deploying",
    agentType: "hermes",
    title: "Deploy monitor stack",
    summary: "Verifying the deploy.",
    repo: "averray-reference-agent",
    freshness: 2,
    state: "running",
    risk: [],
    waitingOn: { actor: "CI", tone: "info" },
    deployId: "deploy-abc123",
    ...over,
  } as unknown as BoardCard;
}

describe("DeployBody — PR-D2 checkpoint stepper + honest awaiting-data", () => {
  test("renders a checkpoint stepper from real verification counters", () => {
    const card = deployCard({ verification: { current: 2, total: 5, label: "smoke tests" } });
    const { container } = render(<DrawerBody card={card} variant="deploy" />);
    const stepper = container.querySelector(".h4-stepper");
    expect(stepper).toBeTruthy();
    expect(container.querySelectorAll(".h4-stepper-dot").length).toBe(5);
    expect(container.querySelectorAll(".h4-stepper-dot.is-done").length).toBe(2);
    expect(stepper?.textContent).toMatch(/2\/5 · smoke tests/);
    expect(container.querySelector(".h4-awaiting")).toBeNull();
  });

  test("shows an honest 'awaiting data' slot when verification isn't wired", () => {
    const card = deployCard({ verification: undefined });
    const { container } = render(<DrawerBody card={card} variant="deploy" />);
    const awaiting = container.querySelector(".h4-awaiting");
    expect(awaiting).toBeTruthy();
    expect(awaiting?.textContent).toMatch(/awaiting data/i);
    expect(container.querySelector(".h4-stepper")).toBeNull();
  });
});
