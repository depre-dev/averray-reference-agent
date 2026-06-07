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
    const { getByRole, getByText } = render(
      <DetailDrawer card={card} cards={[{ id: card.id }]} onClose={noop} onNavigate={noop} />,
    );
    expect(getByText("Operator review · risk decision")).toBeTruthy();
    expect(getByText("Hermes verdict")).toBeTruthy();
    expect(getByText("agent/contracts/AgentAccountCore.sol")).toBeTruthy();
    const author = getByText("author").parentElement;
    expect(author?.textContent).toContain("codex");
    expect(getByRole("link", { name: /open on github/i }).getAttribute("href")).toBe(
      "https://github.com/depre-dev/agent/pull/548",
    );
    const approve = getByRole("button", { name: /Approve & merge\s*A/i });
    const sendBack = getByRole("button", { name: /Send back to Codex\s*B/i });
    expect(within(approve).getByText("A")).toBeTruthy();
    expect(within(sendBack).getByText("B")).toBeTruthy();
  });

  test("shows the scoped Hermes/agent discussion in the drawer when present", () => {
    const card: BoardCard = {
      ...fixture("agent #548"),
      discussion: [
        {
          id: "hermes-1",
          ts: Date.parse("2026-06-01T10:01:00.000Z"),
          author: "hermes",
          kind: "status",
          text: "Contract test X is red.",
          addressedTo: "codex",
          hermesMode: "live",
        },
        {
          id: "codex-1",
          ts: Date.parse("2026-06-01T10:02:00.000Z"),
          author: "codex",
          kind: "chat",
          text: "Fixing via Y.",
          addressedTo: "hermes",
        },
      ],
    };

    const { getByRole } = render(
      <DetailDrawer card={card} cards={[{ id: card.id }]} onClose={noop} onNavigate={noop} />,
    );
    const discussion = within(getByRole("dialog")).getByRole("region", { name: "Agent discussion" });
    expect(within(discussion).getByText("Hermes (live)")).toBeTruthy();
    expect(within(discussion).getByText("Contract test X is red.")).toBeTruthy();
    expect(within(discussion).getByText("Codex")).toBeTruthy();
    expect(within(discussion).getByText("Fixing via Y.")).toBeTruthy();
  });

  test("cards without discussion do not render an empty thread in the drawer", () => {
    const card = fixture("agent #548");
    const { queryByRole } = render(
      <DetailDrawer card={card} cards={[{ id: card.id }]} onClose={noop} onNavigate={noop} />,
    );
    expect(queryByRole("region", { name: "Agent discussion" })).toBeNull();
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
    expect(getByText("Current deploy: verifying")).toBeTruthy();
    expect(getByText("CI queued")).toBeTruthy();
    expect(getByText("browser replay")).toBeTruthy();
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
    // Static mission contract reference
    expect(getByText("Spec · /mission spawn flow")).toBeTruthy();
    expect(getByText(/A mission is a first-class work item/)).toBeTruthy();
    expect(getByText("POST /missions")).toBeTruthy();
    expect(getByText("GET /missions/:id")).toBeTruthy();
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
    // a thin report without goal/narrative shows NEITHER section (no padding)
    expect(queryByText("Scope")).toBeNull();
    expect(queryByText("What the agent did")).toBeNull();
  });

  test("mission drawer surfaces scope (goal) + the agent narrative + scored per-step detail", () => {
    const card = {
      id: "mission gold-path-12",
      lane: "hermes-checking",
      type: "mission",
      agentType: "hermes",
      title: "Gold path on app.averray.com",
      summary: "agent report posted",
      repo: "depre-dev/site",
      freshness: 4,
      state: "fresh",
      risk: [],
      waitingOn: { actor: "agent", tone: "info" },
      mission: {
        verdict: "OK",
        verdictTone: "ok",
        confidence: 0.9,
        target: "https://app.averray.com/overview",
        goal: "Complete the claim → submit → verify gold path as a fresh agent.",
        narrative: "Opened a clean browser context.\nSigned in through the local signer sidecar.\nClaimed task and submitted the receipt.",
        seed: "fresh · no memory",
        path: [
          { n: 1, status: "ok", desc: "Loaded overview", lat: "1.2s" },
          { n: 2, status: "ok", desc: "Claimed task" },
        ],
        blockers: [],
        evidence: [],
        mutationBoundary: "Read-only mission — the agent stopped before any mutation.",
        recommendations: ["Add a confirmation toast after submit"],
        successScore: 9,
        clarityScore: 8,
        latencyScore: 7,
      },
    } as unknown as BoardCard;
    const { getByText } = render(
      <DetailDrawer card={card} cards={[{ id: card.id }]} onClose={noop} onNavigate={noop} />,
    );
    // Scope (goal) leads.
    expect(getByText("Scope")).toBeTruthy();
    expect(getByText(/Complete the claim → submit → verify/)).toBeTruthy();
    // The agent narrative renders as its own readable section, one line per step.
    expect(getByText("What the agent did")).toBeTruthy();
    expect(getByText("Signed in through the local signer sidecar.")).toBeTruthy();
    // Scores render for a scored run.
    expect(getByText(/out of 10/)).toBeTruthy();
    // Per-step detail + latency, not just "PASS".
    expect(getByText("Loaded overview")).toBeTruthy();
    expect(getByText("1.2s")).toBeTruthy();
    expect(getByText("Add a confirmation toast after submit")).toBeTruthy();
  });

  test("mission drawer shows the derived conclusion + a labeled score list (suppressing the legacy 3-col)", () => {
    const card = {
      id: "mission scored-22",
      lane: "hermes-checking",
      type: "mission",
      agentType: "hermes",
      title: "Onboarding sweep",
      summary: "agent report posted",
      repo: "depre-dev/site",
      freshness: 5,
      state: "fresh",
      risk: [],
      waitingOn: { actor: "agent", tone: "info" },
      mission: {
        verdict: "PARTIAL",
        verdictTone: "warn",
        confidence: 0.8,
        target: "https://staging.averray.com/onboarding",
        conclusion: "PARTIAL — Sign-message modal latency slowed the claim path.",
        seed: "fresh · no memory",
        path: [{ n: 1, status: "ok", desc: "Loaded onboarding" }],
        blockers: [],
        evidence: [],
        mutationBoundary: "Read-only mission — the agent stopped before any mutation.",
        recommendations: [],
        scores: [
          { label: "Success", value: 8 },
          { label: "Clarity", value: 6 },
        ],
        // legacy fixed scores also present — must NOT render once the list is shown
        successScore: 8,
        clarityScore: 6,
      },
    } as unknown as BoardCard;
    const { getByText, queryByText } = render(
      <DetailDrawer card={card} cards={[{ id: card.id }]} onClose={noop} onNavigate={noop} />,
    );
    expect(getByText("Conclusion")).toBeTruthy();
    expect(getByText("PARTIAL — Sign-message modal latency slowed the claim path.")).toBeTruthy();
    // Labeled score list renders…
    expect(getByText("Success")).toBeTruthy();
    expect(getByText("8/10")).toBeTruthy();
    // …and the fixed "success · clarity · latency" column is suppressed (no double-show).
    expect(queryByText(/success · clarity · latency/i)).toBeNull();
  });

  function runningMission(progress?: Record<string, unknown>) {
    return {
      id: "mission run-9",
      lane: "hermes-checking",
      type: "mission",
      agentType: "hermes",
      title: "Verify checkout on staging",
      summary: "running",
      repo: "depre-dev/site",
      freshness: 1,
      state: "running",
      risk: [],
      waitingOn: { actor: "agent", tone: "info" },
      missionStatus: "running",
      ...(progress ? { missionProgress: progress } : {})
    } as unknown as BoardCard;
  }

  test("a RUNNING mission shows live stage + recent output with honest copy, no verdict", () => {
    const card = runningMission({
      message: "Clicking safe visible control: Connect wallet",
      output: "opened https://staging.averray.com/checkout\nclicked Connect wallet\n"
    });
    const { getByText, queryByText } = render(
      <DetailDrawer card={card} cards={[{ id: card.id }]} onClose={noop} onNavigate={noop} />
    );
    expect(getByText("Mission · running")).toBeTruthy();
    expect(getByText("Clicking safe visible control: Connect wallet")).toBeTruthy();
    expect(getByText("Recent runner output")).toBeTruthy();
    expect(getByText(/clicked Connect wallet/)).toBeTruthy();
    // Honest copy: rolling tail + ~2s refresh + no verdict promise.
    expect(getByText(/Rolling ~12KB tail/)).toBeTruthy();
    expect(getByText(/Refreshes ~every 2s/)).toBeTruthy();
    // No verdict / scores while running.
    expect(queryByText("PARTIAL")).toBeNull();
    expect(queryByText(/out of 10/)).toBeNull();
  });

  test("a running mission with no output yet stays honest (no fabricated steps)", () => {
    const { getByText } = render(
      <DetailDrawer card={runningMission({ message: "Runner claimed the mission." })} cards={[]} onClose={noop} onNavigate={noop} />
    );
    expect(getByText(/No output yet/)).toBeTruthy();
  });

  test("the SAME drawer auto-swaps from the live view to the full report on completion", () => {
    const running = runningMission({ message: "step 1", output: "line\n" });
    const { getByText, queryByText, rerender } = render(
      <DetailDrawer card={running} cards={[{ id: running.id }]} onClose={noop} onNavigate={noop} />
    );
    expect(getByText("Mission · running")).toBeTruthy();

    // The board.card.updated SSE replaces the card with the completed report.
    const done = {
      ...running,
      state: "fresh",
      missionStatus: "completed",
      missionProgress: undefined,
      mission: {
        verdict: "OK",
        verdictTone: "ok",
        confidence: 0.9,
        target: "https://staging.averray.com/checkout",
        seed: "fresh · no memory",
        path: [{ n: 1, status: "ok", desc: "Loaded checkout" }],
        blockers: [],
        evidence: [],
        mutationBoundary: "Read-only mission — the agent stopped before any mutation.",
        recommendations: []
      }
    } as unknown as BoardCard;
    rerender(<DetailDrawer card={done} cards={[{ id: done.id }]} onClose={noop} onNavigate={noop} />);

    expect(queryByText("Mission · running")).toBeNull();
    expect(getByText("OK")).toBeTruthy();
    expect(getByText("Loaded checkout")).toBeTruthy();
  });

  // Regression: live cards cross an HTTP/JSON boundary and don't always carry
  // deploy `verification` or a mission `mission` report. The drawer must
  // render, not crash, and deploy steps must stay honest pending data.
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
    expect(getByText("Current deploy: verifying")).toBeTruthy();
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
    expect(getByText("Spec · /mission spawn flow")).toBeTruthy();
  });

  test("completed mission with NO report renders honest report-unavailable coaching", () => {
    const card = {
      id: "mission browser-completed-no-report",
      lane: "done",
      type: "mission",
      missionStatus: "completed",
      agentType: "hermes",
      title: "Fresh-agent browser mission",
      summary: "Run finished without a structured report — see recent output.",
      repo: "testbed/mission",
      freshness: 15,
      state: "fresh",
      risk: ["testbed"],
      waitingOn: { actor: "agent", tone: "neutral" },
    } as unknown as BoardCard;
    const { getByText, queryByText } = render(
      <DetailDrawer card={card} cards={[{ id: card.id }]} onClose={noop} onNavigate={noop} />,
    );
    expect(getByText("Mission · report unavailable")).toBeTruthy();
    expect(getByText(/run finished without a structured report/i)).toBeTruthy();
    expect(queryByText("Mission · no report yet")).toBeNull();
    expect(queryByText("FAILED")).toBeNull();
  });
});

