// @vitest-environment jsdom
import { afterEach, describe, expect, test } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { DrawerBody, drawerVariant } from "./DrawerBody.js";
import type { BoardCard } from "../../lib/monitor/card-types.js";

afterEach(cleanup);

function card(over: Record<string, unknown>): BoardCard {
  return {
    id: "card-1",
    lane: "hermes-checking",
    type: "pr",
    agentType: "codex",
    title: "Test card",
    summary: "summary",
    repo: "depre-dev/agent",
    freshness: 5,
    state: "fresh",
    risk: [],
    waitingOn: { actor: "agent", tone: "info" },
    files: [],
    ...over,
  } as BoardCard;
}

describe("drawerVariant — operator-decision lanes get the risk-decision treatment (P1-1/P0)", () => {
  test("a PR in operator-review (isAction=false) is 'action', not 'pr'/'Automation in flight'", () => {
    expect(drawerVariant(card({ type: "pr", lane: "operator-review", isAction: false }))).toBe("action");
  });

  test("a card in needs-attention is 'action'", () => {
    expect(drawerVariant(card({ type: "pr", lane: "needs-attention", isAction: false }))).toBe("action");
  });

  test("isAction still wins, missions still render their report", () => {
    expect(drawerVariant(card({ isAction: true, lane: "hermes-checking" }))).toBe("action");
    expect(drawerVariant(card({ type: "mission", lane: "needs-attention" }))).toBe("mission");
  });

  test("a proposed codex task (codex-needed) stays the 'task' variant", () => {
    expect(drawerVariant(card({ type: "task", lane: "codex-needed", isAction: false }))).toBe("task");
  });

  test("a plain in-flight PR (hermes-checking) stays 'pr'", () => {
    expect(drawerVariant(card({ type: "pr", lane: "hermes-checking", isAction: false }))).toBe("pr");
  });
});

describe("DrawerBody — a failed status doesn't render as the green 'ok' box (tone)", () => {
  test("a failed task's Status block carries the warn modifier", () => {
    const failed = card({ type: "task", taskStatus: "failed", lane: "needs-attention", summary: "Task failed in the runner." });
    const { container, getByText } = render(<DrawerBody card={failed} variant="action" />);
    expect(getByText("Task failed in the runner.")).toBeTruthy();
    expect(container.querySelector(".hm-verdict-block--warn")).toBeTruthy();
  });

  test("a healthy card's Status block stays the default (no warn tint)", () => {
    const ok = card({ type: "pr", lane: "operator-review", isAction: false, summary: "Waiting on your review." });
    const { container } = render(<DrawerBody card={ok} variant="action" />);
    expect(container.querySelector(".hm-verdict-block--warn")).toBeNull();
  });
});
