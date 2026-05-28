// @vitest-environment jsdom
import { afterEach, describe, expect, test } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { ChecksBar } from "./ChecksBar.js";

afterEach(cleanup);

describe("ChecksBar", () => {
  test("renders one segment per non-zero check kind", () => {
    const { container } = render(
      <ChecksBar checks={{ pass: 5, running: 1, fail: 0, pending: 0, total: 6 }} />,
    );
    expect(container.querySelector(".pass")).toBeTruthy();
    expect(container.querySelector(".running")).toBeTruthy();
    expect(container.querySelector(".fail")).toBeNull();
    expect(container.querySelector(".pending")).toBeNull();
  });

  test("segment widths are the fraction of total", () => {
    const { container } = render(
      <ChecksBar checks={{ pass: 3, running: 0, fail: 1, pending: 0, total: 4 }} />,
    );
    expect((container.querySelector(".pass") as HTMLElement).style.width).toBe("75%");
    expect((container.querySelector(".fail") as HTMLElement).style.width).toBe("25%");
  });

  test("falls back to summed total when total is 0", () => {
    const { container } = render(
      <ChecksBar checks={{ pass: 1, running: 1, fail: 0, pending: 0, total: 0 }} />,
    );
    // 1 of (1+1) = 50%
    expect((container.querySelector(".pass") as HTMLElement).style.width).toBe("50%");
  });

  test("renders nothing when there are no checks at all", () => {
    const { container } = render(
      <ChecksBar checks={{ pass: 0, running: 0, fail: 0, pending: 0, total: 0 }} />,
    );
    expect(container.querySelector(".hm-checks-bar")).toBeNull();
  });

  test("exposes a screen-reader summary", () => {
    const { container } = render(
      <ChecksBar checks={{ pass: 4, running: 3, fail: 0, pending: 0, total: 7 }} />,
    );
    expect((container.querySelector(".hm-checks-bar") as HTMLElement).getAttribute("aria-label")).toBe(
      "4 of 7 checks passed",
    );
  });
});
