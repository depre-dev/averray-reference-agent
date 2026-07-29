// @vitest-environment jsdom
// ChainTicker component — the chip renders the derivation and ticks its age on
// a 1s interval via an injected clock, so the test proves the height stays
// frozen while the age advances.

import { afterEach, describe, expect, test, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { ChainTicker } from "./ChainTicker.js";
import type { ChainTick, ProductHealthProbe } from "../lib/monitor/product-health.js";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const T0 = 1_700_000_000_000;

const okProbe: ProductHealthProbe = {
  name: "chain_height",
  status: "ok",
  detail: "block #18,812,345 · 3s old",
  sparkline: ["ok"],
};

const chain: ChainTick = { height: 18_812_345, observedAtMs: T0, blockAgeSec: 3, lastAdvanceAtMs: T0, freshSeconds: 600 };

describe("ChainTicker", () => {
  test("renders the observed height with a ticking age — height frozen, age advancing", () => {
    vi.useFakeTimers();
    let nowMs = T0;
    const { container } = render(<ChainTicker chain={chain} probe={okProbe} now={() => nowMs} />);
    const pill = container.querySelector(".hm-chain-pill");
    expect(pill?.textContent).toContain("#18,812,345");
    expect(pill?.textContent).toContain("3s");

    nowMs = T0 + 42_000;
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(pill?.textContent).toContain("#18,812,345"); // NEVER self-increments
    expect(pill?.textContent).toContain("45s"); // 3s measured + 42s elapsed
    expect(pill?.className).toContain("tone-ok");
  });

  test("renders the honest awaiting chip when no reading exists", () => {
    const { container } = render(<ChainTicker chain={undefined} probe={undefined} now={() => T0} />);
    const pill = container.querySelector(".hm-chain-pill");
    expect(pill?.textContent).toContain("chain · —");
    expect(pill?.className).toContain("tone-awaiting");
  });

  test("stale reading renders dashed (is-stale) and drops the confident green", () => {
    const { container } = render(
      <ChainTicker chain={chain} probe={okProbe} pollError now={() => T0 + 5_000} />,
    );
    const pill = container.querySelector(".hm-chain-pill");
    expect(pill?.className).toContain("is-stale");
    expect(pill?.className).toContain("tone-awaiting");
  });
});
