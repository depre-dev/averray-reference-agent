// @vitest-environment jsdom
//
// What the ops board must render, and what it must refuse to render.
//
// The pure decisions are covered in ops-spec.test.ts; these assert that the
// decisions actually reach the screen — that a "no meter" decision produces no
// bar element, that a shortfall and an unverified read do not look alike, and
// that a clean funnel next to contradicting proof shows BOTH numbers.
import { afterEach, describe, expect, test } from "vitest";
import { cleanup, render, within } from "@testing-library/react";

import { OpsBoard } from "./OpsBoard.js";
import {
  OPS_FIXTURE_LIVE,
  OPS_FIXTURE_NOMINAL,
  OPS_FIXTURE_STRESS,
  OPS_FIXTURE_UNVERIFIED,
  FIXTURE_NOW,
} from "../../lib/monitor/ops-fixtures.js";

afterEach(cleanup);

/** Render at the fixture's own check time so nothing reads as stale. */
const fresh = (health: typeof OPS_FIXTURE_NOMINAL) => (health.at ?? FIXTURE_NOW) + 2_000;

describe("OpsBoard — the honest empty states", () => {
  test("monitoring off says so instead of showing a green board", () => {
    const { getByTestId } = render(
      <OpsBoard
        health={{ enabled: false, at: null, status: "unknown", checks: 0, probes: [] }}
        nowMs={FIXTURE_NOW}
      />,
    );
    expect(getByTestId("ops-verdict").textContent).toBe("NOT WATCHING");
  });

  test("awaiting the first check is NO DATA YET, not nominal", () => {
    const { getByTestId } = render(
      <OpsBoard
        health={{ enabled: true, at: null, status: "unknown", checks: 0, probes: [] }}
        nowMs={FIXTURE_NOW}
      />,
    );
    expect(getByTestId("ops-verdict").textContent).toBe("NO DATA YET");
  });

  test("without structured blocks the money panels await data, never fabricate it", () => {
    const { getByTestId, container } = render(
      <OpsBoard health={OPS_FIXTURE_LIVE} nowMs={fresh(OPS_FIXTURE_LIVE)} />,
    );
    expect(getByTestId("ops-solvency-awaiting")).toBeTruthy();
    // No pools at all → no meters at all.
    expect(container.querySelectorAll(".ops-meter")).toHaveLength(0);
    // Funnel counts read "—", not "0".
    const flow = getByTestId("ops-flow");
    expect(within(flow).getAllByText("—").length).toBeGreaterThan(0);
    expect(within(flow).queryByText("0")).toBeNull();
  });
});

describe("OpsBoard — the banner must not argue with the trust panel", () => {
  // Caught on screen: the banner said "every value below is STALE" while the
  // trust row two inches right said "4m ago — fresh". Both were computed
  // correctly from different facts; the SENTENCE was the bug. A dead stream
  // with a recent reading means frozen, not wrong.
  test("stream down + a recent check says FROZEN, not stale", () => {
    const health = { ...OPS_FIXTURE_NOMINAL, checkIntervalMs: 2 * 60_000 };
    const nowMs = health.at! + 60_000;
    const { getByTestId } = render(
      <OpsBoard health={health} streamDegraded streamStatus="reconnecting" nowMs={nowMs} />,
    );
    const banner = getByTestId("ops-stale-banner").textContent ?? "";
    expect(banner).toContain("FROZEN");
    expect(banner).not.toContain("STALE and may be wrong");
    // …and the trust row agrees rather than contradicting it.
    expect(getByTestId("ops-trust").textContent).toContain("fresh");
  });

  test("a genuinely old check does say STALE", () => {
    const health = { ...OPS_FIXTURE_NOMINAL, checkIntervalMs: 2 * 60_000 };
    const nowMs = health.at! + 30 * 60_000;
    const { getByTestId } = render(<OpsBoard health={health} nowMs={nowMs} />);
    expect(getByTestId("ops-stale-banner").textContent).toContain("STALE and may be wrong");
    expect(getByTestId("ops-trust").textContent).toContain("STALE");
  });

  // The regression that started this: a 3-minute threshold against a 2-minute
  // heartbeat lit the alarm over a healthy system, most of the time.
  test("a merely-late check raises NO banner at all", () => {
    const health = { ...OPS_FIXTURE_NOMINAL, checkIntervalMs: 2 * 60_000 };
    const { queryByTestId } = render(<OpsBoard health={health} nowMs={health.at! + 3 * 60_000} />);
    expect(queryByTestId("ops-stale-banner")).toBeNull();
  });
});

