// The board must never hide a fact it was given.
//
// On 2026-08-04 the live board rendered a panel headed PAYOUT EVIDENCE —
// INDEPENDENT ON-CHAIN PROOF containing no evidence at all, under a verdict
// reading "money is moving and proven on-chain". Three solvency rows (treasury
// reserve, escrow, protocol revenue) never rendered either. Nothing was broken
// upstream: the proof was fetched, derived, unit-tested and then thrown away by
// a `height: 100dvh; overflow: hidden` canvas one layer before an eye.
//
// MEASURED on the live board at 1512x923, which is the machine it is read on:
//
//   natural content  ~1089px        available  835px
//   .ops-solvency    needs 503px    had 250px
//   .ops-flow        needs 398px    had 250px
//
// `.ops-money` was the only `flex: 1` child, so it absorbed the entire
// shortfall while its fixed siblings took what they liked.
//
// WHY THESE ARE TEXT ASSERTIONS AND NOT RENDER ASSERTIONS: jsdom does no
// layout — every height it reports is 0 — so a rendering test in this suite
// cannot see clipping at all. It would have passed happily throughout the
// outage. The stylesheet is the artefact that decides, so the stylesheet is
// what gets read. Confirmed against the real board in a browser before landing;
// that check is CHECK-worthy but not automatable here, so it is written down
// rather than pretended at.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const CSS = readFileSync(fileURLToPath(new URL("./hermes4-ops.css", import.meta.url)), "utf8");
const RULES = CSS.replace(/\/\*[\s\S]*?\*\//g, "");

const HTML_ENTRIES = ["../../index.html", "../../ops-preview.html"] as const;

/** The body of a rule, by selector, comments already stripped. */
function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`(?:^|[},])\\s*${escaped}\\s*\\{([^}]*)\\}`, "m").exec(RULES);
  expect(m, `expected a \`${selector}\` rule in hermes4-ops.css`).not.toBeNull();
  return m![1]!;
}

describe("the shell grows and scrolls; it does not clip", () => {
  test(".hm-shell is min-height, never a fixed height", () => {
    // `height: 100dvh` is the whole bug: content taller than the window has
    // nowhere to go, and `overflow: hidden` then deletes it silently.
    const body = ruleBody(".hm-shell");
    expect(body).toMatch(/min-height:\s*100dvh/);
    expect(body, "a fixed height re-introduces the clip").not.toMatch(/(^|[;\s])height:\s*100dvh/);
  });

  test(".hm-shell never hides its overflow", () => {
    const body = ruleBody(".hm-shell");
    expect(body).not.toMatch(/overflow(-y)?:\s*hidden/);
  });

  test("the host chain is min-height in BOTH html entries", () => {
    // The inline <style> in index.html outranks every stylesheet, so fixing
    // hermes4-ops.css alone changed nothing at all — the document stayed pinned
    // to the viewport and the footer sat at y=1206 on a 923px screen,
    // unreachable. The preview must match production or it lies about layout.
    for (const rel of HTML_ENTRIES) {
      const html = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
      const style = /<style>([\s\S]*?)<\/style>/.exec(html)?.[1] ?? "";
      expect(style, `${rel}: host chain must be min-height`).toMatch(/#root\s*\{\s*min-height:\s*100%/);
      expect(style, `${rel}: a fixed height pins the document to the viewport`)
        .not.toMatch(/#root\s*\{\s*height:\s*100%/);
    }
  });
});

describe("the money band asks for its content before it gives anything up", () => {
  test(".ops-money does not shrink below its content", () => {
    // flex-shrink 0 is the load-bearing digit. With the default 1 this band is
    // the only flexible child and therefore eats the entire shortfall — 250px
    // of space for 503px of solvency rows.
    const body = ruleBody(".ops-money");
    const flex = /(?:^|[;\s])flex:\s*([^;]+)/.exec(body)?.[1]?.trim();
    expect(flex, ".ops-money needs an explicit flex").toBeTruthy();
    const [grow, shrink, basis] = flex!.split(/\s+/);
    expect(grow, "must still grow to fill a wall display").toBe("1");
    expect(shrink, "must NOT shrink below its content").toBe("0");
    expect(basis, "basis auto = ask for the content height").toBe("auto");
  });

  test("neither money panel hides its own overflow", () => {
    // Belt and braces: even correctly sized, an `overflow: hidden` here would
    // clip the moment a row is added.
    for (const sel of [".ops-solvency", ".ops-flow"]) {
      expect(ruleBody(sel), `${sel} must not clip`).not.toMatch(/overflow(-y)?:\s*hidden/);
    }
  });
});
