import { describe, expect, test } from "vitest";

import type { CardWorkingNow } from "./card-types.js";
import { describeWorkingNow, WORKING_NOW_STALE_MS } from "./working-now.js";

const NOW = Date.parse("2026-07-29T12:00:00Z");

function workingNow(over: Partial<CardWorkingNow> = {}): CardWorkingNow {
  return { agent: "claude", label: "Claude fixing", source: "runner", ...over };
}

function at(msAgo: number): string {
  return new Date(NOW - msAgo).toISOString();
}

describe("describeWorkingNow", () => {
  test("no workingNow yields nothing at all", () => {
    expect(describeWorkingNow(undefined, NOW)).toBeUndefined();
  });

  test("surfaces WHAT the agent is attempting, not just that it is busy", () => {
    const view = describeWorkingNow(
      workingNow({ intent: "Fix the settlement rounding drift", progress: "Claude is using Edit.", progressAt: at(30_000) }),
      NOW,
    );
    expect(view?.intent).toBe("Fix the settlement rounding drift");
    expect(view?.progress).toBe("Claude is using Edit.");
    expect(view?.progressAge).toBe("just now");
    expect(view?.stale).toBe(false);
  });

  test("a runner that has reported nothing SAYS so rather than showing a blank", () => {
    const view = describeWorkingNow(workingNow({ intent: "Rotate the smoke token" }), NOW);
    expect(view?.progress).toBeUndefined();
    expect(view?.emptyNote).toBe("No step reported yet.");
    expect(view?.stale).toBe(false);
  });

  test("a step past the bound is stale — it must not keep reading as live", () => {
    const view = describeWorkingNow(
      workingNow({ progress: "Claude is using Bash.", progressAt: at(WORKING_NOW_STALE_MS + 60_000) }),
      NOW,
    );
    expect(view?.stale).toBe(true);
    expect(view?.progressAge).toBe("11m ago");
  });

  test("the boundary itself is stale, one millisecond earlier is not", () => {
    expect(describeWorkingNow(workingNow({ progress: "x", progressAt: at(WORKING_NOW_STALE_MS) }), NOW)?.stale).toBe(true);
    expect(describeWorkingNow(workingNow({ progress: "x", progressAt: at(WORKING_NOW_STALE_MS - 1) }), NOW)?.stale).toBe(false);
  });

  test("an UNTIMESTAMPED step is shown without an age and never claimed as current", () => {
    // We can't age it, so we must not imply it is live — but we also must not
    // hide the only thing the agent told us.
    const view = describeWorkingNow(workingNow({ progress: "Claude is using Read." }), NOW);
    expect(view?.progress).toBe("Claude is using Read.");
    expect(view?.progressAge).toBeUndefined();
    expect(view?.stale).toBe(false);
  });

  test("an unparseable timestamp degrades to no-age rather than to 1970", () => {
    const view = describeWorkingNow(workingNow({ progress: "step", progressAt: "not-a-date" }), NOW);
    expect(view?.progressAge).toBeUndefined();
    expect(view?.stale).toBe(false);
  });

  test("a clock skewed into the future clamps to zero, never a negative age", () => {
    const view = describeWorkingNow(workingNow({ progress: "step", progressAt: at(-120_000) }), NOW);
    expect(view?.progressAge).toBe("just now");
    expect(view?.stale).toBe(false);
  });

  test("blank strings count as absent, not as content", () => {
    const view = describeWorkingNow(workingNow({ intent: "   ", progress: "" }), NOW);
    expect(view?.intent).toBeUndefined();
    expect(view?.progress).toBeUndefined();
    expect(view?.emptyNote).toBe("No step reported yet.");
  });

  test.each([
    [30 * 60 * 1000, "30m ago"],
    [3 * 60 * 60 * 1000, "3h ago"],
    [2 * 24 * 60 * 60 * 1000, "2d ago"],
  ])("ages coarsely at %ims", (ms, expected) => {
    expect(describeWorkingNow(workingNow({ progress: "s", progressAt: at(ms) }), NOW)?.progressAge).toBe(expected);
  });
});