describe("OpsBoard — uptime states its span", () => {
  // "uptime 100.0%" off one check, labelled 24h, printed beside "awaiting
  // history" on the same line. The number was fine; the span was a claim we
  // never observed.
  test("a short buffer names the span it actually covers", () => {
    const health = {
      ...OPS_FIXTURE_NOMINAL,
      history: {
        ...OPS_FIXTURE_NOMINAL.history,
        uptimePct24h: 100,
        uptimeSamples: 6,
        uptimeSpanMs: 12 * 60_000,
        uptimeWindowMs: 24 * 3_600_000,
      },
    };
    const { getByTestId } = render(<OpsBoard health={health} nowMs={fresh(health)} />);
    expect(getByTestId("ops-pillars").textContent).toContain("uptime 100.0% over 12m");
  });

  test("a single check withholds the percentage entirely", () => {
    const health = {
      ...OPS_FIXTURE_NOMINAL,
      history: { ...OPS_FIXTURE_NOMINAL.history, uptimePct24h: 100, uptimeSamples: 1, uptimeSpanMs: 0 },
    };
    const { getByTestId } = render(<OpsBoard health={health} nowMs={fresh(health)} />);
    const pillars = getByTestId("ops-pillars").textContent ?? "";
    expect(pillars).toContain("too few checks");
    expect(pillars).not.toContain("100.0%");
  });

  test("a full window drops the qualifier", () => {
    const { getByTestId } = render(
      <OpsBoard health={OPS_FIXTURE_NOMINAL} nowMs={fresh(OPS_FIXTURE_NOMINAL)} />,
    );
    const pillars = getByTestId("ops-pillars").textContent ?? "";
    expect(pillars).toContain("uptime 100.0%");
    expect(pillars).not.toContain("over ");
  });
});

describe("OpsBoard — solvency meters", () => {
  test("only floored pools draw a bar", () => {
    const { container } = render(
      <OpsBoard health={OPS_FIXTURE_NOMINAL} nowMs={fresh(OPS_FIXTURE_NOMINAL)} />,
    );
    // 3 floored pools (gas, reward bank, AAC) → exactly 3 meters, and the
    // reserve / escrow / revenue rows get none.
    expect(container.querySelectorAll(".ops-meter")).toHaveLength(3);
  });

  // THE SHIPPED BUG, pinned: the treasury reserve is intentionally at 0.00 with
  // no floor. It once rendered as a FULL bar and read "healthy and full".
  test("the intentionally-empty reserve gets no meter and keeps its reason", () => {
    const { getByTestId } = render(
      <OpsBoard health={OPS_FIXTURE_NOMINAL} nowMs={fresh(OPS_FIXTURE_NOMINAL)} />,
    );
    const reserve = getByTestId("ops-pool-reserve");
    expect(reserve.querySelector(".ops-meter")).toBeNull();
    expect(reserve.textContent).toContain("intentionally unfunded");
  });

  test("a breached floor is coral and states the absolute shortfall", () => {
    const { getByTestId } = render(<OpsBoard health={OPS_FIXTURE_STRESS} nowMs={FIXTURE_NOW} />);
    const bank = getByTestId("ops-pool-reward_bank");
    expect(bank.getAttribute("data-tone")).toBe("red");
    expect(bank.textContent).toContain("BELOW FLOOR · short 0.58");
  });
});

