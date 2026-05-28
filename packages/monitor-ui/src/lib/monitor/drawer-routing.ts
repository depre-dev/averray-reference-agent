// Hermes Handoff Monitor — drawer URL-routing helpers.
//
// Pure functions for the focused-card id in the URL query string. The
// board page reads `?card=<id>` to decide whether to mount the detail
// drawer; clicking a card sets it; esc clears it. Card ids include
// spaces + hashes ("agent #548"), so encoding must be URL-safe.
//
// Per §11 of docs/HERMES_MONITOR_REDESIGN_SPEC.md.

/** Encode a card id for the `?card=` param. Null for empty/non-string. */
export function encodeCardParam(id: string | undefined | null): string | null {
  if (typeof id !== "string") return null;
  const trimmed = id.trim();
  if (!trimmed) return null;
  return encodeURIComponent(trimmed);
}

/** Decode the `?card=` value (already URL-decoded by URLSearchParams). */
export function decodeCardParam(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Index of a card id in an ordered list, or -1. */
export function indexOfCard(cards: ReadonlyArray<{ id: string }>, focusedId: string | null | undefined): number {
  if (!Array.isArray(cards) || !focusedId) return -1;
  for (let i = 0; i < cards.length; i += 1) {
    if (cards[i]?.id === focusedId) return i;
  }
  return -1;
}

/**
 * Next card id for j/k traversal. Stays put at the ends (no
 * wrap-around — that's disorienting). Unknown focus jumps to the
 * first card so a deleted card-id in the URL can't soft-lock.
 */
export function traverseDrawerCard(
  cards: ReadonlyArray<{ id: string }>,
  focusedId: string | null | undefined,
  direction: "next" | "prev"
): string | null {
  if (!Array.isArray(cards) || cards.length === 0) return null;
  const idx = indexOfCard(cards, focusedId);
  if (idx < 0) return cards[0]?.id ?? null;
  if (direction === "next") {
    const nextIdx = Math.min(idx + 1, cards.length - 1);
    return cards[nextIdx]?.id ?? null;
  }
  if (direction === "prev") {
    const prevIdx = Math.max(idx - 1, 0);
    return cards[prevIdx]?.id ?? null;
  }
  return focusedId ?? null;
}
