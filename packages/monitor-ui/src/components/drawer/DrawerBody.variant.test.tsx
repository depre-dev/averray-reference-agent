// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, test } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { DrawerBody, drawerVariant } from "./DrawerBody.js";
import type { BoardCard } from "../../lib/monitor/card-types.js";
import type { AgentRunProjectionV1 } from "@avg/schemas";

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

function projection(): AgentRunProjectionV1 {
  return JSON.parse(
    readFileSync("test/fixtures/agent-integration/agent-run-projection-v1.json", "utf8"),
  ) as AgentRunProjectionV1;
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

  test("a Harness projection keeps its read-only Harness variant even in attention", () => {
    expect(drawerVariant(card({
      type: "task",
      lane: "needs-attention",
      harnessRun: projection(),
    }))).toBe("harness");
  });

  test("a plain in-flight PR (hermes-checking) stays 'pr'", () => {
    expect(drawerVariant(card({ type: "pr", lane: "hermes-checking", isAction: false }))).toBe("pr");
  });
});

describe("DrawerBody — Harness evidence", () => {
  test("shows state, manifest, budgets, artifacts, and the no-mutation boundary", () => {
    const c = card({
      id: "work-001",
      type: "task",
      agentType: "harness",
      lane: "codex-needed",
      harnessRun: projection(),
    });
    const { container } = render(<DrawerBody card={c} variant="harness" />);
    expect(container.textContent).toContain("Read-only Harness run");
    expect(container.textContent).toContain("Pinned manifest");
    expect(container.textContent).toContain("coding-change");
    expect(container.textContent).toContain("model tokens");
    expect(container.textContent).toContain("read only");
    expect(container.textContent).toContain("cannot submit, approve, cancel, release");
  });
});

describe("DrawerBody — 'What you can do' guidance on decision cards", () => {
  test("surfaces the next move for a bare-verdict decision card (the deploy-failed case)", () => {
    const c = card({
      type: "deploy", lane: "operator-review", isAction: true,
      verdict: "deploy failed",
      next: "prepare a fix or rollback plan, then let deployment verification run again",
    });
    const { container } = render(<DrawerBody card={c} variant="action" />);
    expect(container.textContent).toContain("What you can do");
    expect(container.textContent).toContain("prepare a fix or rollback plan");
  });

  test("points at Ask Hermes when no reason is recorded anywhere", () => {
    // no verdict / risk signals / record, and no waiting-on actor → nothing to derive a why from
    const c = card({ type: "deploy", lane: "operator-review", isAction: true, waitingOn: undefined });
    const { container } = render(<DrawerBody card={c} variant="action" />);
    expect(container.textContent).toContain("Ask Hermes");
  });

  test("stays out of the way when the drawer already explains why and there's no next move", () => {
    const c = card({ type: "pr", lane: "operator-review", isAction: true, verdict: "needs review" });
    const { container } = render(<DrawerBody card={c} variant="action" />);
    expect(container.textContent).not.toContain("What you can do");
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
