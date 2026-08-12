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

const arrivalsWithHttp: ArrivalsSnapshot = {
  ...arrivals,
  funnelHttp: {
    reached: 13, browsed: 8, evaluated: 5, identified: 3, authenticated: 2, claimed: 1, submitted: 1,
  },
  funnelHttpExternal: {
    reached: 7, browsed: 4, evaluated: 2, identified: 1, authenticated: 1, claimed: 1, submitted: 1,
  },
  funnelHttpSelf: {
    reached: 2, browsed: 2, evaluated: 1, identified: 1, authenticated: 1, claimed: 0, submitted: 0,
  },
  funnelHttpAmbiguous: {
    reached: 1, browsed: 1, evaluated: 1, identified: 0, authenticated: 0, claimed: 0, submitted: 0,
  },
  attributionSourceTotals: {
    mcp: { siwe_wallet: 3, client_name: 4, ip_only: 9 },
    http: { siwe_wallet: 17, client_name: 6, ip_only: 41 },
  },
  httpCutover: {
    atMs: 1_786_200_000_000,
    at: "2026-08-09T01:20:00.000Z",
    backfilled: false,
    note: "HTTP arrivals are measured from this cut-over only; earlier HTTP traffic was not backfilled.",
  },
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

  test("a pre-cut-over snapshot renders MCP normally and makes no HTTP zero claim", () => {
    const { getByTestId, queryByTestId, queryAllByTestId } = render(<ArrivalsPanel arrivals={arrivals} />);

    expect(getByTestId("ops-arrival-stage-browsed").querySelector("strong")?.textContent).toBe("10");
    expect(queryByTestId("ops-arrivals-unreachable")).toBeNull();
    expect(queryByTestId("ops-arrivals-door-http")).toBeNull();
    expect(queryAllByTestId(/^ops-arrival-http-stage-/)).toHaveLength(0);
  });
});

describe("ArrivalsPanel — independent HTTP front door", () => {
  test("shows the measured HTTP series beside MCP without a combined headline", () => {
    const { getByTestId, queryByText } = render(<ArrivalsPanel arrivals={arrivalsWithHttp} />);

    expect(getByTestId("ops-arrivals-door-mcp")).toBeTruthy();
    expect(getByTestId("ops-arrivals-door-http")).toBeTruthy();
    expect(getByTestId("ops-arrival-stage-reached").querySelector("strong")?.textContent).toBe("20");
    expect(getByTestId("ops-arrival-http-stage-reached").querySelector("strong")?.textContent).toBe("7");
    expect(getByTestId("ops-arrival-http-self-browsed").textContent).toBe("+2");
    expect(getByTestId("ops-arrival-http-ambiguous-browsed").textContent).toBe("?1");
    expect(queryByText(/combined/i)).toBeNull();
    expect(getByTestId("ops-arrivals").textContent).not.toContain("27");
  });

  test("promotes SIWE wallet attribution rather than the inferred IP count", () => {
    const { getByTestId } = render(<ArrivalsPanel arrivals={arrivalsWithHttp} />);
    const measured = getByTestId("ops-arrivals-http-measured");

    expect(measured.textContent).toContain("MEASURED (SIWE WALLET)");
    expect(measured.querySelector("strong")?.textContent).toBe("17");
    expect(measured.textContent).not.toContain("41");
  });

  test("renders the producer's cut-over note verbatim and names recovered blindness", () => {
    const { getByTestId } = render(<ArrivalsPanel arrivals={arrivalsWithHttp} />);
    const cutover = getByTestId("ops-arrivals-http-cutover");

    expect(cutover.querySelectorAll("p")[0]?.textContent).toBe(arrivalsWithHttp.httpCutover?.note);
    expect(cutover.textContent).toContain("a larger number here is recovered blindness, not growth.");
  });

  test("keeps the existing furthest-stage reading on the MCP distinct shape", () => {
    const { getByTestId } = render(<ArrivalsPanel arrivals={arrivalsWithHttp} />);

    expect(getByTestId("ops-arrivals-furthest").textContent).toContain("authenticated");
    expect(getByTestId("ops-arrivals-furthest").textContent).not.toContain("submitted");
  });
});

