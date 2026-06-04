// @vitest-environment jsdom
import { afterEach, describe, expect, test } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { AgentTag, Badge, Button, CardHeader, EmptyState, LaneHeader, StatusPill } from "./ui.js";

afterEach(cleanup);

describe("monitor design primitives", () => {
  test("Badge and StatusPill apply state variants from one vocabulary", () => {
    const { container, getByText } = render(
      <>
        <Badge variant="fail" dot>failed</Badge>
        <StatusPill variant="degraded" dot>?</StatusPill>
      </>,
    );
    expect(getByText("failed").className).toContain("hm-pill--fail");
    expect(getByText("?").className).toContain("hm-status-pill--degraded");
    expect(container.querySelectorAll(".dot, .status-dot")).toHaveLength(2);
  });

  test("Button variants keep native button semantics", () => {
    const { getByRole } = render(<Button variant="action">Re-run</Button>);
    const button = getByRole("button", { name: "Re-run" });
    expect(button.className).toContain("hm-btn--action");
    expect(button.getAttribute("type")).toBe("button");
  });

  test("AgentTag renders the shared agent dot grammar", () => {
    const { container, getByText } = render(<AgentTag agent="claude" identifier="#123" />);
    expect(container.querySelector(".agent-dot--claude")).toBeTruthy();
    expect(getByText("claude")).toBeTruthy();
    expect(getByText("#123")).toBeTruthy();
  });

  test("CardHeader and LaneHeader expose the unified board grammar", () => {
    const { container, getByText } = render(
      <>
        <CardHeader agent="codex" id="#9" status="FRESH 2m" statusVariant="fresh" />
        <LaneHeader title="PRE-CHECK IN FLIGHT" count={1} action="Risk decision" />
      </>,
    );
    expect(container.querySelector(".hm-card-head .hm-agent-tag")).toBeTruthy();
    expect(container.querySelector(".hm-lane-head .hm-lane-count")).toBeTruthy();
    expect(getByText("PRE-CHECK IN FLIGHT")).toBeTruthy();
  });

  test("EmptyState is a reusable quiet state, not a card", () => {
    const { container, getByText } = render(<EmptyState>Nothing needs you right now.</EmptyState>);
    expect(container.querySelector(".hm-empty-state")).toBeTruthy();
    expect(getByText("Nothing needs you right now.")).toBeTruthy();
    expect(container.querySelector(".hm-card")).toBeNull();
  });
});
