// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import { MobileBoard } from "./MobileBoard.js";
import type { BoardCard } from "../../lib/monitor/card-types.js";
import type { ProductHealth } from "../../lib/monitor/product-health.js";

afterEach(cleanup);

const NOW = Date.parse("2026-07-29T10:00:00Z");

/** The live mainnet snapshot: probes green, pools above their floors. */
const healthyMainnet: ProductHealth = {
  enabled: true,
  at: NOW,
  status: "healthy",
  checks: 60,
  network: "mainnet",
  chainId: 420420419,
  probes: [
    { name: "product_api", status: "ok", detail: "200 · chain 420420419", sparkline: [] },
    { name: "signer_liquidity", status: "ok", detail: "gas 3.9585 DOT, reward bank 17.20 USDC", sparkline: [] },
  ],
  solvency: {
    pools: [
      { key: "signer_gas", label: "Signer gas", amount: 3.9584888, unit: "DOT", floor: 1, status: "ok" },
      { key: "reward_bank", label: "Reward bank", amount: 17.2, unit: "USDC", floor: 2, status: "ok" },
      { key: "escrow", label: "Escrow (in-flight)", amount: 0, unit: "USDC", status: "ok", informational: true },
    ],
    runwayNote: "stable — no depletion trend",
  },
};

function taskCard(over: Partial<BoardCard> = {}): BoardCard {
  return {
    id: "codex-task-1",
    lane: "codex-needed",
    type: "task",
    agentType: "codex",
    title: "Hermes routed work: ops pre-check",
    summary: "",
    repo: "depre-dev/averray-reference-agent",
    freshness: 2,
    state: "fresh",
    risk: [],
    waitingOn: { actor: "operator", tone: "warn" },
    files: [],
    ...over,
  } as BoardCard;
}

