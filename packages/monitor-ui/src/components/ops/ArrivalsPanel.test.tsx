// @vitest-environment jsdom
import { afterEach, describe, expect, test } from "vitest";
import { cleanup, render } from "@testing-library/react";

import { ARRIVAL_STAGES, type ArrivalsBlock } from "../../lib/monitor/product-health.js";
import { ArrivalsPanel } from "./ArrivalsPanel.js";

afterEach(cleanup);

const arrivals: ArrivalsBlock = {
  schemaVersion: "averray.arrivals.v1",
  generatedAtMs: 1_786_100_000_000,
  observingSinceMs: 1_786_000_000_000,
  funnel: {
    reached: 20,
    browsed: 12,
    evaluated: 7,
    identified: 3,
    authenticated: 2,
    claimed: 1,
    submitted: 1,
  },
  distinct: { declared: 4, anonymous: 9, furthest: "submitted" },
  clients: [],
};

describe("ArrivalsPanel", () => {
  test("renders the complete reached-to-submitted funnel as descending bars", () => {
    const { getByTestId } = render(<ArrivalsPanel arrivals={arrivals} />);
    const rows = ARRIVAL_STAGES.map((stage) => getByTestId(`ops-arrival-stage-${stage}`));

    expect(rows.map((row) => row.querySelector(".ops-arrivals-stage")?.textContent)).toEqual(ARRIVAL_STAGES);
    expect(rows.map((row) => (row.querySelector("i") as HTMLElement).style.width)).toEqual([
      "100%",
      "60%",
      "35%",
      "15%",
      "10%",
      "5%",
      "5%",
    ]);
    expect(rows.map((row) => row.querySelector("strong")?.textContent)).toEqual(["20", "12", "7", "3", "2", "1", "1"]);
  });

  test("shows declared versus anonymous and makes the furthest stage explicit", () => {
    const { getByTestId, getByLabelText } = render(<ArrivalsPanel arrivals={arrivals} />);

    expect(getByLabelText("Distinct arrival clients").textContent).toContain("DECLARED 4");
    expect(getByLabelText("Distinct arrival clients").textContent).toContain("ANONYMOUS 9");
    expect(getByTestId("ops-arrivals-furthest").textContent).toContain("submitted");
    expect(getByTestId("ops-arrivals-furthest").getAttribute("data-advanced")).toBe("yes");
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
