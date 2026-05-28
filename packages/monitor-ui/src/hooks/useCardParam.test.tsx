// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { useCardParam } from "./useCardParam.js";

afterEach(cleanup);
beforeEach(() => {
  window.history.replaceState({}, "", "/");
});

function cardParamInUrl(): string | null {
  return new URLSearchParams(window.location.search).get("card");
}

describe("useCardParam", () => {
  test("starts closed when no ?card= is present", () => {
    const { result } = renderHook(() => useCardParam());
    expect(result.current.cardId).toBeNull();
  });

  test("reads an existing ?card= on mount (URL-decoded)", () => {
    window.history.replaceState({}, "", "/?card=agent%20%23548");
    const { result } = renderHook(() => useCardParam());
    expect(result.current.cardId).toBe("agent #548");
  });

  test("setCard updates state and pushes the encoded param", () => {
    const { result } = renderHook(() => useCardParam());
    act(() => result.current.setCard("agent #548"));
    expect(result.current.cardId).toBe("agent #548");
    // URLSearchParams percent-encodes the space + hash.
    expect(cardParamInUrl()).toBe("agent #548");
    expect(window.location.search).toContain("card=");
  });

  test("clearCard removes the param", () => {
    const { result } = renderHook(() => useCardParam());
    act(() => result.current.setCard("agent #1"));
    expect(result.current.cardId).toBe("agent #1");
    act(() => result.current.clearCard());
    expect(result.current.cardId).toBeNull();
    expect(cardParamInUrl()).toBeNull();
  });

  test("an empty / whitespace id clears rather than sets", () => {
    const { result } = renderHook(() => useCardParam());
    act(() => result.current.setCard("   "));
    expect(result.current.cardId).toBeNull();
    expect(cardParamInUrl()).toBeNull();
  });

  test("syncs with browser back/forward via popstate", () => {
    const { result } = renderHook(() => useCardParam());
    act(() => {
      window.history.replaceState({}, "", "/?card=mission%20browser-onboard-04");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(result.current.cardId).toBe("mission browser-onboard-04");
  });
});
