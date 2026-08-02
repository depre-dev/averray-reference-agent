import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { MONEY_LINE_RENDERERS } from "../../lib/monitor/ops-spec.js";

const dir = path.dirname(fileURLToPath(import.meta.url));
/** Every ops component, since each fact now lives beside its subject rather
 *  than in one strip — a renderer may legitimately be called from any of them. */
const board = ["OpsBoard.tsx", "SolvencyPanel.tsx", "FlowPanel.tsx"]
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

  it("imports them from ops-spec rather than redefining them", () => {
    // A local reimplementation would satisfy the check above while drifting from
    // the tested one — the same two-verdict-systems problem the board forbids.
    expect(board).toContain('from "../../lib/monitor/ops-spec.js"');
  });
});
