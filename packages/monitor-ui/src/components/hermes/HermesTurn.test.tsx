// @vitest-environment jsdom
import { afterEach, describe, expect, test } from "vitest";
import { cleanup, render, within } from "@testing-library/react";
import { HermesTurn } from "./HermesTurn.js";
import type { CollaborationMessage } from "../../lib/monitor/collaboration.js";

afterEach(cleanup);

const base: CollaborationMessage = {
  id: "1",
  ts: Date.parse("2026-05-28T10:00:00Z"),
  author: "hermes",
  kind: "status",
  text: "Pre-check passed on #548.",
  addressedTo: "operator",
};

describe("HermesTurn", () => {
  test("renders actor label, kind, and body", () => {
    const { container, getByText } = render(<HermesTurn turn={base} />);
    expect(getByText("Hermes")).toBeTruthy();
    expect(getByText(/status/)).toBeTruthy();
    expect(getByText("Pre-check passed on #548.")).toBeTruthy();
    expect((container.querySelector(".hm-turn") as HTMLElement).className).toContain("hm-turn--hermes");
  });

  test("labels live and templated Hermes turns honestly", () => {
    const live = render(<HermesTurn turn={{ ...base, id: "live", hermesMode: "live" }} />);
    expect(live.getByText("Hermes (live)")).toBeTruthy();
    live.unmount();

    const templated = render(<HermesTurn turn={{ ...base, id: "templated", hermesMode: "templated" }} />);
    expect(templated.getByText("Hermes (offline — templated)")).toBeTruthy();
  });

  test("operator turns are labelled Pascal", () => {
    const { getByText } = render(<HermesTurn turn={{ ...base, id: "2", author: "operator" }} />);
    expect(getByText("Pascal")).toBeTruthy();
  });

  test("Claude turns are attributed as agent messages", () => {
    const { container, getByText } = render(
      <HermesTurn turn={{ ...base, id: "claude-1", author: "claude", addressedTo: "codex" }} />,
    );
    expect(getByText("Claude")).toBeTruthy();
    expect((container.querySelector(".hm-turn") as HTMLElement).className).toContain("hm-turn--claude");
  });

  test("a relatedPr renders a real GitHub PR link", () => {
    const { container } = render(
      <HermesTurn turn={{ ...base, id: "3", relatedPr: { repo: "depre-dev/agent", number: 548 } }} />,
    );
    const link = within(container).getByRole("link") as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("https://github.com/depre-dev/agent/pull/548");
    expect(link.textContent).toContain("#548");
  });

  test("no link when there is no relatedPr", () => {
    const { queryByRole } = render(<HermesTurn turn={base} />);
    expect(queryByRole("link")).toBeNull();
  });
});
