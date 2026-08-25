import { useEffect, useState } from "react";

/** Phone and compact-board breakpoints from PACKET_OPS_MOBILE_UI. */
export const MOBILE_MAX_WIDTH = 767;
export const COMPACT_MAX_WIDTH = 1079;

/**
 * True when the viewport uses the compact triage arrangement. Callers may
 * still pass MOBILE_MAX_WIDTH when they need a phone-only query.
 *
 * SSR/test-safe: starts false and only flips in an effect, so anything without
 * `matchMedia` (jsdom without a stub, a server render) keeps the desktop board
 * — the mobile surface is strictly additive and never hijacks an existing view.
 */
export function useIsMobileViewport(maxWidth: number = COMPACT_MAX_WIDTH): boolean {
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
