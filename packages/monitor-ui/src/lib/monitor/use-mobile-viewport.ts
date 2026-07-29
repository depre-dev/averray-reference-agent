import { useEffect, useState } from "react";

/** Below this the board switches to the dedicated mobile surface. Chosen so a
 *  phone in portrait gets it and a tablet/laptop keeps the full board. */
export const MOBILE_MAX_WIDTH = 720;

/**
 * True when the viewport is phone-sized.
 *
 * SSR/test-safe: starts false and only flips in an effect, so anything without
 * `matchMedia` (jsdom without a stub, a server render) keeps the desktop board
 * — the mobile surface is strictly additive and never hijacks an existing view.
 */
export function useIsMobileViewport(maxWidth: number = MOBILE_MAX_WIDTH): boolean {
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const query = window.matchMedia(`(max-width: ${maxWidth}px)`);
    const apply = () => setIsMobile(query.matches);
    apply();
    // addListener is the pre-2019 Safari spelling; keep both so an older phone
    // still tracks rotation instead of freezing at its first reading.
    if (typeof query.addEventListener === "function") {
      query.addEventListener("change", apply);
      return () => query.removeEventListener("change", apply);
    }
    query.addListener?.(apply);
    return () => query.removeListener?.(apply);
  }, [maxWidth]);

  return isMobile;
}