describe("DetailDrawer — footer actions (G2)", () => {
  test("truth-boundary: an action lacking a backend renders DISABLED with a tooltip reason", () => {
    const card = fixture("agent #548"); // action PR card
    const { getByText } = render(
      <DetailDrawer card={card} cards={[{ id: card.id }]} onClose={noop} onNavigate={noop} />,
    );
    // No `actions` wired → Send back to Codex + Ask Hermes are disabled with a reason.
    const sendBack = getByText("Send back to Codex").closest("button") as HTMLButtonElement;
    expect(sendBack.disabled).toBe(true);
    expect(sendBack.getAttribute("title")).toMatch(/isn't available/i);
    const ask = getByText("Ask Hermes").closest("button") as HTMLButtonElement;
    expect(ask.disabled).toBe(true);
    expect(ask.getAttribute("title")).toMatch(/isn't available/i);
  });

  test("Approve & merge opens the GitHub PR and records approval — never merges in-board", () => {
    const card = fixture("agent #548");
    const openUrl = vi.fn();
    const onApproveAndMerge = vi.fn();
    const { getByText } = render(
      <DetailDrawer
        card={card}
        cards={[{ id: card.id }]}
        onClose={noop}
        onNavigate={noop}
        actions={{ onApproveAndMerge }}
        footerDeps={{ openUrl }}
      />,
    );
    const btn = getByText("Approve & merge").closest("button") as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    fireEvent.click(btn);
    expect(openUrl).toHaveBeenCalledWith("https://github.com/depre-dev/agent/pull/548");
    expect(onApproveAndMerge).toHaveBeenCalledWith(card);
  });
});

describe("DetailDrawer — failed mission blocker (raw reachable, cleaned by default)", () => {
  test("shows a cleaned blocker head and keeps the raw runner output one click deep", () => {
    const card = fixture("mission browser-claim-09"); // failed mission, raw dump in blocker
    const { container, getByText } = render(
      <DetailDrawer card={card} cards={[{ id: card.id }]} onClose={noop} onNavigate={noop} />,
    );
    const blocker = container.querySelector(".hm-mblock");
    expect(blocker).toBeTruthy();
    // The head is shown CLEANED — no box-drawing / pipes in the visible head.
    const head = blocker?.querySelector(".head");
    expect(head?.textContent ?? "").not.toMatch(/[─-▟]/);
    expect(head?.textContent ?? "").not.toContain("|");
    // The raw runner output is preserved, reachable under a disclosure.
    const raw = blocker?.querySelector("details.hm-mblock-raw");
    expect(raw).toBeTruthy();
    expect(getByText("Show raw runner output")).toBeTruthy();
    // The raw <pre> still contains the real, unredacted failure text.
    const pre = raw?.querySelector("pre");
    expect(pre?.textContent ?? "").toContain("ms-playwright");
    expect(pre?.textContent ?? "").toContain("ffmpeg");
  });
});
