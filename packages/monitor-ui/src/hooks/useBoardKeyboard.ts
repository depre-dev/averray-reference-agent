// Hermes Handoff Monitor — board + global keyboard shortcuts (M10', §12).
//
// One window-level keydown handler drives the "mouse unplugged" flow.
// Scope precedence and the input-focus rule come straight from §12:
//   - an <input>/<textarea> with focus suppresses everything but Escape
//   - global keys (?, /, Escape) work anywhere
//   - board keys (j/k/↑/↓, Enter, f, o, a) only when no drawer/overlay
//     is open — the drawer owns j/k/Esc while it's up (M6')
//
// Drawer-scope and hermes-scope keys are handled by their own components;
// this hook owns global + board.

import { useEffect, useRef } from "react";
import { traverseDrawerCard } from "../lib/monitor/drawer-routing.js";

export interface UseBoardKeyboardOptions {
  enabled?: boolean;
  /** Ordered visible cards for j/k focus traversal. */
  cards: ReadonlyArray<{ id: string }>;
  focusedId: string | null;
  /** When a drawer is open it owns j/k/Esc, so board nav stands down. */
  drawerOpen: boolean;
  overlayOpen: boolean;
  onFocusChange: (id: string | null) => void;
  onToggleOverlay: () => void;
  onCloseOverlay: () => void;
  onFocusSearch: () => void;
  onOpenFocused: (id: string) => void;
  onSpotlight: (id: string) => void;
  onOpenPr: (id: string) => void;
  onAsk: (id: string) => void;
}

export function useBoardKeyboard(opts: UseBoardKeyboardOptions): void {
  const ref = useRef(opts);
  ref.current = opts;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const o = ref.current;
      if (o.enabled === false) return;

      const target = e.target as HTMLElement | null;
      const typing = !!target && /^(INPUT|TEXTAREA)$/.test(target.tagName);
      if (typing) {
        // Only Escape escapes an input — blur it (and close the overlay).
        if (e.key === "Escape") {
          target.blur();
          if (o.overlayOpen) o.onCloseOverlay();
        }
        return;
      }

      // Global scope — works anywhere.
      if (e.key === "?") {
        e.preventDefault();
        o.onToggleOverlay();
        return;
      }
      if (e.key === "Escape") {
        if (o.overlayOpen) {
          e.preventDefault();
          o.onCloseOverlay();
        }
        return; // drawer Escape is handled by the drawer itself
      }
      if (e.key === "/") {
        e.preventDefault();
        o.onFocusSearch();
        return;
      }

      // Board scope — yield to an open drawer or overlay.
      if (o.drawerOpen || o.overlayOpen) return;

      switch (e.key) {
        case "j":
        case "ArrowDown":
          e.preventDefault();
          o.onFocusChange(traverseDrawerCard(o.cards, o.focusedId, "next"));
          return;
        case "k":
        case "ArrowUp":
          e.preventDefault();
          o.onFocusChange(traverseDrawerCard(o.cards, o.focusedId, "prev"));
          return;
        case "Enter":
          if (o.focusedId) {
            e.preventDefault();
            o.onOpenFocused(o.focusedId);
          }
          return;
        case "f":
          if (o.focusedId) {
            e.preventDefault();
            o.onSpotlight(o.focusedId);
          }
          return;
        case "o":
          if (o.focusedId) {
            e.preventDefault();
            o.onOpenPr(o.focusedId);
          }
          return;
        case "a":
          if (o.focusedId) {
            e.preventDefault();
            o.onAsk(o.focusedId);
          }
          return;
        default:
          return;
      }
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
