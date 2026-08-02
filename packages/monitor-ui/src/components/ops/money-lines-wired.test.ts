import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { MONEY_LINE_RENDERERS } from "../../lib/monitor/ops-spec.js";

const board = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "OpsBoard.tsx"),
  "utf8",
);

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

  it("imports them from ops-spec rather than redefining them", () => {
    // A local reimplementation would satisfy the check above while drifting from
    // the tested one — the same two-verdict-systems problem the board forbids.
    expect(board).toContain('from "../../lib/monitor/ops-spec.js"');
  });
});
