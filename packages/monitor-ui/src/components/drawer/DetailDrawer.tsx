// Hermes Handoff Monitor — DetailDrawer (M6').
//
// Mounts when ?card=<id> resolves to a board card. A right-hand sheet
// over a scrim, type-routed body, variant-accented header/footer.
//
// Interaction contract (§11):
//   - esc closes, restoring focus to where it was (focus-trap return)
//   - scrim click closes
//   - j / k traverse to the prev / next visible card (drawer scope)
//   - focus is trapped inside the dialog while open
//
// We drive esc + j/k ourselves (escapeDeactivates is off) so a single
// keydown path owns the behaviour; focus-trap-react handles the trap and
// focus restoration.

import { useEffect, useRef } from "react";
import { FocusTrap } from "focus-trap-react";
import type { BoardCard } from "../../lib/monitor/card-types.js";
import { traverseDrawerCard } from "../../lib/monitor/drawer-routing.js";
import { DRAWER_ACCENT, DrawerBody, drawerVariant } from "./DrawerBody.js";

export interface DetailDrawerProps {
  card: BoardCard;
  /** Ordered list of currently-visible cards, for j/k traversal. */
  cards: ReadonlyArray<{ id: string }>;
  onClose: () => void;
  /** Navigate the drawer to another card id (j/k). */
  onNavigate: (id: string) => void;
}

export function DetailDrawer({ card, cards, onClose, onNavigate }: DetailDrawerProps) {
  const variant = drawerVariant(card);
  const accent = DRAWER_ACCENT[variant];
  const asideRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      const target = e.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA)$/.test(target.tagName)) return;
      if (e.key === "j") {
        const next = traverseDrawerCard(cards, card.id, "next");
        if (next) {
          e.preventDefault();
          onNavigate(next);
        }
      } else if (e.key === "k") {
        const prev = traverseDrawerCard(cards, card.id, "prev");
        if (prev) {
          e.preventDefault();
          onNavigate(prev);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [card.id, cards, onClose, onNavigate]);

  const action = "action" in card ? card.action : undefined;

  return (
    <FocusTrap
      focusTrapOptions={{
        escapeDeactivates: false,
        clickOutsideDeactivates: false,
        returnFocusOnDeactivate: true,
        delayInitialFocus: false,
        // jsdom has no layout, so skip tabbable's visibility check; our
        // drawer controls are always visible in a real browser anyway.
        tabbableOptions: { displayCheck: "none" },
        fallbackFocus: () => asideRef.current ?? document.body,
      }}
    >
      <div className="hm-drawer-scrim" onClick={onClose}>
        <aside
          ref={asideRef}
          className="hm-drawer"
          role="dialog"
          aria-modal="true"
          aria-label={`${card.id} — ${card.title}`}
          tabIndex={-1}
          onClick={(e) => e.stopPropagation()}
          style={{ borderLeftColor: accent.border }}
        >
          <header className="hm-drawer-head">
            <div className="hm-drawer-eyebrow">
              <span className={"hm-pill " + accent.pill}>{accent.label}</span>
              <button type="button" className="close" onClick={onClose}>
                esc · close
              </button>
            </div>
            <h2 className="hm-drawer-title">{card.title}</h2>
            <div className="hm-drawer-meta">
              <span>
                <span className="hm-muted">id</span> {card.id}
              </span>
              <span>
                <span className="hm-muted">repo</span> {card.repo}
              </span>
              {card.branch ? (
                <span>
                  <span className="hm-muted">branch</span> {card.branch}
                </span>
              ) : null}
              {card.waitingOn ? (
                <span>
                  <span className="hm-muted">waiting on</span> {card.waitingOn.actor}
                </span>
              ) : null}
            </div>
          </header>

          <div className="hm-drawer-body">
            <DrawerBody card={card} variant={variant} />
          </div>

          <footer className="hm-drawer-foot">
            {action ? (
              <>
                <button type="button" className="hm-btn hm-btn--action">
                  {action.primary}
                </button>
                {action.secondary ? (
                  <button type="button" className="hm-btn hm-btn--ghost">
                    {action.secondary}
                  </button>
                ) : null}
              </>
            ) : null}
            <button type="button" className="hm-btn hm-btn--ghost">
              Ask Hermes
            </button>
            <span className="spacer" />
            <span className="hm-mono hm-muted">j ‹ prev · k › next · esc close</span>
          </footer>
        </aside>
      </div>
    </FocusTrap>
  );
}
