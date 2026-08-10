// @vitest-environment jsdom
import { afterEach, describe, expect, test } from "vitest";
import { cleanup, render } from "@testing-library/react";

import { ARRIVAL_STAGES, type ArrivalsSnapshot } from "../../lib/monitor/product-health.js";
import { ArrivalsPanel } from "./ArrivalsPanel.js";

afterEach(cleanup);

// Deliberately a funnel where the total and the external count disagree at
// every stage, including one our own probes walked to the end and no outsider
// ever entered. Any assertion below that passes on the total is a bug.
const arrivals: ArrivalsSnapshot = {
  schemaVersion: "averray.arrivals.v1",
  generatedAtMs: 1_786_100_000_000,
  observingSinceMs: 1_786_000_000_000,
  funnel: {
    reached: 28,
    browsed: 16,
    evaluated: 9,
    identified: 4,
    authenticated: 3,
    claimed: 1,
    submitted: 1,
  },
  funnelExternal: {
    reached: 20,
    browsed: 10,
    evaluated: 5,
    identified: 2,
    authenticated: 1,
    claimed: 0,
    submitted: 0,
  },
  funnelSelf: {
    reached: 8,
    browsed: 6,
    evaluated: 4,
    identified: 2,
    authenticated: 2,
    claimed: 1,
    submitted: 1,
  },
  distinct: {
    declared: 4,
    anonymous: 9,
    self: 2,
    furthest: "submitted",
    furthestExternal: "authenticated",
  },
  clients: [],
};

describe("ArrivalsPanel", () => {
  // The headline is what an outsider did. Our own probes reach the same door
  // and were once added to these bars, which is how this panel came to say
  // BROWSED 2 on a day exactly one outsider had browsed.
  test("every funnel figure is the external count, never the total", () => {
    const { getByTestId, queryByTestId } = render(<ArrivalsPanel arrivals={arrivals} />);
    const rows = ARRIVAL_STAGES.map((stage) => getByTestId(`ops-arrival-stage-${stage}`));

    // Every call here is attributed, so there is nothing to disclaim.
    expect(queryByTestId("ops-arrivals-unattributed")).toBeNull();

    expect(rows.map((row) => row.querySelector(".ops-arrivals-stage")?.textContent)).toEqual(ARRIVAL_STAGES);
    expect(rows.map((row) => row.querySelector("strong")?.textContent)).toEqual(
      ["20", "10", "5", "2", "1", "0", "0"],
    );
    // Bars scale on the external peak of 20, not the total peak of 28, so one
    // busy canary cannot flatten a real outsider's bar.
    expect(rows.map((row) => (row.querySelector("i") as HTMLElement).style.width)).toEqual([
      "100%",
      "50%",
      "25%",
      "10%",
      "5%",
      "0%",
      "0%",
    ]);
  });

  // Kept visible, not dropped: a probe that silently stopped running is its
  // own kind of blindness. It is simply never part of the headline.
  test("our own traffic is shown apart from the external figure", () => {
    const { getByTestId } = render(<ArrivalsPanel arrivals={arrivals} />);

    expect(ARRIVAL_STAGES.map((stage) => getByTestId(`ops-arrival-self-${stage}`).textContent)).toEqual(
      ["+8", "+6", "+4", "+2", "+2", "+1", "+1"],
    );
    // A stage no outsider entered reads 0, with our own run still legible.
    expect(getByTestId("ops-arrival-stage-submitted").textContent).toContain("0");
    expect(getByTestId("ops-arrival-self-submitted").textContent).toBe("+1");
  });

  test("shows declared, anonymous and ours, and the furthest an OUTSIDER reached", () => {
    const { getByTestId, getByLabelText } = render(<ArrivalsPanel arrivals={arrivals} />);

    expect(getByLabelText("Distinct arrival clients").textContent).toContain("DECLARED 4");
    expect(getByLabelText("Distinct arrival clients").textContent).toContain("ANONYMOUS 9");
    expect(getByLabelText("Distinct arrival clients").textContent).toContain("OURS 2");
    // Our own probes submitted. The headline must not borrow their progress.
    expect(getByTestId("ops-arrivals-furthest").textContent).toContain("authenticated");
    expect(getByTestId("ops-arrivals-furthest").textContent).not.toContain("submitted");
    expect(getByTestId("ops-arrivals-furthest").getAttribute("data-advanced")).toBe("yes");
  });

  // The board went green on our own traffic before the split existed. With no
  // outsider past the door, nothing here may look like progress.
  test("a funnel only our own probes walked reads as no outside interest", () => {
    const { getByTestId } = render(
      <ArrivalsPanel
        arrivals={{
          ...arrivals,
          funnel: {
            reached: 9, browsed: 6, evaluated: 4, identified: 2, authenticated: 2, claimed: 1, submitted: 1,
          },
          funnelExternal: {
            reached: 1, browsed: 0, evaluated: 0, identified: 0, authenticated: 0, claimed: 0, submitted: 0,
          },
          distinct: { declared: 2, anonymous: 0, self: 1, furthest: "submitted", furthestExternal: "reached" },
        }}
      />,
    );

    expect(getByTestId("ops-arrival-stage-browsed").querySelector("strong")?.textContent).toBe("0");
    expect(getByTestId("ops-arrivals-furthest").textContent).toContain("reached");
    expect(getByTestId("ops-arrivals-furthest").getAttribute("data-advanced")).toBe("no");
  });

  // What the platform serves for a while after the split ships: the totals
  // survived the upgrade, their actor attribution did not, and the client
  // table still remembers that an outsider browsed. Unexplained, the panel
  // would show BROWSED 0 directly beside "furthest an outsider reached:
  // browsed" and leave an operator to guess which one is lying.
  test("pre-split history is named, not folded into either column", () => {
    const zeroed = Object.fromEntries(ARRIVAL_STAGES.map((stage) => [stage, 0])) as typeof arrivals.funnel;
    const { getByTestId } = render(
      <ArrivalsPanel
        arrivals={{
          ...arrivals,
          funnel: { ...zeroed, reached: 22, browsed: 2 },
          funnelExternal: zeroed,
          funnelSelf: zeroed,
          distinct: { declared: 2, anonymous: 1, self: 1, furthest: "browsed", furthestExternal: "browsed" },
        }}
      />,
    );

    expect(getByTestId("ops-arrivals-unattributed").textContent).toContain("24 calls");
    expect(getByTestId("ops-arrivals-unattributed").textContent).toContain("predate the");
    expect(getByTestId("ops-arrival-stage-browsed").querySelector("strong")?.textContent).toBe("0");
    expect(getByTestId("ops-arrivals-furthest").textContent).toContain("browsed");
  });

  test("an unreadable feed says unreachable and renders no zero funnel", () => {
    const { getByTestId, queryAllByTestId } = render(
      <ArrivalsPanel arrivals={{ unavailable: "arrivals feed unreachable — platform returned HTTP 521" }} />,
    );

    expect(getByTestId("ops-arrivals-unreachable").textContent).toContain("UNREACHABLE");
    expect(getByTestId("ops-arrivals-unreachable").textContent).toContain("HTTP 521");
    expect(queryAllByTestId(/^ops-arrival-stage-/)).toHaveLength(0);
  });

  test("an older product-health payload is also a named non-reading", () => {
    const { getByTestId } = render(<ArrivalsPanel arrivals={undefined} />);
    expect(getByTestId("ops-arrivals-unreachable").textContent).toContain("feed not present");
  });
});
