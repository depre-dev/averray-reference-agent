// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import { DetailDrawer } from "./DetailDrawer.js";
import { FIXTURE_CARDS, DEGRADED_FIXTURE_CARDS } from "../../lib/monitor/fixtures.js";
import type { BoardCard } from "../../lib/monitor/card-types.js";

afterEach(cleanup);

function fixture(id: string): BoardCard {
  const card = [...FIXTURE_CARDS, ...DEGRADED_FIXTURE_CARDS].find((c) => c.id === id);
  if (!card) throw new Error(`fixture not found: ${id}`);
  return card;
}

const noop = () => {};

describe("DetailDrawer — shell", () => {
  test("renders a labelled modal dialog with the card title", () => {
    const card = fixture("agent #548");
    const { getByRole } = render(
      <DetailDrawer card={card} cards={[{ id: card.id }]} onClose={noop} onNavigate={noop} />,
    );
    const dialog = getByRole("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(within(dialog).getByText("Allow operator override of agent claim-stake floor")).toBeTruthy();
  });

  test("focus is moved into the dialog on open (focus trap)", () => {
    const card = fixture("agent #548");
    const { getByRole } = render(
      <DetailDrawer card={card} cards={[{ id: card.id }]} onClose={noop} onNavigate={noop} />,
    );
    const dialog = getByRole("dialog");
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  test("esc closes", () => {
    const onClose = vi.fn();
    const card = fixture("agent #548");
    render(<DetailDrawer card={card} cards={[{ id: card.id }]} onClose={onClose} onNavigate={noop} />);
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("scrim click closes; clicking inside the sheet does not", () => {
    const onClose = vi.fn();
    const card = fixture("agent #548");
    const { container, getByRole } = render(
      <DetailDrawer card={card} cards={[{ id: card.id }]} onClose={onClose} onNavigate={noop} />,
    );
    fireEvent.click(getByRole("dialog"));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(container.querySelector(".hm-drawer-scrim") as HTMLElement);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("the close button closes", () => {
    const onClose = vi.fn();
    const card = fixture("agent #548");
    const { getByRole } = render(
      <DetailDrawer card={card} cards={[{ id: card.id }]} onClose={onClose} onNavigate={noop} />,
    );
    fireEvent.click(getByRole("button", { name: /esc · close/ }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("j / k traverse to the next / previous card", () => {
    const onNavigate = vi.fn();
    const card = fixture("agent #549");
    const cards = [{ id: "before" }, { id: "agent #549" }, { id: "after" }];
    render(<DetailDrawer card={card} cards={cards} onClose={noop} onNavigate={onNavigate} />);

    fireEvent.keyDown(document.body, { key: "j" });
    expect(onNavigate).toHaveBeenLastCalledWith("after");

    fireEvent.keyDown(document.body, { key: "k" });
    expect(onNavigate).toHaveBeenLastCalledWith("before");
  });
});

describe("DetailDrawer — variants", () => {
  test("action PR shows the risk eyebrow, Hermes verdict, files, and CTA", () => {
    const card = fixture("agent #548");
    const { getByText } = render(
      <DetailDrawer card={card} cards={[{ id: card.id }]} onClose={noop} onNavigate={noop} />,
    );
    expect(getByText("Operator review · risk decision")).toBeTruthy();
    expect(getByText("Hermes verdict")).toBeTruthy();
    expect(getByText("agent/contracts/AgentAccountCore.sol")).toBeTruthy();
    expect(getByText("Approve & merge")).toBeTruthy();
    expect(getByText("Send back to Codex")).toBeTruthy();
  });

  test("rich PR statuses: per-check breakdown, risk signals, and colored file diff render", () => {
    const card: BoardCard = {
      id: "agent #590",
      lane: "operator-review",
      type: "pr",
      agentType: "codex",
      title: "ops: add KMS CloudWatch alarm proof validator",
      summary: "2 changed files touch review-gated surfaces (ops).",
      repo: "averray-agent/agent",
      freshness: 6,
      state: "fresh",
      risk: [],
      isAction: true,
      waitingOn: { actor: "operator", tone: "warn" },
      verdict: "needs review",
      files: [{ path: "scripts/ops/check-kms-cloudwatch-alarm-proof.mjs", diff: "+120 -0", critical: false }],
      checks: { pass: 9, running: 0, fail: 0, pending: 0, total: 9 },
      checkRuns: [
        { name: "CI · lint", status: "pass" },
        { name: "CI · deploy plan", status: "running" },
      ],
      riskSignals: [
        { severity: "medium", code: "pr_review_risk_files", message: "2 changed file(s) touch review-gated surfaces (ops)." },
      ],
    };
    const { getByText, container } = render(
      <DetailDrawer card={card} cards={[{ id: card.id }]} onClose={noop} onNavigate={noop} />,
    );
    // per-check breakdown (names from summary.checks)
    expect(getByText("CI · lint")).toBeTruthy();
    expect(getByText("CI · deploy plan")).toBeTruthy();
    // risk-signals section
    expect(getByText("Risk signals · why Hermes flagged this")).toBeTruthy();
    expect(getByText(/2 changed file\(s\) touch review-gated/)).toBeTruthy();
    // colored "+A -D" diff
    expect(container.querySelector(".hm-files .row .diff .add")).toBeTruthy();
  });

  test("done card shows the release-history eyebrow", () => {
    const done = FIXTURE_CARDS.find((c) => c.type === "done") as BoardCard;
    const { getByText } = render(
      <DetailDrawer card={done} cards={[{ id: done.id }]} onClose={noop} onNavigate={noop} />,
    );
    expect(getByText("Closed · in release history")).toBeTruthy();
    expect(getByText(/MERGED/)).toBeTruthy();
  });

  test("deploy card shows the verification progress", () => {
    const card = fixture("deploy #246");
    const { getByText } = render(
      <DetailDrawer card={card} cards={[{ id: card.id }]} onClose={noop} onNavigate={noop} />,
    );
    expect(getByText("Deploying · post-merge verification")).toBeTruthy();
    expect(getByText(/3\/5 · indexer settle/)).toBeTruthy();
  });

  test("codex task card shows its prompt", () => {
    const card = fixture("task starter-coding-014");
    const { getByText } = render(
      <DetailDrawer card={card} cards={[{ id: card.id }]} onClose={noop} onNavigate={noop} />,
    );
    expect(getByText("Codex task · awaiting dispatch")).toBeTruthy();
    expect(getByText(/Coalesce repeated policy-attach entries/)).toBeTruthy();
  });

  test("mission card shows the full report — verdict, path, blockers, evidence, boundary, recommendations", () => {
    const card = fixture("mission browser-onboard-04");
    const { container, getByText } = render(
      <DetailDrawer card={card} cards={[{ id: card.id }]} onClose={noop} onNavigate={noop} />,
    );
    expect(getByText("Browser mission · agent report")).toBeTruthy();
    // Verdict + confidence (0.81 → 81%) + scores
    expect(getByText(/Verdict · run #4/)).toBeTruthy();
    expect(getByText("PARTIAL")).toBeTruthy();
    expect(getByText(/81/)).toBeTruthy();
    // Path steps
    expect(getByText("Path taken")).toBeTruthy();
    expect(getByText("Clicked Connect wallet")).toBeTruthy();
    // Blockers
    expect(getByText("Sign-message modal latency")).toBeTruthy();
    // Evidence
    expect(getByText("Evidence")).toBeTruthy();
    expect(getByText("step-3-modal-gap.png")).toBeTruthy();
    // Mutation boundary
    expect(getByText(/BOUNDARY · enforced/)).toBeTruthy();
    expect(getByText(/Read-only mission/)).toBeTruthy();
    // Recommendations
    expect(getByText("Hermes recommends")).toBeTruthy();
    expect(container.querySelectorAll(".hm-mpath .step").length).toBe(6);
  });

  // A live agent report (from the serializer's mission enrichment) carries the
  // qualitative detail but NOT the attempt count, latency, or 0–10 scores — so
  // the drawer must render those faithfully (omit them), never as "run #0" /
  // "0 · 0 · 0 out of 10".
  test("mission card with a partial live report renders without invented runs/latency/scores", () => {
    const card = {
      id: "mission browser-live-09",
      lane: "hermes-checking",
      type: "mission",
      agentType: "hermes",
      title: "Verify checkout on staging",
      summary: "agent report posted",
      repo: "depre-dev/site",
      freshness: 6,
      state: "fresh",
      risk: [],
      waitingOn: { actor: "agent", tone: "info" },
      mission: {
        verdict: "PARTIAL",
        verdictTone: "warn",
        confidence: 0.74,
        target: "https://staging.averray.com/checkout",
        seed: "fresh · no memory",
        path: [{ n: 1, status: "ok", desc: "Loaded checkout", lat: "" }],
        blockers: [{ head: "Slow sign modal", body: "" }],
        evidence: [],
        mutationBoundary: "Read-only mission — the agent stopped before any mutation.",
        recommendations: [],
        // no runs / latency / successScore / clarityScore / latencyScore
      },
    } as unknown as BoardCard;
    const { getByText, queryByText } = render(
      <DetailDrawer card={card} cards={[{ id: card.id }]} onClose={noop} onNavigate={noop} />,
    );
    expect(getByText("PARTIAL")).toBeTruthy();
    expect(getByText(/74/)).toBeTruthy(); // confidence %
    expect(getByText("Loaded checkout")).toBeTruthy();
    // no invented attempt count / score row
    expect(queryByText(/run #/)).toBeNull();
    expect(queryByText(/out of 10/)).toBeNull();
  });

  // Regression: live cards cross an HTTP/JSON boundary and don't always carry
  // the type-required nested objects (the backend doesn't populate deploy
  // `verification` or a mission `mission` report yet). The drawer must render,
  // not crash — this is the bug that took the live board down on card click.
  test("deploy card with NO verification (live shape) renders without crashing", () => {
    const card = {
      id: "post-production-deploy-verification-afte-3e4a",
      lane: "deploying",
      type: "deploy",
      agentType: "ext",
      title: "post-production-deploy verification after workflow run",
      summary: "post_deploy_healthy",
      repo: "averray-agent/agent",
      freshness: 180,
      state: "fresh",
      risk: [],
      waitingOn: { actor: "branch-protection", tone: "neutral" },
    } as unknown as BoardCard;
    const { getByText, queryByText } = render(
      <DetailDrawer card={card} cards={[{ id: card.id }]} onClose={noop} onNavigate={noop} />,
    );
    expect(getByText("Deploying · post-merge verification")).toBeTruthy();
    expect(getByText("post_deploy_healthy")).toBeTruthy();
    expect(queryByText("Verification progress")).toBeNull(); // omitted, not crashed
  });

  test("mission card with NO report (live shape) renders a fallback, not a crash", () => {
    const card = {
      id: "mission browser-live-01",
      lane: "hermes-checking",
      type: "mission",
      agentType: "hermes",
      title: "Verify onboarding on staging",
      summary: "Fresh agent running; no structured report yet.",
      repo: "depre-dev/site",
      freshness: 5,
      state: "fresh",
      risk: [],
      waitingOn: { actor: "agent", tone: "info" },
    } as unknown as BoardCard;
    const { getByText } = render(
      <DetailDrawer card={card} cards={[{ id: card.id }]} onClose={noop} onNavigate={noop} />,
    );
    expect(getByText("Mission · no report yet")).toBeTruthy();
    expect(getByText(/no structured report yet/i)).toBeTruthy();
  });
});
