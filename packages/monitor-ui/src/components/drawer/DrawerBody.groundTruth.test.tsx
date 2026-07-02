// @vitest-environment jsdom
import { afterEach, describe, expect, test } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { DrawerBody, drawerVariant } from "./DrawerBody.js";
import type { BoardCard, CardGroundTruth, CardClaimFlag } from "../../lib/monitor/card-types.js";

afterEach(cleanup);

/**
 * A proposed Codex task card that cites a PR. The ground-truth panel lives in
 * the SHARED DrawerBody wrapper, so it renders regardless of which body variant
 * the card routes to (an actionable task routes to the "action"/PrBody variant,
 * not TaskBody — this proves the wrapper avoids that trap).
 */
function taskCard(over: {
  groundTruth?: CardGroundTruth;
  claimFlags?: CardClaimFlag[];
  isAction?: boolean;
}): BoardCard {
  return {
    id: "codex-task-depre-dev-agent-new-1-aa",
    type: "task",
    lane: "codex-needed",
    agentType: "codex",
    title: "Decompose blocked PR #717",
    summary: "Awaiting operator approval to dispatch.",
    repo: "depre-dev/agent",
    freshness: 2,
    state: "fresh",
    risk: [],
    taskStatus: "proposed",
    prompt: "decompose blocked PR #717 — it blocks the merge and touches secrets + migrations.",
    waitingOn: { actor: "operator", tone: "warn" },
    ...over,
  } as unknown as BoardCard;
}

describe("DrawerBody — proposed-task ground-truth verification panel", () => {
  test("mismatch card renders the ⚠ warn block with each flag's detail", () => {
    const card = taskCard({
      groundTruth: {
        pr: 717,
        repo: "depre-dev/agent",
        verified: true,
        mergeableState: "clean",
        checks: { passed: 5, failed: 0, total: 5 },
        touchedAreas: ["contracts", "tests"],
        verdict: "ok_to_merge",
      },
      claimFlags: [
        { kind: "claimed_blocked_but_mergeable", detail: "Task says PR #717 is blocked, but it is clean with 0 failed checks." },
        { kind: "claimed_category_absent", detail: "Task claims 'secrets' + 'migrations', but PR #717's real diff touches: contracts, tests." },
      ],
    });
    const { container } = render(<DrawerBody card={card} variant={drawerVariant(card)} />);
    const text = container.textContent ?? "";
    // The warn header + both flag details are surfaced.
    expect(text).toMatch(/claim doesn't match the PR/i);
    expect(text).toMatch(/is blocked, but it is clean with 0 failed checks/);
    expect(text).toMatch(/real diff touches: contracts, tests/);
    // The real ground-truth signals are shown as fact.
    expect(text).toMatch(/717 · ground truth|717 ground truth/);
    expect(text).toMatch(/5\/5 passed/);
    // The warn tint is applied (not the calm/green "consistent" line).
    expect(container.querySelector(".hm-verdict-block--warn")).toBeTruthy();
    expect(text).not.toMatch(/consistent with the PR's real signals/);
  });

  test("verified card WITH NO flags renders the calm 'consistent' line, not a warning", () => {
    const card = taskCard({
      isAction: false,
      groundTruth: {
        pr: 717,
        repo: "depre-dev/agent",
        verified: true,
        mergeableState: "clean",
        checks: { passed: 5, failed: 0, total: 5 },
        touchedAreas: ["contracts"],
        verdict: "ok_to_merge",
      },
    });
    const { container } = render(<DrawerBody card={card} variant={drawerVariant(card)} />);
    const text = container.textContent ?? "";
    expect(text).toMatch(/consistent with the PR's real signals/);
    expect(container.querySelector(".hm-verdict-block--warn")).toBeNull();
  });

  test("verified:false card renders an honest 'couldn't verify' note — NEVER a green/consistent state", () => {
    const card = taskCard({
      groundTruth: {
        pr: 717,
        repo: "depre-dev/agent",
        verified: false,
        reason: "PR state unavailable — not among the fetched open PRs, rate-limited, or already closed.",
      },
    });
    const { container } = render(<DrawerBody card={card} variant={drawerVariant(card)} />);
    const text = container.textContent ?? "";
    expect(text).toMatch(/Couldn't verify PR #717/);
    expect(text).toMatch(/Judge Hermes's claim yourself/);
    // Truth boundary: no agreement, no warn, no ground-truth grid.
    expect(text).not.toMatch(/consistent with the PR's real signals/);
    expect(container.querySelector(".hm-verdict-block--warn")).toBeNull();
    expect(container.querySelector(".h4-eo")).toBeNull();
  });

  test("no groundTruth ⇒ the section is absent entirely (honest absence, no PR cited)", () => {
    const card = taskCard({});
    const { container } = render(<DrawerBody card={card} variant={drawerVariant(card)} />);
    const text = container.textContent ?? "";
    expect(text).not.toMatch(/Verify the claim/);
    expect(text).not.toMatch(/ground truth/i);
    expect(text).not.toMatch(/Couldn't verify/);
  });
});
