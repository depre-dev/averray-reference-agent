// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";

import {
  ARRIVAL_STAGES,
  type ArrivalOperatorDoorRow,
  type ArrivalsSnapshot,
} from "../../lib/monitor/product-health.js";
import { ArrivalsPanel } from "./ArrivalsPanel.js";

afterEach(cleanup);

const GENERATED_AT = Date.parse("2026-08-16T12:00:00.000Z");
const HISTORICAL_AT = Date.parse("2026-08-11T08:00:00.000Z");
const CUTOVER_NOTE = "HTTP arrivals are measured from this cut-over only; earlier HTTP traffic was not backfilled.";

function rows(values: Partial<Record<string, Partial<Record<"outsider" | "ours" | "unknown", number>>>> = {}) {
  return ARRIVAL_STAGES.map((stage, index): ArrivalOperatorDoorRow => ({
    stage,
    unit: index < 3 ? "calls" : "agents",
    instrumentation: index < 3
      ? `${stage} route/tool calls`
      : "distinct SIWE wallets reaching at least this stage",
    outsider: values[stage]?.outsider ?? 0,
    ours: values[stage]?.ours ?? 0,
    unknown: values[stage]?.unknown ?? 0,
  }));
}

function snapshot(overrides: Partial<ArrivalsSnapshot> = {}): ArrivalsSnapshot {
  const zeroes = Object.fromEntries(ARRIVAL_STAGES.map((stage) => [stage, 0])) as Record<(typeof ARRIVAL_STAGES)[number], number>;
  return {
    schemaVersion: "averray.arrivals.v1",
    generatedAtMs: GENERATED_AT,
    observingSinceMs: Date.parse("2026-08-08T00:00:00.000Z"),
    funnel: zeroes,
    funnelExternal: zeroes,
    funnelSelf: zeroes,
    distinct: { declared: 0, anonymous: 0, self: 0, furthest: "reached", furthestExternal: "reached" },
    clients: [],
    httpCutover: {
      atMs: Date.parse("2026-08-11T00:00:00.000Z"),
      at: "2026-08-11T00:00:00.000Z",
      backfilled: false,
      note: CUTOVER_NOTE,
    },
    operatorView: {
      version: "averray.arrivals.operator.v1",
      generatedAtMs: GENERATED_AT,
      outsiders: {
        furthestEver: {
          window: "all-time",
          stage: "settled",
          atMs: HISTORICAL_AT,
          door: "http",
          agents: 1,
          payouts: 42,
          payoutWindow: "12h",
          payoutSpanMs: 7 * 60 * 60 * 1000,
        },
        lastActivity: { window: "all-time", atMs: HISTORICAL_AT, stage: "settled", door: "http" },
        week: { window: "7d", identified: 3, worked: 0 },
        postedWork: { window: "all-time", status: "never", count: 0, firstAtMs: null },
      },
      ours: {
        day: {
          window: "24h",
          agents: 6,
          canaryRuns: 5,
          acceptanceRuns: 1,
          adminConsoleAgents: 1,
          operatorAgents: 0,
        },
      },
      unknown: { window: "all-time", sharedClientNames: 1, preSplitCalls: 455 },
      doors: {
        mcp: {
          window: "all-time",
          sinceMs: Date.parse("2026-08-08T00:00:00.000Z"),
          rows: rows({ reached: { outsider: 9 }, browsed: { outsider: 2 } }),
        },
        http: {
          window: "all-time",
          sinceMs: Date.parse("2026-08-11T00:00:00.000Z"),
          rows: rows({
            reached: { outsider: 40, ours: 20, unknown: 3 },
            browsed: { outsider: 382, ours: 4 },
            evaluated: { outsider: 1730, ours: 8 },
            identified: { outsider: 3, ours: 6 },
            authenticated: { outsider: 2, ours: 6 },
            claimed: { outsider: 1, ours: 6 },
            submitted: { outsider: 1, ours: 6 },
          }),
        },
      },
    },
    ...overrides,
  };
}

