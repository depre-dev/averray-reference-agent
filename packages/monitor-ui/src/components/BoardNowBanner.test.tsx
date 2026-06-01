// @vitest-environment jsdom
import { afterEach, describe, expect, test } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { BoardNowBanner, type BannerData } from "./BoardNowBanner.js";

afterEach(cleanup);

function banner(tone: BannerData["tone"]): BannerData {
  return {
    tone,
    eyebrow: `eyebrow-${tone}`,
    headline: `headline-${tone}`,
    sub: `sub-${tone}`,
    primaryActionId: undefined,
  };
}

describe("BoardNowBanner", () => {
  test("calm tone → sage class + ✓ glyph + prose", () => {
    const { container, getByText } = render(<BoardNowBanner banner={banner("calm")} />);
    expect(container.querySelector(".hm-now--calm")).toBeTruthy();
    expect(getByText("✓")).toBeTruthy();
    expect(getByText("headline-calm")).toBeTruthy();
    expect(getByText("sub-calm")).toBeTruthy();
    expect(getByText(/eyebrow-calm/)).toBeTruthy();
  });

  test("action tone → amber class + ! glyph", () => {
    const { container, getByText } = render(<BoardNowBanner banner={banner("action")} />);
    expect(container.querySelector(".hm-now--action")).toBeTruthy();
    expect(getByText("!")).toBeTruthy();
  });

  test("Hermes focus tone → action wash + H glyph", () => {
    const { container, getByText } = render(<BoardNowBanner banner={banner("hermes-focus")} />);
    expect(container.querySelector(".hm-now--action")).toBeTruthy();
    expect(container.querySelector(".hm-now--hermes-focus")).toBeTruthy();
    expect(getByText("H")).toBeTruthy();
  });

  test("degraded tone → rose class + ‼ glyph", () => {
    const { container, getByText } = render(<BoardNowBanner banner={banner("degraded")} />);
    expect(container.querySelector(".hm-now--degraded")).toBeTruthy();
    expect(getByText("‼")).toBeTruthy();
  });

  test("headline renders inside an <h1> for landmark structure", () => {
    const { container } = render(<BoardNowBanner banner={banner("calm")} />);
    const h1 = container.querySelector("h1.hm-now-head");
    expect(h1?.textContent).toBe("headline-calm");
  });

  test("is a polite live region", () => {
    const { container } = render(<BoardNowBanner banner={banner("calm")} />);
    const root = container.querySelector(".hm-now");
    expect(root?.getAttribute("aria-live")).toBe("polite");
    expect(root?.getAttribute("role")).toBe("status");
  });

  test("renders the cta slot when provided, omits it otherwise", () => {
    const withCta = render(<BoardNowBanner banner={banner("action")} cta={<button>Jump to</button>} />);
    expect(withCta.getByText("Jump to")).toBeTruthy();
    expect(withCta.container.querySelector(".hm-now-cta")).toBeTruthy();

    const noCta = render(<BoardNowBanner banner={banner("calm")} />);
    expect(noCta.container.querySelector(".hm-now-cta")).toBeNull();
  });
});
