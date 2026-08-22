import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { MONEY_LINE_RENDERERS } from "../../lib/monitor/ops-spec.js";

const dir = path.dirname(fileURLToPath(import.meta.url));
/** Every ops component, since each fact now lives beside its subject rather
 *  than in one strip — a renderer may legitimately be called from any of them. */
const board = ["OpsBoard.tsx", "SolvencyPanel.tsx", "FlowPanel.tsx", "BankLane.tsx"]
  .map((f) => fs.readFileSync(path.join(dir, f), "utf8"))
  .join("\n");
/** The phone is a SEPARATE surface with its own components — a fact wired into
 *  the desktop and not the phone is still invisible to an operator who is away
 *  from the desk, which is when they need it most. */
const phone = fs.readFileSync(path.join(dir, "..", "mobile", "MobileBoard.tsx"), "utf8");

/**
 * THE REGRESSION, and it happened four times in one session.
 *
 * gasLine, economicsLine, payoutRunwayLine and disputeClockLine were each
 * written, unit-tested, reviewed and merged — and called by no component. The
 * tests passed because they invoked the functions directly. The board showed
 * nothing, twice, and the operator had to say "nothing new added on the board"
 * before anyone noticed.
 *
 * A view model nobody renders is dead code that looks like a feature. This makes
 * that a failing build.
 */
describe("every money line is actually rendered", () => {
  for (const fn of MONEY_LINE_RENDERERS) {
    it(`OpsBoard calls ${fn}`, () => {
      expect(board, `${fn} is exported and tested but no component calls it`).toContain(`${fn}(`);
    });
  }

  for (const fn of ["lifecycleNote", "disputeClockLine"] as const) {
    it(`the PHONE board also calls ${fn}`, () => {
      // Both are time-critical: a dispute clock and a latency figure are exactly
      // what gets checked from a phone, away from the desk.
      expect(phone, `${fn} is on the desktop board but not the phone`).toContain(`${fn}(`);
    });
  }

  /**
   * Desk-only, and each entry has to carry the argument for why.
   *
   * The default is BOTH surfaces — a fact wired into the desktop and not the
   * phone is invisible exactly when the operator is away from the desk. An
   * exemption is a decision, so it gets written down next to the name.
   */
  const DESKTOP_ONLY: Record<string, string> = {
    gasPoolNote: "gas burn is tuning information; the signer meter carries the 2am fact",
    settledByHourView:
      "24 bars is a shape you study, not a fact you act on — and 24 columns across 390px is a smear. The phone keeps the funnel counts and the proof, which are the actionable parts.",
    economicsLine:
      "unit economics is a question you sit down with. Nothing about 0.163 USDC per job changes what you would do in the next ten minutes, which is the only thing the phone is for.",
    payoutProvenanceLine:
      "which host served the read is forensics for when a number is disputed, and the dispute happens at a desk. The phone already carries the window fit, which is the part that qualifies the number.",
    crossCheckLine:
      "a weekly agreement between providers is not a 2am fact. The one case that IS — endpoints disagreeing — reaches the phone anyway, because it overrides the evidence status itself.",
  };

  for (const fn of MONEY_LINE_RENDERERS) {
    const reason = DESKTOP_ONLY[fn];
    it(reason ? `${fn} is deliberately desk-only` : `the PHONE board also calls ${fn}`, () => {
      if (reason) {
        expect(reason.length, `${fn} needs a real argument for skipping the phone`).toBeGreaterThan(30);
        expect(phone, `${fn} is listed desk-only but the phone renders it`).not.toContain(`${fn}(`);
      } else {
        expect(phone, `${fn} is on the desktop board but not the phone`).toContain(`${fn}(`);
      }
    });
  }

  it("imports them from ops-spec rather than redefining them", () => {
    // A local reimplementation would satisfy the check above while drifting from
    // the tested one — the same two-verdict-systems problem the board forbids.
    expect(board).toContain('from "../../lib/monitor/ops-spec.js"');
  });
});

/**
 * A PANEL can be built-but-unwired too, not just a view model.
 *
 * The Bank lane's own tests pass by rendering the component directly, which
 * says nothing about whether the board ever mounts it. I shipped exactly that
 * and only caught it by opening the preview — the same failure the money-line
 * guard above exists for, one level up.
 */
describe("every ops panel is mounted by the board", () => {
  for (const panel of ["SolvencyPanel", "FlowPanel", "BankLane", "PillarStrip", "AdminDemandPanel"] as const) {
    it(`OpsBoard mounts <${panel}>`, () => {
      const opsBoard = fs.readFileSync(path.join(dir, "OpsBoard.tsx"), "utf8");
      expect(opsBoard, `${panel} exists and is tested but the board never renders it`).toContain(`<${panel}`);
    });
  }

  it("the shipped SPA still imports the ops stylesheet", () => {
    const main = fs.readFileSync(path.join(dir, "..", "..", "main.tsx"), "utf8");
    expect(main).toContain('import "./styles/hermes4-ops.css"');
  });
});

/**
 * Facts that qualify a money figure must reach BOTH surfaces.
 *
 * The window fit says whether to believe the payout comparison. It is needed
 * most on the phone — that is where a SHORTFALL gets read at 2am, away from
 * any means of checking it — so a desktop-only fit is the wrong way round.
 */
describe("the qualifiers travel with the numbers they qualify", () => {
  for (const [surface, source] of [
    ["desktop", board],
    ["phone", phone],
  ] as const) {
    it(`${surface} renders the payout window fit`, () => {
      expect(source, `evidence.fit is computed but ${surface} never renders it`).toContain("evidence.fit");
    });
  }

  for (const [surface, source] of [
    ["desktop", board],
    ["phone", phone],
  ] as const) {
    it(`${surface} names which address encoding is which`, () => {
      // Two unlabelled 40-character strings, one EVM and one SS58, are not
      // interchangeable — and the phone is where they get pasted into a wallet.
      expect(source).toContain("SS58");
      expect(source, `${surface} shows an address with no EVM/SS58 key`).toContain("EVM");
    });
  }
});
