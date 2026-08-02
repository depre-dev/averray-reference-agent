import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { MONEY_LINE_RENDERERS } from "../../lib/monitor/ops-spec.js";

const dir = path.dirname(fileURLToPath(import.meta.url));
const desktop = ["OpsBoard.tsx", "SolvencyPanel.tsx", "FlowPanel.tsx"]
  .map((f) => fs.readFileSync(path.join(dir, f), "utf8"))
  .join("\n");
const phone = fs.readFileSync(path.join(dir, "..", "mobile", "MobileBoard.tsx"), "utf8");

/**
 * Renderers that are DELIBERATELY desktop-only, each with the reason.
 *
 * Empty on purpose. Every fact currently on the board is one an operator might
 * need while away from their desk, so none has earned an exemption. Adding a
 * name here is a decision that has to be argued in the diff, which is the point
 * — the previous state was that desktop-only happened silently, by forgetting.
 */
const DESKTOP_ONLY: Record<string, string> = {};

/**
 * THE REGRESSION, twice.
 *
 * First: four renderers were written, tested, reviewed and merged while being
 * called by no component at all. The unit tests passed because they invoked the
 * functions directly — exactly what a component was not doing.
 *
 * Then, after that was fixed: three of the five were wired to the DESKTOP only.
 * The two that reached the phone were the two added after the operator pointed
 * out that design work kept skipping it. The guard at the time asserted the
 * phone for only those two — the hole was in the same place as the blind spot.
 *
 * A fact on one surface is missing precisely when the operator is not at their
 * machine, which is when a dispute countdown or a floor breach matters most. So
 * both surfaces are required by default and an exemption must be declared.
 */
describe("every money line reaches BOTH surfaces", () => {
  for (const fn of MONEY_LINE_RENDERERS) {
    it(`desktop renders ${fn}`, () => {
      expect(desktop, `${fn} is exported and tested but no desktop component calls it`).toContain(`${fn}(`);
    });

    const reason = DESKTOP_ONLY[fn];
    if (reason) {
      it(`${fn} is desktop-only on purpose — ${reason}`, () => {
        expect(phone).not.toContain(`${fn}(`);
      });
    } else {
      it(`phone renders ${fn}`, () => {
        expect(
          phone,
          `${fn} is on the desktop board and not the phone. Wire it, or add it to DESKTOP_ONLY with a reason.`,
        ).toContain(`${fn}(`);
      });
    }
  }

  it("both surfaces import from ops-spec rather than reimplementing", () => {
    // A local copy would satisfy the checks above while drifting from the tested
    // one — the two-verdict-systems problem the board forbids everywhere else.
    for (const [name, src] of [["desktop", desktop], ["phone", phone]] as const) {
      expect(src, `${name} should import the shared renderers`).toContain("lib/monitor/ops-spec.js");
    }
  });
});
