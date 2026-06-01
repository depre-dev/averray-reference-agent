import { describe, expect, it, vi } from "vitest";

import {
  buildDrawerFooter,
  githubUrlForCard,
  missionReportText,
  type DrawerActionHandlers,
} from "./drawer-footer.js";
import type { BoardCard } from "./card-types.js";

function card(over: Record<string, unknown>): BoardCard {
  return {
    id: "card-1",
    lane: "operator-review",
    type: "pr",
    agentType: "codex",
    title: "Test card",
    summary: "summary",
    repo: "averray-agent/agent",
    freshness: 5,
    state: "fresh",
    risk: [],
    waitingOn: { actor: "operator", tone: "warn" },
    files: [],
    ...over,
  } as BoardCard;
}

const missionCard = card({
  type: "mission",
  id: "testbed-mission-1",
  title: "Verify onboarding",
  mission: {
    verdict: "PARTIAL",
    verdictTone: "warn",
    confidence: 0.6,
    target: "https://app.testnet.example/onboarding",
    seed: "fresh · no memory",
    path: [],
    blockers: [{ head: "claim", body: "claim button 500s" }],
    evidence: [],
    mutationBoundary: "read-only",
    recommendations: ["Fix the claim endpoint"],
  },
});
// PR number is parsed from the id (#NNN) by relatedPrForCard.
const actionCard = card({ type: "pr", id: "agent #548", isAction: true });
const actionCardNoPr = card({ type: "pr", id: "action-no-pr", isAction: true });
const doneCard = card({ type: "done", id: "rcpt-9", closedAt: "2026-06-01", mergeStatus: "MERGED" });
const genericPr = card({ type: "pr", id: "agent #12", isAction: false });

function find(buttons: ReturnType<typeof buildDrawerFooter>, key: string) {
  return buttons.find((b) => b.key === key)!;
}

describe("githubUrlForCard / missionReportText", () => {
  it("PR url when a number is present, else the repo url", () => {
    expect(githubUrlForCard(actionCard)).toBe("https://github.com/averray-agent/agent/pull/548");
    expect(githubUrlForCard(doneCard)).toBe("https://github.com/averray-agent/agent");
  });
  it("mission report text includes target, verdict, blockers, recommendations", () => {
    const t = missionReportText(missionCard)!;
    expect(t).toMatch(/app.testnet.example\/onboarding/);
    expect(t).toMatch(/PARTIAL/);
    expect(t).toMatch(/claim button 500s/);
    expect(t).toMatch(/Fix the claim endpoint/);
    expect(missionReportText(actionCard)).toBeUndefined();
  });
});

describe("buildDrawerFooter — mission variant", () => {
  it("Fresh/Memory run call onRerunMission with the freshness; Copy report copies; Create fix proposes", () => {
    const copy = vi.fn();
    const handlers: DrawerActionHandlers = {
      onRerunMission: vi.fn(),
      onCreateProductFix: vi.fn(),
    };
    const f = buildDrawerFooter(missionCard, { handlers, copy });
    find(f, "fresh-run").run!();
    expect(handlers.onRerunMission).toHaveBeenLastCalledWith(missionCard, "fresh");
    find(f, "memory-run").run!();
    expect(handlers.onRerunMission).toHaveBeenLastCalledWith(missionCard, "memory");
    find(f, "copy-report").run!();
    expect(copy).toHaveBeenCalledWith(expect.stringContaining("Mission report"));
    find(f, "create-product-fix").run!();
    expect(handlers.onCreateProductFix).toHaveBeenCalledWith(missionCard);
  });

  it("disables rerun / create-fix (with a reason) when no handler is wired", () => {
    const f = buildDrawerFooter(missionCard, {});
    expect(find(f, "fresh-run").run).toBeUndefined();
    expect(find(f, "fresh-run").disabledReason).toMatch(/isn't available/i);
    expect(find(f, "create-product-fix").disabledReason).toMatch(/isn't available/i);
  });

  it("disables Copy report when the mission has no report", () => {
    const f = buildDrawerFooter(card({ type: "mission", id: "m2", title: "x" }), {});
    expect(find(f, "copy-report").run).toBeUndefined();
    expect(find(f, "copy-report").disabledReason).toMatch(/no mission report/i);
  });
});

describe("buildDrawerFooter — action (PR) variant", () => {
  it("Approve & merge OPENS GitHub and records approval — the board never merges", () => {
    const openUrl = vi.fn();
    const onApproveAndMerge = vi.fn();
    const f = buildDrawerFooter(actionCard, { openUrl, handlers: { onApproveAndMerge } });
    find(f, "approve-merge").run!();
    expect(openUrl).toHaveBeenCalledWith("https://github.com/averray-agent/agent/pull/548");
    expect(onApproveAndMerge).toHaveBeenCalledWith(actionCard);
  });

  it("Approve & merge disables when there's no linked PR (no silent no-op)", () => {
    const f = buildDrawerFooter(actionCardNoPr, { handlers: { onApproveAndMerge: vi.fn() } });
    expect(find(f, "approve-merge").run).toBeUndefined();
    expect(find(f, "approve-merge").disabledReason).toMatch(/no linked PR/i);
  });

  it("Send back to Codex requires a handler AND a PR number", () => {
    const onSendBackToCodex = vi.fn();
    const withPr = buildDrawerFooter(actionCard, { handlers: { onSendBackToCodex } });
    find(withPr, "send-back-codex").run!();
    expect(onSendBackToCodex).toHaveBeenCalledWith(actionCard);

    const noPr = buildDrawerFooter(actionCardNoPr, { handlers: { onSendBackToCodex } });
    expect(find(noPr, "send-back-codex").run).toBeUndefined();
    expect(find(noPr, "send-back-codex").disabledReason).toMatch(/no linked PR/i);
  });
});

describe("buildDrawerFooter — done + generic variants", () => {
  it("View on github opens, Copy receipt id copies the card id", () => {
    const openUrl = vi.fn();
    const copy = vi.fn();
    const f = buildDrawerFooter(doneCard, { openUrl, copy });
    find(f, "view-github").run!();
    expect(openUrl).toHaveBeenCalledWith("https://github.com/averray-agent/agent");
    find(f, "copy-receipt").run!();
    expect(copy).toHaveBeenCalledWith("rcpt-9");
  });

  it("generic card → Open on github (enabled when a PR url exists)", () => {
    const openUrl = vi.fn();
    const f = buildDrawerFooter(genericPr, { openUrl });
    find(f, "open-github").run!();
    expect(openUrl).toHaveBeenCalledWith("https://github.com/averray-agent/agent/pull/12");
  });
});

describe("buildDrawerFooter — Ask Hermes on every variant", () => {
  it("calls onAskHermes when wired; disables with a reason otherwise", () => {
    const onAskHermes = vi.fn();
    for (const c of [missionCard, actionCard, doneCard, genericPr]) {
      const wired = buildDrawerFooter(c, { handlers: { onAskHermes } });
      find(wired, "ask-hermes").run!();
      expect(onAskHermes).toHaveBeenLastCalledWith(c);
      const unwired = buildDrawerFooter(c, {});
      expect(find(unwired, "ask-hermes").run).toBeUndefined();
      expect(find(unwired, "ask-hermes").disabledReason).toMatch(/isn't available/i);
    }
  });
});
