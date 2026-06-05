// @vitest-environment jsdom
import { afterEach, describe, expect, test } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { CardBadges } from "./CardBadges.js";
import type { BoardCard } from "../../lib/monitor/card-types.js";

afterEach(cleanup);

function card(over: Record<string, unknown>): BoardCard {
  return { id: "x", type: "pr", state: "fresh", risk: [], waitingOn: { actor: "agent", tone: "neutral" }, ...over } as BoardCard;
}

describe("CardBadges — State family", () => {
  test("a running mission shows a running State badge (ok tone)", () => {
    const { container } = render(<CardBadges card={card({ type: "mission", missionStatus: "running" })} />);
    const badge = container.querySelector(".h4-badge--state");
    expect(badge?.textContent).toMatch(/running/i);
    expect(badge?.className).toContain("h4-tone--ok");
  });
  test("a stale card shows a warn State badge", () => {
    const { container } = render(<CardBadges card={card({ state: "stale" })} />);
    const badge = container.querySelector(".h4-badge--state");
    expect(badge?.textContent).toMatch(/stale/i);
    expect(badge?.className).toContain("h4-tone--warn");
  });
});

describe("CardBadges — Risk family", () => {
  test("risk tags render verbatim; a high signal escalates the family to warn", () => {
    const { container } = render(
      <CardBadges card={card({ risk: ["workflow", "contracts"], riskSignals: [{ severity: "high", code: "x", message: "m" }] })} />
    );
    const text = container.textContent ?? "";
    expect(text).toContain("workflow");
    expect(text).toContain("contracts");
    expect(container.querySelector(".h4-badge--risk.h4-tone--warn")?.textContent).toMatch(/risk: high/i);
  });
});

describe("CardBadges — Evidence family (mission only)", () => {
  test("counts mission evidence per kind", () => {
    const { container } = render(
      <CardBadges card={card({ type: "mission", mission: { evidence: [{ kind: "screenshot" }, { kind: "screenshot" }, { kind: "trace" }] } })} />
    );
    const text = container.textContent ?? "";
    expect(text).toMatch(/2 screenshots/i);
    expect(text).toMatch(/1 trace/i);
  });
  test("non-mission cards show no Evidence badge", () => {
    const { container } = render(<CardBadges card={card({ type: "pr" })} />);
    expect(container.querySelector(".h4-badge--evidence")).toBeNull();
  });
});

describe("CardBadges — Gate family", () => {
  test("operator → coral 'needs you' (act tone, DECIDE-orange)", () => {
    const { container } = render(<CardBadges card={card({ waitingOn: { actor: "operator", tone: "warn" } })} />);
    const gate = container.querySelector(".h4-badge--gate");
    expect(gate?.textContent).toMatch(/needs you/i);
    expect(gate?.className).toContain("h4-tone--act");
  });
  test("CI → telemetry tone, not coral", () => {
    const { container } = render(<CardBadges card={card({ waitingOn: { actor: "CI", tone: "info" } })} />);
    const gate = container.querySelector(".h4-badge--gate");
    expect(gate?.textContent).toMatch(/CI/);
    expect(gate?.className).toContain("h4-tone--tel");
    expect(gate?.className).not.toContain("h4-tone--act");
  });
});

describe("CardBadges — honest empty", () => {
  test("renders nothing when no family has data", () => {
    const { container } = render(
      <CardBadges card={{ id: "y", type: "pr", risk: [] } as unknown as BoardCard} />
    );
    expect(container.querySelector(".hm-card-badges")).toBeNull();
  });
});
