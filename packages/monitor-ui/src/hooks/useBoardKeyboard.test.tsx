// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, renderHook } from "@testing-library/react";
import { useBoardKeyboard, type UseBoardKeyboardOptions } from "./useBoardKeyboard.js";

afterEach(cleanup);

const cards = [{ id: "a" }, { id: "b" }, { id: "c" }];

function press(key: string, target?: EventTarget) {
  (target ?? window).dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
}

function baseOpts(over: Partial<UseBoardKeyboardOptions> = {}): UseBoardKeyboardOptions {
  return {
    cards,
    focusedId: "b",
    drawerOpen: false,
    overlayOpen: false,
    onFocusChange: vi.fn(),
    onToggleOverlay: vi.fn(),
    onCloseOverlay: vi.fn(),
    onFocusSearch: vi.fn(),
    onOpenFocused: vi.fn(),
    onSpotlight: vi.fn(),
    onOpenPr: vi.fn(),
    onAsk: vi.fn(),
    ...over,
  };
}

describe("useBoardKeyboard", () => {
  test("global keys (?, /) fire anywhere", () => {
    const opts = baseOpts();
    renderHook(() => useBoardKeyboard(opts));
    press("?");
    expect(opts.onToggleOverlay).toHaveBeenCalledTimes(1);
    press("/");
    expect(opts.onFocusSearch).toHaveBeenCalledTimes(1);
  });

  test("board nav: j/k move focus; Enter/o/a/f act on the focused card", () => {
    const opts = baseOpts();
    renderHook(() => useBoardKeyboard(opts));
    press("j");
    expect(opts.onFocusChange).toHaveBeenCalledWith("c"); // b → next
    press("k");
    expect(opts.onFocusChange).toHaveBeenCalledWith("a"); // b → prev
    press("Enter");
    expect(opts.onOpenFocused).toHaveBeenCalledWith("b");
    press("o");
    expect(opts.onOpenPr).toHaveBeenCalledWith("b");
    press("a");
    expect(opts.onAsk).toHaveBeenCalledWith("b");
    press("f");
    expect(opts.onSpotlight).toHaveBeenCalledWith("b");
  });

  test("arrow keys alias j/k", () => {
    const opts = baseOpts();
    renderHook(() => useBoardKeyboard(opts));
    press("ArrowDown");
    expect(opts.onFocusChange).toHaveBeenCalledWith("c");
    press("ArrowUp");
    expect(opts.onFocusChange).toHaveBeenCalledWith("a");
  });

  test("board keys stand down while a drawer is open; global keys still fire", () => {
    const opts = baseOpts({ drawerOpen: true });
    renderHook(() => useBoardKeyboard(opts));
    press("j");
    press("Enter");
    expect(opts.onFocusChange).not.toHaveBeenCalled();
    expect(opts.onOpenFocused).not.toHaveBeenCalled();
    press("?");
    expect(opts.onToggleOverlay).toHaveBeenCalledTimes(1);
  });

  test("Escape closes the overlay when open", () => {
    const opts = baseOpts({ overlayOpen: true });
    renderHook(() => useBoardKeyboard(opts));
    press("Escape");
    expect(opts.onCloseOverlay).toHaveBeenCalledTimes(1);
  });

  test("typing in an input suppresses every key but Escape", () => {
    const input = document.createElement("input");
    document.body.appendChild(input);
    const opts = baseOpts({ overlayOpen: true });
    renderHook(() => useBoardKeyboard(opts));
    press("j", input);
    press("?", input);
    expect(opts.onFocusChange).not.toHaveBeenCalled();
    expect(opts.onToggleOverlay).not.toHaveBeenCalled();
    press("Escape", input);
    expect(opts.onCloseOverlay).toHaveBeenCalledTimes(1);
    input.remove();
  });

  test("enabled:false is inert", () => {
    const opts = baseOpts({ enabled: false });
    renderHook(() => useBoardKeyboard(opts));
    press("j");
    press("?");
    expect(opts.onFocusChange).not.toHaveBeenCalled();
    expect(opts.onToggleOverlay).not.toHaveBeenCalled();
  });
});
