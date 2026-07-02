// @vitest-environment jsdom
import { afterEach, describe, expect, test } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { DrawerBody } from "./DrawerBody.js";
import { drawerVariant } from "./DrawerBody.js";
import type { BoardCard } from "../../lib/monitor/card-types.js";

afterEach(cleanup);

/**
 * A failed operator-decision card (needs-attention) with NO recorded reason, so
 * the "What you can do" section shows its existing "Ask Hermes" pointer when no
 * analysis is present — the exact bare-card state this feature augments.
 */
function failedCard(over: Record<string, unknown>): BoardCard {
  return {
    id: "deploy-1",
    type: "deploy",
    lane: "needs-attention",
    agentType: "hermes",
    title: "Deploy monitor stack",
    summary: "Deploy failed.",
    repo: "averray-reference-agent",
    freshness: 3,
    state: "failed-fetch",
    risk: [],
    isAction: true,
    waitingOn: { actor: "operator", tone: "warn" },
    ...over,
  } as unknown as BoardCard;
}

describe("DrawerBody — Hermes's read (agentic failure analysis)", () => {
  test("renders the analysis, tagged as an agentic analysis, when card.hermesAnalysis is present", () => {
    const card = failedCard({
      hermesAnalysis: {
        text: "Both unit tests and browser replay failed on this deploy, so verification never went green; roll back to the last passing build and re-run before promoting.",
        model: "hermes-4",
        at: "2026-07-01T00:00:00.000Z",
      },
    });
    const { container } = render(<DrawerBody card={card} variant={drawerVariant(card)} />);
    const text = container.textContent ?? "";
    expect(text).toMatch(/Hermes's read/);
    // clearly tagged as an agentic analysis (honesty label)
    expect(text).toMatch(/agentic analysis/);
    // the grounded analysis text is surfaced verbatim
    expect(text).toMatch(/roll back to the last passing build/);
    // and it is framed as a read, not a verified root cause
    expect(text).toMatch(/not a verified root cause/i);
  });

  test("surfaces the 'cause unclear' analysis verbatim (truth boundary — never a fabricated cause)", () => {
    const card = failedCard({
      hermesAnalysis: {
        text: "Cause unclear from the available signals. Open the failed check output before deciding whether to fix or roll back.",
        at: "2026-07-01T00:00:00.000Z",
      },
    });
    const { container } = render(<DrawerBody card={card} variant={drawerVariant(card)} />);
    expect(container.textContent).toMatch(/Cause unclear from the available signals\./);
  });

  // A bare decision card with no recorded why anywhere → the existing drawer
  // shows its "Ask Hermes" pointer (see DrawerBody.variant.test.tsx). We reuse
  // that exact shape to prove HermesReadSection neither renders nor disturbs it.
  function barePointerCard(over: Record<string, unknown>): BoardCard {
    return {
      id: "bare-1",
      type: "deploy",
      lane: "operator-review",
      agentType: "hermes",
      title: "Deploy monitor stack",
      summary: "summary",
      repo: "averray-reference-agent",
      freshness: 5,
      state: "fresh",
      risk: [],
      isAction: true,
      waitingOn: undefined,
      ...over,
    } as unknown as BoardCard;
  }

  test("when NO analysis is present, renders no 'Hermes's read' and keeps the existing 'Ask Hermes' pointer", () => {
    const card = barePointerCard({}); // no hermesAnalysis, no recorded why
    const { container } = render(<DrawerBody card={card} variant={drawerVariant(card)} />);
    const text = container.textContent ?? "";
    // No agentic-read section at all — byte-for-byte the existing bare-card drawer.
    expect(text).not.toMatch(/Hermes's read/);
    expect(text).not.toMatch(/agentic analysis/);
    // The existing "Ask Hermes" pointer in "What you can do" is preserved.
    expect(text).toMatch(/Ask Hermes/);
  });

  test("an empty analysis text renders nothing (never an empty agentic box) and keeps the pointer", () => {
    const card = barePointerCard({ hermesAnalysis: { text: "   ", at: "2026-07-01T00:00:00.000Z" } });
    const { container } = render(<DrawerBody card={card} variant={drawerVariant(card)} />);
    expect(container.textContent).not.toMatch(/Hermes's read/);
    // still shows the pointer since there's no recorded why
    expect(container.textContent).toMatch(/Ask Hermes/);
  });
});
