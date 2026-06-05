import { describe, expect, test } from "vitest";
import { tierFor, isWaitingOnOperator } from "./lane-rules.js";
import { LANES, type BoardCard } from "./card-types.js";

describe("tierFor — DECIDE / WATCH / HIDE kanban tiers", () => {
  test("needs-attention is the only DECIDE lane (Decision Inbox)", () => {
    expect(tierFor("needs-attention")).toBe("decide");
    const decide = LANES.filter((l) => tierFor(l) === "decide");
    expect(decide).toEqual(["needs-attention"]);
  });

  test("done is HIDE", () => {
    expect(tierFor("done")).toBe("hide");
  });

  test("every other lane is WATCH", () => {
    for (const lane of LANES) {
      if (lane === "needs-attention" || lane === "done") continue;
      expect(tierFor(lane)).toBe("watch");
    }
  });

  test("every lane maps to exactly one tier", () => {
    for (const lane of LANES) {
      expect(["decide", "watch", "hide"]).toContain(tierFor(lane));
    }
  });
});

describe("isWaitingOnOperator", () => {
  const card = (over: Partial<BoardCard>) => over as BoardCard;

  test("true for an action card", () => {
    expect(isWaitingOnOperator(card({ isAction: true }))).toBe(true);
  });

  test("true when waitingOn.actor is the operator", () => {
    expect(isWaitingOnOperator(card({ waitingOn: { actor: "operator", tone: "warn" } }))).toBe(true);
  });

  test("false for a card waiting on CI / an agent", () => {
    expect(isWaitingOnOperator(card({ waitingOn: { actor: "CI", tone: "info" } }))).toBe(false);
    expect(isWaitingOnOperator(card({ waitingOn: { actor: "agent", tone: "neutral" } }))).toBe(false);
  });

  test("false for null / undefined", () => {
    expect(isWaitingOnOperator(undefined)).toBe(false);
    expect(isWaitingOnOperator(null)).toBe(false);
  });
});
