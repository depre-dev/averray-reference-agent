// Hermes Handoff Monitor — keyboard shortcuts contract.
//
// Single source of truth for every keyboard binding the monitor
// accepts. The cheat-sheet overlay reads this directly so what the
// operator sees is what the handlers listen for.
//
// Scopes: global / board / drawer / hermes. An input/textarea claiming
// focus suppresses every scope except Escape.
//
// Per §12 of docs/HERMES_MONITOR_REDESIGN_SPEC.md.

export type ShortcutScope = "global" | "board" | "drawer" | "hermes";

export interface ShortcutBinding {
  /** the KeyboardEvent.key value to match */
  key: string;
  /** symbolic action id the handler dispatches */
  action: string;
  /** operator-facing description for the overlay */
  label: string;
  scope: ShortcutScope;
  /** true if currently wired; false if specced but added in a later milestone */
  wired: boolean;
}

/** Ordered list of every binding (order = cheat-sheet render order). */
export const KEYBOARD_BINDINGS: readonly ShortcutBinding[] = Object.freeze([
  // Global
  { key: "?", action: "toggle_keyboard_overlay", label: "toggle keyboard hints", scope: "global", wired: true },
  { key: "/", action: "focus_search", label: "jump to search", scope: "global", wired: true },
  { key: "Escape", action: "close_drawer_or_overlay", label: "close drawer / overlay", scope: "global", wired: true },

  // Board
  { key: "j", action: "focus_next_card", label: "next card", scope: "board", wired: true },
  { key: "ArrowDown", action: "focus_next_card", label: "next card (arrow)", scope: "board", wired: true },
  { key: "k", action: "focus_prev_card", label: "previous card", scope: "board", wired: true },
  { key: "ArrowUp", action: "focus_prev_card", label: "previous card (arrow)", scope: "board", wired: true },
  { key: "Enter", action: "open_drawer_for_focused", label: "open focused card", scope: "board", wired: true },
  { key: "f", action: "spotlight_focused_lane", label: "focus / spotlight lane", scope: "board", wired: true },
  // M10' additions
  { key: "o", action: "open_pr_for_focused", label: "open PR on GitHub", scope: "board", wired: false },
  { key: "a", action: "ask_hermes_about_focused", label: "ask Hermes about focused card", scope: "board", wired: false },

  // Drawer
  { key: "j", action: "drawer_next_card", label: "next card (in drawer)", scope: "drawer", wired: false },
  { key: "k", action: "drawer_prev_card", label: "previous card (in drawer)", scope: "drawer", wired: false },
  { key: "Enter", action: "drawer_primary_action", label: "trigger primary action", scope: "drawer", wired: false },
  { key: "A", action: "drawer_action_approve", label: "approve", scope: "drawer", wired: false },
  { key: "B", action: "drawer_action_send_back", label: "send back to Codex", scope: "drawer", wired: false },
  { key: "R", action: "drawer_action_rerun_fresh", label: "rerun fresh (missions)", scope: "drawer", wired: false },
  { key: "M", action: "drawer_action_rerun_memory", label: "rerun with memory", scope: "drawer", wired: false },
  { key: "C", action: "drawer_copy_report", label: "copy report", scope: "drawer", wired: false },

  // Hermes co-pilot composer
  { key: "Enter", action: "hermes_send_message", label: "send message", scope: "hermes", wired: false },
  { key: "ArrowUp", action: "hermes_history_prev", label: "previous question", scope: "hermes", wired: false },
  { key: "ArrowDown", action: "hermes_history_next", label: "next question", scope: "hermes", wired: false },
]);

/**
 * Build a `{ [key]: action }` lookup for a single scope. The same
 * physical key can map to different actions in different scopes
 * (e.g. `j` on board vs in drawer) — pass the right scope for the
 * active context.
 */
export function bindingsForScope(scope: ShortcutScope): Record<string, string> {
  const out: Record<string, string> = {};
  for (const b of KEYBOARD_BINDINGS) {
    if (b.scope === scope) out[b.key] = b.action;
  }
  return out;
}

/** Cheat-sheet entries in display order; optionally only the wired ones. */
export function visibleBindings(opts: { wiredOnly?: boolean } = {}): ShortcutBinding[] {
  if (opts.wiredOnly) return KEYBOARD_BINDINGS.filter((b) => b.wired);
  return [...KEYBOARD_BINDINGS];
}
