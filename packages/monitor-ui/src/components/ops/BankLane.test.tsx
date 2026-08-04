// @vitest-environment jsdom
//
// Queries are scoped to each render's own container rather than to `screen`.
// Renders accumulate in the document across tests, and a document-wide query
// finds the PREVIOUS test's markup — which passes for the wrong reason.

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";

// RTL's bound queries resolve against document.body, not the render's own
// container — so without this, each test also sees every previous test's
// markup and "found multiple elements" is the lucky outcome. The unlucky one
// is an assertion passing against the wrong render.
afterEach(cleanup);

import { BankLane } from "./BankLane.js";
import type { BankBlock } from "../../lib/monitor/product-health.js";

const lane = (over: Partial<NonNullable<BankBlock["lane"]>> = {}): BankBlock => ({
  lane: {
    position: {
      status: "unverified",
      raw: null,
      detail: "zero from aUSDC 0x2ec48840…acfa93, and this read path has never observed funds",
    },
    float: { text: "0.149412 USDC · 149,412 raw", tone: "ok" },
    postage: { text: "1.51 DOT · committed postage, no withdraw path", tone: "ok" },
    requests: { text: "no requests in flight", tone: "ok" },
    overdueRequestId: null,
    tone: "degraded",
    ...over,
  },
});

describe("a lane nobody wired occupies no board", () => {
  test("no bank block renders NOTHING — not an empty lane, not a complaint", () => {
    // Four "awaiting" tiles for an unconfigured feature is a permanently-lit
    // panel nobody reads, and a line complaining about its own absence is
    // noise about setup rather than about money.
    const { container } = render(<BankLane bank={undefined} />);
    expect(container.innerHTML).toBe("");
  });

  test("a CONFIGURED feed that failed does get a line", () => {
    const { getByTestId } = render(<BankLane bank={{ unavailable: "bank feed unreachable — ECONNREFUSED" }} />);
    expect(getByTestId("ops-bank-absent").textContent).toContain("ECONNREFUSED");
  });

  test("a switched-off feed lands here too — one grey line, and no coloured lane", () => {
    // The live backend answers a disabled feed with a VALID payload whose four
    // reads all carry `lastError: bank_lane_feed_disabled`. Rendered as a lane
    // that was an amber BANK strip for a feature nobody had enabled; the server
    // now collapses it to `unavailable`, and this is what that must look like.
    const { getByTestId, queryByTestId } = render(
      <BankLane bank={{ unavailable: "bank lane switched off at the source — BANK_LANE_FEED_ENABLED is not set" }} />,
    );
    expect(queryByTestId("ops-bank")).toBeNull(); // no lane ⇒ no lane tone
    expect(getByTestId("ops-bank-absent").getAttribute("data-tone")).toBe("awaiting");
  });
});

describe("the position tile states unverified rather than showing a zero", () => {
  test("an uncalibrated zero reads UNVERIFIED and stays warm grey", () => {
    const { getByTestId } = render(<BankLane bank={lane()} />);
    const dd = getByTestId("ops-bank-position").querySelector("dd")!;
    expect(dd.textContent).toContain("UNVERIFIED");
    expect(dd.textContent).toContain("never observed funds");
    // Never coral: it means the instrument cannot vouch for itself, not that
    // the money is gone. Paging on a blind instrument is the false red this
    // board has already removed twice.
    expect(dd.getAttribute("data-tone")).toBe("awaiting");
  });

  test("a proven zero renders as a real reading", () => {
    const { getByTestId } = render(
      <BankLane
        bank={lane({
          position: { status: "empty", raw: "0", detail: "path proven against 100000 raw" },
          tone: "ok",
        })}
      />,
    );
    const dd = getByTestId("ops-bank-position").querySelector("dd")!;
    expect(dd.textContent).toContain("0 raw");
    expect(dd.textContent).toContain("proven against 100000");
    expect(dd.getAttribute("data-tone")).toBe("ok");
  });
});

describe("the float is on screen with its raw units", () => {
  test("both the decimal and the raw are shown", () => {
    // Raw is the unit reconciliation happens in — every measured fee constant
    // is in raw. The decimal alone is readable and useless for the job.
    const { getByTestId } = render(<BankLane bank={lane()} />);
    const text = getByTestId("ops-bank-float").textContent!;
    expect(text).toContain("0.149412 USDC");
    expect(text).toContain("149,412 raw");
  });
});

describe("an overdue request is hoisted above the rows", () => {
  test("the alarm names the request and reddens the lane", () => {
    const { getByTestId } = render(
      <BankLane
        bank={lane({
          requests: { text: "1 OVERDUE · req-9f02 leg2-dispatched for 1.5h", tone: "red" },
          overdueRequestId: "req-9f02",
          tone: "red",
        })}
      />,
    );
    // Legible before any row is read — the one state here where doing nothing
    // costs money.
    expect(getByTestId("ops-bank-alarm").textContent).toContain("req-9f02");
    expect(getByTestId("ops-bank").getAttribute("data-tone")).toBe("red");
  });

  test("no overdue request means no alarm element at all", () => {
    const { queryByTestId } = render(<BankLane bank={lane()} />);
    expect(queryByTestId("ops-bank-alarm")).toBeNull();
  });
});
