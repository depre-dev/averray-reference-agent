import { describe, expect, test } from "vitest";
import {
  humanizeSignalCode,
  humanizedSignalParts,
  humanizeSignalText,
} from "./signal-labels.js";

describe("signal-labels", () => {
  test("maps known guardrail enum codes to exact human labels", () => {
    expect(humanizeSignalCode("dispatch_budget_exhausted"))
      .toBe("Dispatch budget used up - paused until reset");
    expect(humanizeSignalCode("open_fix_cap_reached"))
      .toBe("Self-healing fix cap reached - won't propose more");
    expect(humanizeSignalCode("duplicate_signal"))
      .toBe("Skipped - duplicate of an existing fix");
    expect(humanizeSignalCode("routed_fix")).toBe("Routed fix proposal");
  });

  test("keeps unknown enum-like codes readable without dropping the raw token", () => {
    expect(humanizeSignalCode("runner_active_task_mismatch")).toBe("runner active task mismatch");
    expect(humanizedSignalParts("runner_active_task_mismatch")).toEqual([
      { text: "runner active task mismatch", rawCode: "runner_active_task_mismatch" },
    ]);
  });

  test("humanizes enum tokens inside sentences", () => {
    expect(humanizeSignalText("Reason: dispatch_budget_exhausted; next duplicate_signal."))
      .toBe("Reason: Dispatch budget used up - paused until reset; next Skipped - duplicate of an existing fix.");
  });
});
