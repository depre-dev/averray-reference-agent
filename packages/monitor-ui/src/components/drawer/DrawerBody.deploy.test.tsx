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

describe("DeployBody — E5 named deploy stepper + honest awaiting-data", () => {
  test("renders named deploy steps from real check-run sources", () => {
    const card = deployCard({
      checks: { pass: 2, running: 1, fail: 0, pending: 3, total: 6 },
      checkRuns: [
        { name: "CI queued", status: "pass" },
        { name: "install dependencies", status: "pass" },
        { name: "unit tests", status: "running" },
      ],
    });
    const { container } = render(<DrawerBody card={card} variant="deploy" />);
    const stepper = container.querySelector(".h4-stepper");
    expect(stepper).toBeTruthy();
    expect(container.querySelectorAll(".h4-stepper-row").length).toBe(6);
    expect(container.querySelectorAll(".h4-stepper-row.is-done").length).toBe(2);
    expect(container.querySelectorAll(".h4-stepper-row.is-in-progress").length).toBe(1);
    expect(stepper?.textContent).toMatch(/CI queued/);
    expect(stepper?.textContent).toMatch(/browser replaypendingawaiting data/);
  });

  test("shows honest pending awaiting-data steps when verification isn't wired", () => {
    const card = deployCard({ verification: undefined });
    const { container } = render(<DrawerBody card={card} variant="deploy" />);
    expect(container.querySelector(".h4-stepper")).toBeTruthy();
    expect(container.querySelectorAll(".h4-stepper-row").length).toBe(6);
    expect(container.querySelectorAll(".h4-stepper-row.is-done").length).toBe(0);
    expect(container.textContent?.match(/awaiting data/g)?.length).toBe(6);
  });

  test("legacy verification label marks only the active stage, not fake completed steps", () => {
    const card = deployCard({ verification: { current: 4, total: 6, label: "browser replay" } });
    const { container } = render(<DrawerBody card={card} variant="deploy" />);
    expect(container.querySelectorAll(".h4-stepper-row.is-done").length).toBe(0);
    expect(container.querySelectorAll(".h4-stepper-row.is-in-progress").length).toBe(1);
    expect(container.textContent).toMatch(/browser replayin progress/);
  });
});