describe("ArrivalsPanel — verdict first", () => {
  test("renders the historical furthest-ever payout burst from feed data", () => {
    const { getByTestId } = render(<ArrivalsPanel arrivals={snapshot()} />);
    const furthest = getByTestId("ops-arrivals-furthest-ever");

    expect(furthest.textContent).toContain("SETTLED · 42 payouts in 12h · 2026-08-11 (HTTP)");
    expect(furthest.textContent).toContain("ALL-TIME");
    expect(getByTestId("ops-arrivals-last-activity").textContent).toContain("5d ago");
  });

  test("posted work flips from NEVER when the producer reports the first external job", () => {
    const first = snapshot();
    const { getByTestId, rerender } = render(<ArrivalsPanel arrivals={first} />);
    expect(getByTestId("ops-arrivals-posted-work").textContent).toContain("NEVER");

    const changed = snapshot();
    if (changed.operatorView && !("unavailable" in changed.operatorView)) {
      changed.operatorView.outsiders.postedWork = {
        window: "all-time",
        status: "observed",
        count: 1,
        firstAtMs: GENERATED_AT,
      };
    }
    rerender(<ArrivalsPanel arrivals={changed} />);
    expect(getByTestId("ops-arrivals-posted-work").textContent).toContain("1 POSTED");
    expect(getByTestId("ops-arrivals-posted-work").textContent).not.toContain("NEVER");
  });

  test("pure canary and acceptance traffic never becomes outsider work", () => {
    const pureSelf = snapshot();
    if (pureSelf.operatorView && !("unavailable" in pureSelf.operatorView)) {
      pureSelf.operatorView.outsiders.week = { window: "7d", identified: 0, worked: 0 };
      pureSelf.operatorView.ours.day.canaryRuns = 5;
      pureSelf.operatorView.ours.day.acceptanceRuns = 1;
    }
    const { getByTestId } = render(<ArrivalsPanel arrivals={pureSelf} />);

    expect(getByTestId("ops-arrivals-this-week").textContent).toContain("0 worked");
    expect(getByTestId("ops-arrivals-ours").textContent).toContain("5 canary runs");
    expect(getByTestId("ops-arrivals-ours").textContent).toContain("1 acceptance run");
  });

  test("labels non-monotonic call rows and puts a window badge on every figure", () => {
    const { getByTestId, getAllByTestId } = render(<ArrivalsPanel arrivals={snapshot()} />);
    const browsed = getByTestId("ops-arrivals-row-http-browsed");
    const evaluated = getByTestId("ops-arrivals-row-http-evaluated");

    expect(browsed.textContent).toContain("calls · browsed route/tool calls");
    expect(evaluated.textContent).toContain("calls · evaluated route/tool calls");
    expect(getByTestId("ops-arrivals-row-http-identified").textContent).toContain("agents · distinct SIWE wallets");
    for (const figure of getAllByTestId(/^ops-arrivals-figure-/)) {
      expect(figure.querySelector(".ops-window-badge")).not.toBeNull();
    }
  });

  test("keeps unknown apart and renders the producer cut-over note verbatim", () => {
    const { getByTestId } = render(<ArrivalsPanel arrivals={snapshot()} />);

    expect(getByTestId("ops-arrivals-unknown").textContent).toContain("shared client names 1");
    expect(getByTestId("ops-arrivals-unknown").textContent).toContain("pre-split calls 455");
    expect(getByTestId("ops-arrivals-http-cutover").textContent).toBe(CUTOVER_NOTE);
  });

  test("the wallet-journey ladders draw only the wallet-unit rows, per door", () => {
    const { getByTestId, queryByTestId } = render(<ArrivalsPanel arrivals={snapshot()} />);

    // The HTTP door's wallet rows become bars with their counts…
    const identified = getByTestId("ops-arrivals-ladder-http-identified");
    expect(identified.textContent).toContain("identified");
    expect(identified.textContent).toContain("3");
    expect(identified.querySelector(".ops-ladder-track i")).not.toBeNull();
    // …the 1730-call evaluated counter must NOT have become a ladder row.
    expect(queryByTestId("ops-arrivals-ladder-http-evaluated")).toBeNull();
    expect(queryByTestId("ops-arrivals-ladder-http-reached")).toBeNull();

    // A zero-wallet stage keeps its row and its 0, but draws no fill.
    const mcpIdentified = getByTestId("ops-arrivals-ladder-mcp-identified");
    expect(mcpIdentified.textContent).toContain("0");
    expect(mcpIdentified.querySelector(".ops-ladder-track i")).toBeNull();
  });

  test("the recency strip marks one fixed band from the snapshot clock", () => {
    const { getByTestId } = render(<ArrivalsPanel arrivals={snapshot()} />);
    // HISTORICAL_AT is 5 days before GENERATED_AT → the <7d band.
    const strip = getByTestId("ops-arrivals-recency");
    expect(strip.getAttribute("data-band")).toBe("7d");
    expect(strip.querySelectorAll('[data-active="yes"]').length).toBe(1);
  });

  test("no outsider activity ever → no recency strip at all", () => {
    const none = snapshot();
    if (none.operatorView && !("unavailable" in none.operatorView)) {
      none.operatorView.outsiders.lastActivity = null;
    }
    const { queryByTestId, getByTestId } = render(<ArrivalsPanel arrivals={none} />);
    expect(queryByTestId("ops-arrivals-recency")).toBeNull();
    expect(getByTestId("ops-arrivals-last-activity").textContent).toContain("NO IDENTIFIED OUTSIDER ACTIVITY YET");
  });

  test("a zero week draws no bars — the words carry the zero", () => {
    const quiet = snapshot();
    if (quiet.operatorView && !("unavailable" in quiet.operatorView)) {
      quiet.operatorView.outsiders.week = { window: "7d", identified: 0, worked: 0 };
    }
    const { queryByTestId } = render(<ArrivalsPanel arrivals={quiet} />);
    expect(queryByTestId("ops-arrivals-weekpair")).toBeNull();
  });

  test("an older producer is a named missing verdict, never a reconstructed zero", () => {
    const older = snapshot({ operatorView: undefined });
    const { getByTestId, queryByTestId } = render(<ArrivalsPanel arrivals={older} />);

    expect(getByTestId("ops-arrivals-unreachable").textContent).toContain("VERDICT VIEW UNAVAILABLE");
    expect(queryByTestId("ops-arrivals-outsiders")).toBeNull();
  });

  test("render code contains no historical design-handback literals", () => {
    const source = readFileSync(resolve(
      process.cwd(),
      "packages/monitor-ui/src/components/ops/ArrivalsPanel.tsx",
    ), "utf8");
    expect(source).not.toMatch(/42 payouts|2026-08-11|pre-split calls 455|outreach #1/iu);
  });
});