describe("OpsBoard — payout evidence", () => {
  test("confirmed shows both sources so the operator can check the match", () => {
    const { getByTestId } = render(
      <OpsBoard health={OPS_FIXTURE_NOMINAL} nowMs={fresh(OPS_FIXTURE_NOMINAL)} />,
    );
    const evidence = getByTestId("ops-evidence");
    expect(getByTestId("ops-evidence-status").textContent).toBe("CONFIRMED");
    expect(evidence.textContent).toContain("14 payouts confirmed on-chain");
    expect(evidence.textContent).toContain("14 marked settled");
    expect(evidence.getAttribute("data-emphasis")).toBe("off");
  });

  // THE POINT OF THE ROW: the funnel still reads a clean 9 → 9 → 9 while the
  // chain can only account for 12 of 14. The board must show the contradiction,
  // not average it away.
  test("a clean funnel beside a shortfall shows BOTH numbers and names the gap", () => {
    const { getByTestId } = render(<OpsBoard health={OPS_FIXTURE_STRESS} nowMs={FIXTURE_NOW} />);
    const flow = getByTestId("ops-flow");
    expect(within(flow).getAllByText("9").length).toBe(3); // claimed / submitted / settled
    expect(getByTestId("ops-evidence-status").textContent).toBe("SHORTFALL −2");
    expect(getByTestId("ops-evidence").textContent).toContain(
      "2 settled jobs have no on-chain proof",
    );
    expect(flow.textContent).toContain("evidence below disagrees");
  });

  // "We cannot see" must never look like "we can see, and money is missing".
  test("unverified does NOT look like shortfall", () => {
    const { getByTestId } = render(
      <OpsBoard health={OPS_FIXTURE_UNVERIFIED} nowMs={fresh(OPS_FIXTURE_UNVERIFIED)} />,
    );
    const status = getByTestId("ops-evidence-status");
    expect(status.textContent).toBe("UNVERIFIED");
    expect(status.getAttribute("data-tone")).toBe("awaiting");
    expect(getByTestId("ops-evidence").getAttribute("data-emphasis")).toBe("off");
    expect(getByTestId("ops-evidence").textContent).not.toMatch(/money did not move/i);
  });

  test("the confirmed / shortfall / unverified key is permanently on screen", () => {
    const { getByTestId } = render(
      <OpsBoard health={OPS_FIXTURE_NOMINAL} nowMs={fresh(OPS_FIXTURE_NOMINAL)} />,
    );
    const evidence = getByTestId("ops-evidence").textContent ?? "";
    expect(evidence).toContain("instrument broken, not money");
    expect(evidence).toContain("proof missing: money broken");
  });
});

