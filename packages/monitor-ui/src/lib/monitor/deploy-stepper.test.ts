import { describe, expect, test } from "vitest";
import { deployStepsForCard } from "./deploy-stepper.js";

describe("deployStepsForCard", () => {
  test("maps only real named check-run sources to deploy steps", () => {
    const steps = deployStepsForCard({
      checkRuns: [
        { name: "CI queued", status: "pass" },
        { name: "install dependencies", status: "pass" },
        { name: "unit tests", status: "running" },
      ],
    });

    expect(steps.map((step) => [step.label, step.state])).toEqual([
      ["CI queued", "done"],
      ["install", "done"],
      ["unit tests", "in-progress"],
      ["browser replay", "pending"],
      ["Hermes review", "pending"],
      ["ready", "pending"],
    ]);
    expect(steps.find((step) => step.id === "browser-replay")?.detail).toBe("awaiting data");
  });

  test("legacy verification label can mark the current stage but not completed prior stages", () => {
    const steps = deployStepsForCard({
      verification: { current: 3, total: 5, label: "browser replay" },
    });

    expect(steps.find((step) => step.id === "browser-replay")?.state).toBe("in-progress");
    expect(steps.filter((step) => step.state === "done")).toHaveLength(0);
    expect(steps.find((step) => step.id === "ci-queued")?.detail).toBe("awaiting data");
  });

  test("explicit deploySteps source wins when the backend wires exact step data", () => {
    const steps = deployStepsForCard({
      deploySteps: [
        { label: "CI queued", state: "done", detail: "workflow 123" },
        { label: "Hermes review", state: "current", detail: "reviewing evidence" },
      ],
      checkRuns: [
        { name: "Hermes review", status: "pass" },
      ],
    });

    expect(steps.find((step) => step.id === "ci-queued")).toMatchObject({
      state: "done",
      detail: "workflow 123",
    });
    expect(steps.find((step) => step.id === "hermes-review")).toMatchObject({
      state: "in-progress",
      detail: "reviewing evidence",
    });
  });

  test("with no deploy source, every step stays pending and awaiting data", () => {
    const steps = deployStepsForCard({});

    expect(steps).toHaveLength(6);
    expect(steps.every((step) => step.state === "pending")).toBe(true);
    expect(steps.every((step) => step.detail === "awaiting data")).toBe(true);
  });
});
