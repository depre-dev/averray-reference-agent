// Hermes Handoff Monitor — keyboard cheat sheet (M10', §12).
//
// Reads the binding contract directly (keyboard-map.ts) so what the
// operator sees is exactly what the handlers listen for — no hand-kept
// duplicate list. Toggled by `?`, dismissed by `?` / Escape / click.
// Bindings not yet wired are shown dimmed and tagged "soon" so the sheet
// never over-promises.

import { KEYBOARD_BINDINGS, type ShortcutScope, visibleBindings } from "../../lib/monitor/keyboard-map.js";

const SCOPE_ORDER: ShortcutScope[] = ["global", "board", "drawer", "hermes"];
const SCOPE_LABEL: Record<ShortcutScope, string> = {
  global: "Anywhere",
  board: "On the board",
  drawer: "In the drawer",
  hermes: "Hermes composer",
};

/** Pretty key cap for a KeyboardEvent.key value. */
function keyCap(key: string): string {
  if (key === "Enter") return "↵";
  if (key === "ArrowUp") return "↑";
  if (key === "ArrowDown") return "↓";
  if (key === "Escape") return "esc";
  return key.length === 1 ? key.toUpperCase() : key;
}

export interface KeyboardOverlayProps {
  onClose: () => void;
}

export function KeyboardOverlay({ onClose }: KeyboardOverlayProps) {
  const bindings = visibleBindings();

  return (
    <div className="hm-keys" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts">
      <div className="title" style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span>Keyboard · press ? to toggle</span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close keyboard shortcuts"
          style={{
            marginLeft: "auto",
            cursor: "pointer",
            color: "var(--hm-muted-soft)",
            fontWeight: 500,
            fontSize: 11,
            background: "none",
            border: "none",
          }}
        >
          ✕
        </button>
      </div>

      {SCOPE_ORDER.map((scope) => {
        const rows = bindings.filter((b) => b.scope === scope);
        if (rows.length === 0) return null;
        return (
          <div key={scope} className="hm-keys-group">
            <div className="hm-keys-group-title hm-mono hm-muted">{SCOPE_LABEL[scope]}</div>
            {rows.map((b) => (
              <div
                className="row"
                key={`${b.scope}:${b.key}:${b.action}`}
                style={b.wired ? undefined : { opacity: 0.45 }}
              >
                <span className="key">
                  <span className="hm-kbd">{keyCap(b.key)}</span>
                </span>
                <span>
                  {b.label}
                  {b.wired ? "" : " · soon"}
                </span>
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}

/** Re-export so callers can show only the live bindings if they prefer. */
export { KEYBOARD_BINDINGS };