describe("OpsBoard — pillars and footer", () => {
  test("every probe reaches the pillar strip with its detail", () => {
    const { getByTestId } = render(
      <OpsBoard health={OPS_FIXTURE_NOMINAL} nowMs={fresh(OPS_FIXTURE_NOMINAL)} />,
    );
    const pillars = getByTestId("ops-pillars").textContent ?? "";
    for (const probe of OPS_FIXTURE_NOMINAL.probes) {
      expect(pillars).toContain(probe.name);
      expect(pillars).toContain(probe.detail);
    }
  });

  test("an awaiting probe is counted as awaiting, not folded into degraded", () => {
    const { getByTestId } = render(
      <OpsBoard health={OPS_FIXTURE_LIVE} nowMs={fresh(OPS_FIXTURE_LIVE)} />,
    );
    expect(getByTestId("ops-pillars").textContent).toContain("awaiting");
  });

  // A line through two points is a fabricated trend.
  test("the latency trend refuses to draw without enough history", () => {
    const { getByTestId } = render(
      <OpsBoard health={OPS_FIXTURE_LIVE} nowMs={fresh(OPS_FIXTURE_LIVE)} />,
    );
    expect(getByTestId("ops-trend-awaiting").textContent).toContain("awaiting history");
  });

  test("an empty incident log says 'none recorded', not 'all clear'", () => {
    const { container } = render(
      <OpsBoard health={OPS_FIXTURE_NOMINAL} nowMs={fresh(OPS_FIXTURE_NOMINAL)} />,
    );
    expect(container.querySelector(".ops-foot")?.textContent).toContain("none recorded");
  });

  // Demoted from the tallest column on the board to one footer line.
  test("LLM spend is a single footer line, and admits what it excludes", () => {
    const { container } = render(
      <OpsBoard
        health={OPS_FIXTURE_NOMINAL}
        nowMs={fresh(OPS_FIXTURE_NOMINAL)}
        board={{
          cards: [],
          at: "2026-07-31T09:41:05Z",
          llmUsage: {
            status: "recorded",
            inputTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
            costUsd: 20,
            costStatus: "recorded",
            runs: 3,
            byModel: [],
            byDay: [],
            billing: {
              metered: { models: [], monthCostUsd: 20, costStatus: "recorded" },
              subscriptions: [
                { provider: "ollama", label: "shared A", plan: "flat", planLabel: "Flat", monthlyUsd: null, configured: true, active: true, dedicated: false, unit: "tokens", models: [], windows: {} },
                { provider: "codex", label: "shared B", plan: "flat", planLabel: "Flat", monthlyUsd: null, configured: true, active: true, dedicated: false, unit: "runs", models: [], windows: {} },
              ],
              monthlyTotalUsd: 20,
              monthlyTotalComplete: false,
            },
          },
        } as never}
      />,
    );
    const foot = container.querySelector(".ops-foot")?.textContent ?? "";
    expect(foot).toContain("LLM SPEND ≈ $20.00 this month");
    expect(foot).toContain("2 shared plans excluded from total");
  });

  test("no usage data says so instead of showing $0.00", () => {
    const { container } = render(
      <OpsBoard health={OPS_FIXTURE_NOMINAL} nowMs={fresh(OPS_FIXTURE_NOMINAL)} />,
    );
    const foot = container.querySelector(".ops-foot")?.textContent ?? "";
    expect(foot).toContain("LLM SPEND — not recorded");
    expect(foot).not.toContain("$0.00");
  });
  test("both encodings sit on ONE line under the balance they belong to", () => {
    // Under the number, not in a separate strip — reading an address in one
    // place while looking at its balance in another is what made the strip
    // wrong. One line is what makes that affordable: ~100 monospace glyphs fit
    // the pool row, where two lines did not fit the board.
    const { getByTestId } = render(
      <OpsBoard health={OPS_FIXTURE_NOMINAL} nowMs={fresh(OPS_FIXTURE_NOMINAL)} />,
    );
    const addr = getByTestId("ops-pool-addr-aac");
    expect(addr.textContent).toContain("0xB1350932bf85E7ffd0599E9a3CC7b55718D89E57");
    expect(addr.textContent).toContain("151MENb3J9ZiBv147yhNkPDiY8rXF7TrWc13PqWYJeLuupBd");
    expect(addr.textContent).toContain("AgentAccountCore");
    // It lives inside the pool row, not somewhere else on the board.
    expect(getByTestId("ops-pool-aac").contains(addr)).toBe(true);
  });

  test("a pool whose figure did NOT come from a balance read gets no address", () => {
    // reward_bank is reported by the product's own /health. Borrowing the AAC's
    // address to fill the gap would claim a provenance the number does not have
    // — the same class of lie as a fake green.
    const { queryByTestId } = render(
      <OpsBoard health={OPS_FIXTURE_NOMINAL} nowMs={fresh(OPS_FIXTURE_NOMINAL)} />,
    );
    expect(queryByTestId("ops-pool-addr-reward_bank")).toBeNull();
  });

  test("a pool with no derivable SS58 says so rather than showing nothing", () => {
    // Silence would read as "this account has no SS58 form", which is false —
    // it means we could not derive one, and those are different facts.
    const { getByTestId } = render(
      <OpsBoard health={OPS_FIXTURE_NOMINAL} nowMs={fresh(OPS_FIXTURE_NOMINAL)} />,
    );
    expect(getByTestId("ops-pool-addr-signer_gas").textContent).toContain("SS58 unavailable");
  });

  test("every pool still renders — an address must never cost a measurement", () => {
    // The first attempt at this pushed two pools off a 1440x900 board.
    const { getAllByTestId } = render(
      <OpsBoard health={OPS_FIXTURE_NOMINAL} nowMs={fresh(OPS_FIXTURE_NOMINAL)} />,
    );
    expect(getAllByTestId(/^ops-pool-[a-z_]+$/).length).toBe(6);
  });
});

