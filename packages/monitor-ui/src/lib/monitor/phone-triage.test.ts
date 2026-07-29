import { describe, expect, test } from "vitest";

import type { BoardCard } from "./card-types.js";
import type { ProductHealth } from "./product-health.js";
import { approvalBasisFor, triageForPhone } from "./phone-triage.js";

function decision(over: Record<string, unknown> = {}): BoardCard {
  return {
    id: "t1",
    lane: "codex-needed",
    type: "task",
    agentType: "codex",
    title: "codex task",
    summary: "",
    repo: "depre-dev/averray-reference-agent",
    freshness: 5,
    state: "fresh",
    risk: [],
    waitingOn: { actor: "operator", tone: "warn" },
    taskStatus: "proposed",
    ...over,
  } as BoardCard;
}

const healthy: ProductHealth = {
  enabled: true, at: 1, status: "healthy", checks: 7, network: "mainnet", chainId: 420420419,
  probes: [{ name: "money_path", status: "ok", detail: "", sparkline: [] }],
};

describe("approvalBasisFor", () => {
  // THE SHIPPED CARD: title "codex task", no prompt. It offered a green Approve
  // button and the operator had no way to know what they were approving.
  test("a card that only names its KIND cannot justify an approval", () => {
    expect(approvalBasisFor(decision({ title: "codex task" }))).toBeUndefined();
    expect(approvalBasisFor(decision({ title: "task" }))).toBeUndefined();
    expect(approvalBasisFor(decision({ title: "   " }))).toBeUndefined();
  });

  test("the prompt carries the basis when the title is generic", () => {
    const basis = approvalBasisFor(decision({ title: "codex task", prompt: "Rotate the hosted smoke token\nthen re-run the canary." }));
    expect(basis?.what).toBe("Rotate the hosted smoke token");
  });

  test("a specific title is basis enough on its own", () => {
    expect(approvalBasisFor(decision({ title: "Fix settlement rounding drift", prompt: "" }))?.what)
      .toBe("Fix settlement rounding drift");
  });

  test("why + risk ride along when the card carries them", () => {
    const basis = approvalBasisFor(decision({
      prompt: "Re-run the payout probe",
      reason: "money_path degraded for 20m",
      riskTier: "high",
    }));
    expect(basis).toEqual({ what: "Re-run the payout probe", why: "money_path degraded for 20m", risk: "high" });
  });

  test("falls back to the decision record when there is no plain reason", () => {
    const basis = approvalBasisFor(decision({
      prompt: "Top up the reward bank",
      decisionRecord: { reasons: ["reward bank 1.2 USDC below floor 2"], outcome: { summary: "queued" } },
    }));
    expect(basis?.why).toBe("reward bank 1.2 USDC below floor 2");
  });

  test("a long basis is clipped with an ellipsis, never silently truncated", () => {
    const basis = approvalBasisFor(decision({ prompt: "x".repeat(200) }));
    expect(basis!.what.endsWith("…")).toBe(true);
    expect(basis!.what.length).toBeLessThanOrEqual(120);
  });
});

describe("triageForPhone", () => {
  test("REGRESSION: the shipped board — unexplained task on top, two routine verifications", () => {
    const opaque = decision({ id: "opaque", title: "codex task" });
    const v1 = decision({ id: "v1", type: "deploy", title: "post-production-deploy verification after workflow run", taskStatus: undefined });
    const v2 = decision({ id: "v2", type: "deploy", title: "post-production-deploy verification after workflow dispatch", taskStatus: undefined });

    const { actNow, delivery } = triageForPhone([opaque, v1, v2], healthy);
    // Nothing on the phone demands a decision it cannot explain...
    expect(actNow).toEqual([]);
    // ...but all three are still accounted for.
    expect(delivery.map((c) => c.id).sort()).toEqual(["opaque", "v1", "v2"]);
  });

  test("an explicable proposed task DOES earn the phone", () => {
    const good = decision({ id: "good", prompt: "Rotate the hosted smoke token" });
    const { actNow, delivery } = triageForPhone([good], healthy);
    expect(actNow.map((c) => c.id)).toEqual(["good"]);
    expect(delivery).toEqual([]);
  });

  test("money-blocking work reaches the phone even when it is not approvable", () => {
    const money = decision({
      id: "money", type: "pr", taskStatus: undefined, title: "PR",
      files: [{ path: "services/settlement/submit.ts" }],
    });
    const { actNow } = triageForPhone([money], healthy);
    expect(actNow.map((c) => c.id)).toEqual(["money"]);
  });

  test("money-blocking outranks an explicable task inside ACT NOW", () => {
    const task = decision({ id: "task", prompt: "Rotate the smoke token" });
    const money = decision({
      id: "money", type: "pr", taskStatus: undefined, title: "PR",
      files: [{ path: "contracts/EscrowCore.sol" }],
    });
    expect(triageForPhone([task, money], healthy).actNow.map((c) => c.id)).toEqual(["money", "task"]);
  });

  test("routine verification never reaches ACT NOW, even if it looks approvable", () => {
    const routine = decision({ id: "r", title: "post-deploy verification", prompt: "verify the deploy" });
    const { actNow, delivery } = triageForPhone([routine], healthy);
    expect(actNow).toEqual([]);
    expect(delivery.map((c) => c.id)).toEqual(["r"]);
  });

  test("TRUTH BOUNDARY: nothing is ever dropped — the split is exhaustive", () => {
    const cards = [
      decision({ id: "a", title: "codex task" }),
      decision({ id: "b", prompt: "Do a real thing" }),
      decision({ id: "c", type: "deploy", title: "post-deploy verification", taskStatus: undefined }),
      decision({ id: "d", type: "pr", taskStatus: undefined, title: "PR", files: [{ path: "src/treasury.ts" }] }),
    ];
    const { actNow, delivery } = triageForPhone(cards, healthy);
    expect(actNow.length + delivery.length).toBe(cards.length);
    expect([...actNow, ...delivery].map((c) => c.id).sort()).toEqual(["a", "b", "c", "d"]);
  });

  test("no health payload still triages rather than throwing", () => {
    const { actNow, delivery } = triageForPhone([decision({ id: "x", prompt: "Real work" })]);
    expect(actNow.length + delivery.length).toBe(1);
  });
});
