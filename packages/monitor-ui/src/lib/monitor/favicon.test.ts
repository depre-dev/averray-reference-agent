// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { setAppBadge, setFaviconBadge } from "./favicon.js";

beforeAll(() => {
  // jsdom has no 2D canvas; return null quietly (matches real jsdom
  // behaviour) instead of letting it log a "Not implemented" error.
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
});

afterEach(() => {
  document.querySelectorAll('link[rel="icon"]').forEach((n) => n.remove());
});

describe("setAppBadge", () => {
  test("sets the badge for a positive count", () => {
    const setAppBadgeSpy = vi.fn();
    const clearAppBadgeSpy = vi.fn();
    setAppBadge(3, { setAppBadge: setAppBadgeSpy, clearAppBadge: clearAppBadgeSpy } as unknown as Navigator);
    expect(setAppBadgeSpy).toHaveBeenCalledWith(3);
    expect(clearAppBadgeSpy).not.toHaveBeenCalled();
  });

  test("clears the badge at zero", () => {
    const setAppBadgeSpy = vi.fn();
    const clearAppBadgeSpy = vi.fn();
    setAppBadge(0, { setAppBadge: setAppBadgeSpy, clearAppBadge: clearAppBadgeSpy } as unknown as Navigator);
    expect(clearAppBadgeSpy).toHaveBeenCalledTimes(1);
    expect(setAppBadgeSpy).not.toHaveBeenCalled();
  });

  test("no-ops (no throw) when the Badging API is unavailable", () => {
    expect(() => setAppBadge(2, {} as Navigator)).not.toThrow();
  });
});

describe("setFaviconBadge", () => {
  test("ensures an icon link and does not throw without a 2D canvas context", () => {
    // jsdom returns null from canvas.getContext('2d') → the canvas path
    // is skipped, but the icon link is still ensured.
    expect(() => setFaviconBadge(2, document)).not.toThrow();
    expect(document.querySelector('link[rel="icon"]')).toBeTruthy();
  });

  test("no-ops without a document", () => {
    expect(() => setFaviconBadge(1, undefined)).not.toThrow();
  });
});
