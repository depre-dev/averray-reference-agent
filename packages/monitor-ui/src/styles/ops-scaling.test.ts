// The ops board's scaling contract, guarded at the source.
//
// This board shipped with exactly two media queries, both `max-width`, and so
// rendered at identical size on a 1440 laptop and a 3840 wall — on the 4K it
// was mostly void. The fix was one custom property, `--ops-u`, that every size
// is expressed in.
//
// That kind of fix decays quietly. A new panel gets a hard-coded `font-size:
// 13px`, nothing looks wrong on the machine it was written on, and the board
// grows a patch that stays laptop-sized on the wall. Nobody notices until
// somebody stands in front of the wall.
//
// So the rules are asserted against the stylesheet text rather than against a
// rendered page: a rendering test would need a real viewport, and the failure
// this guards against is precisely one that looks fine at the viewport the
// author happened to have.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const CSS = readFileSync(fileURLToPath(new URL("./hermes4-ops.css", import.meta.url)), "utf8");

/** Declarations, minus comments — comments discuss px sizes and are not rules. */
const RULES = CSS.replace(/\/\*[\s\S]*?\*\//g, "");

/**
 * The Direction B surface layer is held to the SAME scaling contract.
 *
 * It is a second stylesheet over the same board, which is exactly how the
 * original defect returned once already: a new file gets a hard-coded 13px,
 * looks right on the laptop it was written on, and freezes on the wall. A
 * layer that skins the board must scale with it.
 */
const DIRECTION_B_FILE = readFileSync(fileURLToPath(new URL("./hermes4-direction-b.css", import.meta.url)), "utf8");
const DIRECTION_B = DIRECTION_B_FILE.replace(/\/\*[\s\S]*?\*\//g, "");

/**
 * The layer skins TWO surfaces with two different sizing systems, and the
 * split is load-bearing rather than stylistic: `--ops-u` is declared on
 * `.ops-board`, so a phone rule written in it resolves to NOTHING. The board
 * half must scale; the phone half must not reference the scaled unit at all.
 *
 * The file marks the boundary with the phone banner, so the test reads the
 * same divider a human does.
 */
const PHONE_MARKER = "THE PHONE, on the same ground";
const [BOARD_HALF, PHONE_HALF] = (() => {
  const at = DIRECTION_B_FILE.indexOf(PHONE_MARKER);
  expect(at, "the phone section's banner is the boundary this test reads").toBeGreaterThan(0);
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "");
  return [strip(DIRECTION_B_FILE.slice(0, at)), strip(DIRECTION_B_FILE.slice(at))];
})();

describe("--ops-u — the scaled pixel", () => {
  test("resolves to exactly 1px below 1920, so 1440x900 is untouched", () => {
    // The regression floor. Every `calc(N * var(--ops-u))` is N real pixels
    // there, which is what makes this a pure addition rather than a redesign.
    const decl = /--ops-u:\s*clamp\(\s*1px\s*,\s*calc\(100vw\s*\/\s*1920\)\s*,\s*([\d.]+)px\s*\)/.exec(RULES);
    expect(decl, "--ops-u must clamp from 1px at a 1920 divisor").not.toBeNull();
    // And a ceiling, so type stops before it outruns comfortable line length.
    expect(Number(decl![1])).toBeGreaterThan(1);
    expect(Number(decl![1])).toBeLessThanOrEqual(2);
  });

  test("every font-size scales, except the verdict's own curve", () => {
    // The verdict is the one element sized by viewport directly — it is meant
    // to be read across a room and follows the design's "≈ viewport / 26"
    // rather than the body scale.
    const fixed = [...RULES.matchAll(/font-size:\s*([^;]+);/g)]
      .map((m) => m[1]!.trim())
      .filter((v) => !v.includes("var(--ops-u)"))
      .filter((v) => !/^clamp\(38px,\s*4\.1vw,\s*148px\)$/.test(v))
      .filter((v) => v !== "inherit");
    expect(fixed, "a fixed font-size freezes at 4K — express it in var(--ops-u)").toEqual([]);
  });

  test("the verdict ceiling is high enough to be worth raising", () => {
    // 62px was the old ceiling and the whole defect: the board's single most
    // important element stopped growing at 1512px.
    const cap = /font-size:\s*clamp\(38px,\s*4\.1vw,\s*(\d+)px\)/.exec(RULES);
    expect(cap).not.toBeNull();
    expect(Number(cap![1])).toBeGreaterThanOrEqual(140);
  });
});

describe("the Direction B layer obeys the same contract", () => {
  test("every board font-size scales, except the KPI figure's own curve", () => {
    // The KPI value is sized by viewport like the verdict is: it is meant to
    // be read across the room, one tier below the verdict itself.
    const fixed = [...BOARD_HALF.matchAll(/font-size:\s*([^;]+);/g)]
      .map((m) => m[1]!.trim())
      .filter((v) => !v.includes("var(--ops-u)"))
      .filter((v) => !/^clamp\(24px,\s*2\.1vw,\s*calc\(36 \* var\(--ops-u\)\)\)$/.test(v))
      .filter((v) => v !== "inherit");
    expect(fixed, "a fixed font-size freezes at 4K — express it in var(--ops-u)").toEqual([]);
  });

  test("the phone half never reaches for the board's scaled unit", () => {
    // `--ops-u` is declared on `.ops-board`. A phone rule written in it does
    // not fall back — it resolves to nothing, and the size silently vanishes.
    // The phone is a fixed 390px surface and sizes in real px, exactly as
    // hermes4-mobile.css already does.
    expect(PHONE_HALF, "the phone has no --ops-u to read").not.toMatch(/--ops-u/);
  });

  test("no border in the layer is expressed in the scaled unit", () => {
    const scaledBorders = [...DIRECTION_B.matchAll(/border[a-z-]*:\s*([^;]+);/g)]
      .map((m) => m[1]!)
      .filter((v) => v.includes("--ops-u"));
    expect(scaledBorders, "borders stay at real pixels").toEqual([]);
  });

  test("it re-grounds the board without re-toning severity", () => {
    // Surface tokens are its job. Re-tuning what red MEANS is not: the verdict
    // is decided in one place and the alarm colour belongs to it.
    expect(DIRECTION_B).toMatch(/--h4-surface:/);
    expect(DIRECTION_B, "coral is the alarm — this layer must not move it").not.toMatch(/--h4-act:/);
  });
});

describe("what must NOT scale", () => {
  test("the floor tick stays 2px at every viewport", () => {
    // It marks a threshold. A threshold that gets fatter on a bigger screen
    // marks a fuzzier one, and this tick is the scale the whole meter is read
    // against.
    const block = /\.ops-meter-floor\s*\{([^}]*)\}/.exec(RULES);
    expect(block).not.toBeNull();
    expect(block![1]).toMatch(/width:\s*2px;/);
    expect(block![1]).not.toMatch(/width:[^;]*--ops-u/);
  });

  test("no border or hairline is expressed in the scaled unit", () => {
    // A hairline that thickens with the window stops reading as a rule and
    // starts reading as a border.
    const scaledBorders = [...RULES.matchAll(/border[a-z-]*:\s*([^;]+);/g)]
      .map((m) => m[1]!)
      .filter((v) => v.includes("--ops-u"));
    expect(scaledBorders, "borders stay at real pixels").toEqual([]);
  });
});