// The board named what was wrong in eleven places and never said what to do.
describe("NEXT — what to do about it", () => {
  test("a board with something wrong says what to do next", () => {
    const { getByTestId } = render(<OpsBoard health={OPS_FIXTURE_STRESS} nowMs={OPS_FIXTURE_STRESS.at! + 2000} />);
    expect(getByTestId("ops-next").textContent).toContain("NEXT");
  });

  test("an all-clear board shows NO strip — not a reassuring empty box", () => {
    // NOMINAL is not all-clear — it carries a degraded capability, so the
    // strip correctly appears for it. A genuinely clean board has to be built.
    const health = {
      ...OPS_FIXTURE_NOMINAL,
      bank: undefined,
      probes: OPS_FIXTURE_NOMINAL.probes.map((p) => ({ ...p, status: "ok" as const })),
      solvency: { ...OPS_FIXTURE_NOMINAL.solvency, runway: [] },
    };
    const { queryByTestId } = render(<OpsBoard health={health} nowMs={health.at! + 2000} />);
    expect(queryByTestId("ops-next")).toBeNull();
  });

  test("it TELLS, it does not ACT — no button reaches this read-only board", () => {
    // Every suggestion carries an approvable task. Rendering it here would
    // break the promise one line below: "refresh is the only control".
    const { getByTestId } = render(<OpsBoard health={OPS_FIXTURE_STRESS} nowMs={OPS_FIXTURE_STRESS.at! + 2000} />);
    expect(getByTestId("ops-next").querySelector("button")).toBeNull();
  });
});

// The glosses reach the DOM, where a hover can find them. jsdom cannot hover,
// but it can prove the title is attached — absence here is the exact way this
// feature silently dies in a refactor.
describe("glosses — the numbers explain themselves", () => {
  test("the margin, the meter and the window-fit line each carry their gloss", () => {
    const { getByTestId, container } = render(
      <OpsBoard health={OPS_FIXTURE_NOMINAL} nowMs={OPS_FIXTURE_NOMINAL.at! + 2000} />,
    );
    const margin = container.querySelector(".ops-pool-margin");
    expect(margin?.getAttribute("title")).toContain("Balance ÷ floor");
    const meter = container.querySelector(".ops-meter");
    expect(meter?.getAttribute("title")).toContain("settlement halts");
    expect(getByTestId("ops-evidence-fit").getAttribute("title")).toContain("same 24h");
  });

  test("every rendered note key explains itself; RUNWAY answers the pool's question", () => {
    // No fixture carries gas data, so BURN never renders here — it only exists
    // live. Asserting it from a fixture would test the fixture, not the board;
    // its gloss text is held to standard by ops-gloss.test.ts and it shares
    // this exact keyed-lookup path with RUNWAY.
    const { container } = render(<OpsBoard health={OPS_FIXTURE_NOMINAL} nowMs={OPS_FIXTURE_NOMINAL.at! + 2000} />);
    const keys = [...container.querySelectorAll(".ops-pool-note-key")];
    expect(keys.length).toBeGreaterThan(0);
    for (const k of keys) {
      expect(k.getAttribute("title"), `${k.textContent} lost its gloss`).toBeTruthy();
    }
    const runway = keys.find((k) => k.textContent === "RUNWAY");
    expect(runway?.getAttribute("title")).toContain("still fund");
  });
});