describe("MobileBoard", () => {
  test("leads with the one-glance status, then money, decisions, agents", () => {
    const { getByTestId, getByText } = render(
      <MobileBoard health={healthyMainnet} cards={[]} nowMs={NOW} />,
    );
    expect(getByTestId("mobile-board")).toBeTruthy();
    expect(getByText("All product health nominal")).toBeTruthy();
    expect(getByText("mainnet · 420420419")).toBeTruthy();
    expect(getByText("Signer gas")).toBeTruthy();
    // Amount at 2dp, floor without noise decimals ("floor 1", not "floor 1.00").
    expect(getByText(/3\.96 DOT · floor 1$/)).toBeTruthy();
    expect(getByText(/17\.20 USDC · floor 2$/)).toBeTruthy();
    expect(getByText("stable — no depletion trend")).toBeTruthy();
  });

  test("the status card reuses opsBannerData, so a runway projection reaches the phone too", () => {
    // Same source as the desktop banner (#571) — the two surfaces cannot disagree.
    const draining: ProductHealth = {
      ...healthyMainnet,
      solvency: {
        ...healthyMainnet.solvency!,
        runway: [
          {
            key: "signer_gas", label: "Signer gas", unit: "DOT",
            current: 3.9584888, floor: 1, burnPerHour: 0.229, hoursToFloor: 12.9,
            estimable: true, status: "degraded",
          },
        ],
      },
    };
    const { getByText, queryByText } = render(<MobileBoard health={draining} cards={[]} nowMs={NOW} />);
    expect(getByText("Signer gas ~13h to floor")).toBeTruthy();
    expect(queryByText("All product health nominal")).toBeNull();
  });

  test("an informational pool is context, not a floored meter", () => {
    const { queryByText } = render(<MobileBoard health={healthyMainnet} cards={[]} nowMs={NOW} />);
    expect(queryByText("Escrow (in-flight)")).toBeNull();
  });

  test("a ZERO pool draws NO bar — a full green meter on an empty pool is a fake-green", () => {
    // Shipped exactly this on "Treasury reserve · 0 USDC" (floor null → pct 100).
    const { getByText, container } = render(<MobileBoard health={healthyMainnet} cards={[]} nowMs={NOW} />);
    const reserve: ProductHealth = {
      ...healthyMainnet,
      solvency: {
        pools: [
          { key: "reserve", label: "Treasury reserve", amount: 0, unit: "USDC", status: "ok", note: "Intentionally unfunded." },
          { key: "reward_bank", label: "Reward bank", amount: 17.2, unit: "USDC", floor: 2, status: "ok" },
        ],
      },
    };
    cleanup();
    const r = render(<MobileBoard health={reserve} cards={[]} nowMs={NOW} />);
    // The zero pool still reports its number and its reason...
    expect(r.getByText("Treasury reserve")).toBeTruthy();
    expect(r.getByText("Intentionally unfunded.")).toBeTruthy();
    // ...but exactly ONE bar is drawn, for the funded pool that has a scale.
    expect(r.container.querySelectorAll(".hm-mb-bar")).toHaveLength(1);
    expect(container).toBeTruthy();
  });

  test("a pool with no floor has no scale, so it gets no meter either", () => {
    const noFloor: ProductHealth = {
      ...healthyMainnet,
      solvency: { pools: [{ key: "x", label: "Unfloored", amount: 99, unit: "USDC", status: "ok" }] },
    };
    const { container, getByText } = render(<MobileBoard health={noFloor} cards={[]} nowMs={NOW} />);
    expect(getByText(/99\.00 USDC/)).toBeTruthy(); // the number is still real
    expect(container.querySelectorAll(".hm-mb-bar")).toHaveLength(0);
  });

  test("a pool awaiting data says so — never a bar we can't justify", () => {
    const awaiting: ProductHealth = {
      ...healthyMainnet,
      solvency: { pools: [{ key: "reserve", label: "Treasury reserve", amount: null, unit: "USDC", status: "degraded" }] },
    };
    const { getByText } = render(<MobileBoard health={awaiting} cards={[]} nowMs={NOW} />);
    expect(getByText("awaiting data")).toBeTruthy();
  });

  test("non-approvable work becomes a DELIVERY COUNT, not seven demands", () => {
    const many = Array.from({ length: 7 }, (_, i) => taskCard({ id: `t${i}`, title: `Decision ${i}` }));
    const { getByText, getByTestId } = render(<MobileBoard health={healthyMainnet} cards={many} nowMs={NOW} />);
    // None are proposed, so none are actionable from a phone...
    expect(getByText("Nothing needs you right now.")).toBeTruthy();
    // ...but the count is real and tappable. Collapsed, never hidden.
    expect(getByTestId("mobile-delivery-line")).toBeTruthy();
    expect(getByText("7")).toBeTruthy();
    expect(getByText(/delivery items waiting/)).toBeTruthy();
  });

  test("an explicable PROPOSED task reaches Act now and states what it does", () => {
    const card = taskCard({
      id: "real", title: "codex task", taskStatus: "proposed",
      prompt: "Rotate the hosted smoke token",
      reason: "admin JWT expires in 3 days",
      riskTier: "low",
    } as Partial<BoardCard>);
    const { getByText } = render(<MobileBoard health={healthyMainnet} cards={[card]} nowMs={NOW} />);
    expect(getByText("Act now · 1")).toBeTruthy();
    expect(getByText("Rotate the hosted smoke token")).toBeTruthy();
    expect(getByText("admin JWT expires in 3 days")).toBeTruthy();
    expect(getByText(/low risk/)).toBeTruthy();
    expect(getByText("Approve")).toBeTruthy();
  });

  // THE SHIPPED BOARD (operator screenshot, 2026-07-29 17:42): a green Approve
  // button under a card whose only title was "codex task".
  test("a task that cannot say what it does offers NO Approve button", () => {
    const opaque = taskCard({ id: "opaque", title: "codex task", taskStatus: "proposed" } as Partial<BoardCard>);
    const { queryByText, getByText } = render(
      <MobileBoard health={healthyMainnet} cards={[opaque]} nowMs={NOW} onApproveTask={vi.fn()} />,
    );
    expect(queryByText("Approve")).toBeNull();
    expect(getByText(/review on the full board/i)).toBeTruthy();
  });

  test("routine deploy verifications never reach Act now", () => {
    const v = taskCard({
      id: "v", type: "deploy", taskStatus: undefined,
      title: "post-production-deploy verification after workflow run",
    } as Partial<BoardCard>);
    const { getByText, getByTestId } = render(<MobileBoard health={healthyMainnet} cards={[v]} nowMs={NOW} />);
    expect(getByText("Nothing needs you right now.")).toBeTruthy();
    expect(getByTestId("mobile-delivery-line")).toBeTruthy();
  });

  test("a PROPOSED task exposes Approve/Dismiss and wires them to the operator gate", () => {
    const onApproveTask = vi.fn();
    const onDismissCard = vi.fn();
    const card = taskCard({ taskStatus: "proposed", prompt: "Rotate the smoke token" } as Partial<BoardCard>);
    const { getByText } = render(
      <MobileBoard
        health={healthyMainnet}
        cards={[card]}
        nowMs={NOW}
        onApproveTask={onApproveTask}
        onDismissCard={onDismissCard}
      />,
    );
    fireEvent.click(getByText("Approve"));
    expect(onApproveTask).toHaveBeenCalledWith("codex-task-1");
    fireEvent.click(getByText("Dismiss"));
    expect(onDismissCard).toHaveBeenCalledWith(card);
  });

  test("a NON-proposed decision offers no approve button — the phone can't dispatch what isn't proposed", () => {
    const { queryByText } = render(
      <MobileBoard health={healthyMainnet} cards={[taskCard()]} nowMs={NOW} onApproveTask={vi.fn()} />,
    );
    expect(queryByText("Approve")).toBeNull();
  });

  test("tapping a decision opens it rather than acting on it", () => {
    const onCardClick = vi.fn();
    const { getByText } = render(
      <MobileBoard
        health={healthyMainnet}
        cards={[taskCard({ taskStatus: "proposed", prompt: "Rotate the smoke token" } as Partial<BoardCard>)]}
        nowMs={NOW}
        onCardClick={onCardClick}
      />,
    );
    fireEvent.click(getByText("Rotate the smoke token"));
    expect(onCardClick).toHaveBeenCalledWith("codex-task-1");
  });

  test("agents show only real workingNow — never inferred", () => {
    const idle = render(<MobileBoard health={healthyMainnet} cards={[taskCard()]} nowMs={NOW} />);
    expect(idle.getByText("No agent is running right now.")).toBeTruthy();
    cleanup();

    const busy = render(
      <MobileBoard
        health={healthyMainnet}
        nowMs={NOW}
        cards={[taskCard({ workingNow: { agent: "claude", label: "Claude fixing" } } as Partial<BoardCard>)]}
      />,
    );
    expect(busy.getByText("claude")).toBeTruthy();
    expect(busy.getByText("Claude fixing")).toBeTruthy();
  });

  test("empty states stay honest instead of blank", () => {
    const { getByText } = render(<MobileBoard health={healthyMainnet} cards={[]} nowMs={NOW} />);
    expect(getByText("Nothing needs you right now.")).toBeTruthy();
    expect(within(getByText("Nothing needs you right now.").closest("section")!).getByText(/Act now/)).toBeTruthy();
  });

  // #135: "Claude fixing" said an agent was busy but never what it was busy
  // WITH. Both lines are payload passthrough — nothing here is inferred.
  test("an agent row states what it is ATTEMPTING and its last reported step", () => {
    const card = taskCard({
      workingNow: {
        agent: "claude",
        label: "Claude fixing",
        source: "runner",
        intent: "Fix the settlement rounding drift",
        progress: "Claude is using Edit.",
        progressAt: new Date(NOW - 30_000).toISOString(),
      },
    } as Partial<BoardCard>);
    const { getByText } = render(<MobileBoard health={healthyMainnet} cards={[card]} nowMs={NOW} />);
    expect(getByText("Fix the settlement rounding drift")).toBeTruthy();
    expect(getByText(/Claude is using Edit\./)).toBeTruthy();
    expect(getByText(/just now/)).toBeTruthy();
  });

  test("a step that has gone quiet is toned down, not presented as current", () => {
    const card = taskCard({
      workingNow: {
        agent: "claude", label: "Claude fixing", source: "runner",
        progress: "Claude is using Bash.",
        progressAt: new Date(NOW - 40 * 60 * 1000).toISOString(),
      },
    } as Partial<BoardCard>);
    const { container, getByText } = render(<MobileBoard health={healthyMainnet} cards={[card]} nowMs={NOW} />);
    expect(getByText(/40m ago/)).toBeTruthy();
    expect(container.querySelector(".hm-mb-agent-step.is-stale")).toBeTruthy();
  });

  test("a runner that reported nothing says so instead of showing an empty line", () => {
    const card = taskCard({
      workingNow: { agent: "codex", label: "Codex fixing", source: "runner", intent: "Rotate the smoke token" },
    } as Partial<BoardCard>);
    const { getByText } = render(<MobileBoard health={healthyMainnet} cards={[card]} nowMs={NOW} />);
    expect(getByText("Rotate the smoke token")).toBeTruthy();
    expect(getByText("No step reported yet.")).toBeTruthy();
  });
});