// UNCLAIMABLE — traffic under a client name we use ourselves. Our own Claude
// session and a stranger's both declare `Anthropic/ClaudeAI`, so no rule over
// that name can separate them. Observed live on 2026-08-10, when the operator
// inspecting the front door through Claude was counted as outside interest.
describe("ArrivalsPanel — traffic that can be claimed by neither side", () => {
  const withAmbiguous: ArrivalsSnapshot = {
    ...arrivals,
    funnelAmbiguous: {
      reached: 0, browsed: 3, evaluated: 0, identified: 0, authenticated: 0, claimed: 0, submitted: 0,
    },
    funnel: { ...arrivals.funnel, browsed: 19 },
    distinct: { ...arrivals.distinct, ambiguous: 1, furthestAmbiguous: "browsed" },
  };

  test("is shown beside the external figure, never inside it", () => {
    const { getByTestId } = render(<ArrivalsPanel arrivals={withAmbiguous} />);

    // The headline is unmoved by traffic we cannot attribute.
    expect(getByTestId("ops-arrival-stage-browsed").querySelector("strong")?.textContent).toBe("10");
    expect(getByTestId("ops-arrival-ambiguous-browsed").textContent).toBe("?3");
    expect(getByTestId("ops-arrivals-distinct-ambiguous").textContent).toContain("UNCLAIMABLE 1");
  });

  // The defect this change closes. `unattributed` is computed by subtraction,
  // so before the third bucket was subtracted too, every unclaimable call was
  // rendered under a line stating it predated the external/self split. The
  // number was real and the explanation printed beside it was false.
  test("is not mislabelled as history that predates the split", () => {
    const { queryByTestId } = render(<ArrivalsPanel arrivals={withAmbiguous} />);

    expect(queryByTestId("ops-arrivals-unattributed")).toBeNull();
  });

  // Both kinds at once: genuinely pre-split calls still have to be named, and
  // the unclaimable ones must not be counted into that explanation.
  test("real pre-split history is still named, and counts only itself", () => {
    const { getByTestId } = render(
      <ArrivalsPanel arrivals={{ ...withAmbiguous, funnel: { ...withAmbiguous.funnel, reached: 33 } }} />,
    );

    // 33 reached − 20 external − 8 ours − 0 unclaimable = 5, and nothing more.
    expect(getByTestId("ops-arrivals-unattributed").textContent).toContain("5 calls");
    expect(getByTestId("ops-arrivals-unattributed").textContent).toContain("predate the");
  });

  test("the furthest an outsider reached is not borrowed from an unclaimable client", () => {
    const { getByTestId } = render(
      <ArrivalsPanel
        arrivals={{
          ...withAmbiguous,
          distinct: { ...withAmbiguous.distinct, furthestExternal: "reached", furthestAmbiguous: "claimed" },
        }}
      />,
    );

    expect(getByTestId("ops-arrivals-furthest").getAttribute("data-advanced")).toBe("no");
    // Reported alongside, because it may well have been an outsider.
    expect(getByTestId("ops-arrivals-furthest-ambiguous").textContent).toContain("claimed");
  });

  test("the panel explains why the external figure is narrower than it was", () => {
    const { getByTestId } = render(<ArrivalsPanel arrivals={withAmbiguous} />);

    expect(getByTestId("ops-arrivals-ambiguous-note").textContent).toContain("client name we use ourselves");
  });

  // A platform deployed before the bucket existed reports nothing here. That
  // is not a measurement of zero, so the panel makes no claim at all — and
  // renders exactly as it did before, rather than blanking on a deploy skew.
  test("a platform that does not report the bucket renders as it always did", () => {
    const { queryByTestId, getByTestId } = render(<ArrivalsPanel arrivals={arrivals} />);

    expect(queryByTestId("ops-arrival-ambiguous-browsed")).toBeNull();
    expect(queryByTestId("ops-arrivals-distinct-ambiguous")).toBeNull();
    expect(queryByTestId("ops-arrivals-furthest-ambiguous")).toBeNull();
    expect(queryByTestId("ops-arrivals-ambiguous-note")).toBeNull();
    expect(getByTestId("ops-arrival-stage-browsed").querySelector("strong")?.textContent).toBe("10");
  });

  // Reported-and-zero is a real finding: nobody arrived under a shared name.
  // It keeps the column, unlike absent, which keeps nothing.
  test("a reported zero still counts as a reading", () => {
    const zeroed = Object.fromEntries(ARRIVAL_STAGES.map((stage) => [stage, 0])) as typeof arrivals.funnel;
    const { getByTestId } = render(
      <ArrivalsPanel
        arrivals={{ ...arrivals, funnelAmbiguous: zeroed, distinct: { ...arrivals.distinct, ambiguous: 0 } }}
      />,
    );

    expect(getByTestId("ops-arrival-ambiguous-browsed").textContent).toBe("");
    expect(getByTestId("ops-arrivals-distinct-ambiguous").textContent).toContain("UNCLAIMABLE 0");
    expect(getByTestId("ops-arrivals-ambiguous-note")).toBeTruthy();
  });
});
