// Hermes Handoff Monitor — focused-card URL state (M6').
//
// The detail drawer is driven by the `?card=<id>` query param so a focused
// card is shareable and survives reload / back-forward. This hook reads
// that param, exposes setters that push history entries, and stays in
// sync with the browser's back/forward via popstate.
//
// Encode/decode go through the tested drawer-routing helpers; writes use
// URLSearchParams (which percent-encodes) so card ids with spaces and
// hashes ("agent #548") round-trip cleanly.

import { useCallback, useEffect, useState } from "react";
import { decodeCardParam } from "../lib/monitor/drawer-routing.js";

const PARAM = "card";

function readCardParam(): string | null {
  if (typeof window === "undefined") return null;
  return decodeCardParam(new URLSearchParams(window.location.search).get(PARAM));
}

export interface CardParamState {
  /** The currently focused card id, or null when the drawer is closed. */
  cardId: string | null;
  /** Set the focused card (null clears it). Pushes a history entry. */
  setCard: (id: string | null) => void;
  /** Convenience for setCard(null). */
  clearCard: () => void;
}

export function useCardParam(): CardParamState {
  const [cardId, setCardId] = useState<string | null>(() => readCardParam());

  useEffect(() => {
    if (typeof window === "undefined") return;
    const onPop = () => setCardId(readCardParam());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const setCard = useCallback((id: string | null) => {
    const next = typeof id === "string" && id.trim().length > 0 ? id.trim() : null;
    if (typeof window !== "undefined") {
      const url = new URL(window.location.href);
      if (next) url.searchParams.set(PARAM, next);
      else url.searchParams.delete(PARAM);
      window.history.pushState({}, "", url);
    }
    setCardId(next);
  }, []);

  const clearCard = useCallback(() => setCard(null), [setCard]);

  return { cardId, setCard, clearCard };
}
