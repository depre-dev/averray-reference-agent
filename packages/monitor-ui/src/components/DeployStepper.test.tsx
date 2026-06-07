// @vitest-environment jsdom
import { afterEach, describe, expect, test } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { DeployStepper } from "./DeployStepper.js";
import { DEPLOY_STEPS, type DeployStepView } from "../lib/monitor/deploy-stepper.js";

afterEach(cleanup);

const allPending: DeployStepView[] = DEPLOY_STEPS.map((s) => ({ ...s, state: "pending", detail: "awaiting data" }));

describe("DeployStepper — PR-G honest all-pending note", () => {
  test("an all-pending stepper carries an explicit 'awaiting deploy telemetry' note (no fabricated ✓)", () => {
    const { getByText, container } = render(<DeployStepper steps={allPending} />);
    expect(getByText("awaiting deploy telemetry")).toBeTruthy();
    // truth-boundary: no step is marked done.
    expect(container.querySelectorAll(".h4-stepper-row.is-done").length).toBe(0);
    expect(container.querySelectorAll(".h4-stepper-row").length).toBe(DEPLOY_STEPS.length);
  });

  test("the note disappears once any step has real telemetry", () => {
    const partlyWired = allPending.map((s, i) => (i === 0 ? { ...s, state: "in-progress" as const, detail: "CI running" } : s));
    const { queryByText } = render(<DeployStepper steps={partlyWired} />);
    expect(queryByText("awaiting deploy telemetry")).toBeNull();
  });
});
