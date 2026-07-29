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

  test("decisions come from isDecision (same selector as the desktop inbox) and cap with a +N", () => {
    const many = Array.from({ length: 7 }, (_, i) => taskCard({ id: `t${i}`, title: `Decision ${i}` }));
    const { getByText } = render(<MobileBoard health={healthyMainnet} cards={many} nowMs={NOW} />);
    expect(getByText("Needs you · 7")).toBeTruthy();
    expect(getByText("Decision 0")).toBeTruthy();
    expect(getByText("+2 more on the full board.")).toBeTruthy();
  });

  test("uses the shared money-first order and shows why the first decision leads", () => {
    const routine = taskCard({
      id: "routine",
      title: "post-production-deploy verification after workflow run #40",
      isAction: true,
    });
    const unknown = taskCard({ id: "unknown", title: "Review an unclassified task" });
    const money = taskCard({
      id: "money",
      type: "pr",
      title: "Review settlement changes",
      files: [{ path: "services/settlement/submit.ts", diff: "+3 -1", critical: false }],
    });
    const { container, getByText } = render(
      <MobileBoard health={healthyMainnet} cards={[routine, unknown, money]} nowMs={NOW} />,
    );

    expect(
      [...container.querySelectorAll(".hm-mb-item-title")].map((node) => node.textContent),
    ).toEqual([
      "Review settlement changes",
      "Review an unclassified task",
      "post-production-deploy verification after workflow run #40",
    ]);
    expect(getByText("Money first · settlement path").getAttribute("data-decision-tier"))
      .toBe("money-blocking");
  });

  test("a PROPOSED task exposes Approve/Dismiss and wires them to the operator gate", () => {
    const onApproveTask = vi.fn();
    const onDismissCard = vi.fn();
    const card = taskCard({ taskStatus: "proposed" } as Partial<BoardCard>);
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
      <MobileBoard health={healthyMainnet} cards={[taskCard()]} nowMs={NOW} onCardClick={onCardClick} />,
    );
    fireEvent.click(getByText("Hermes routed work: ops pre-check"));
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
    expect(getByText("Nothing waiting on you.")).toBeTruthy();
    expect(within(getByText("Nothing waiting on you.").closest("section")!).getByText(/Needs you/)).toBeTruthy();
  });
});
