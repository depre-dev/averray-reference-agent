// Hermes Handoff Monitor — Vite entry point.
//
// Bootstraps the React tree and pulls in the bundle CSS (shipped
// verbatim as styles/monitor.css). This file is the only place the
// global stylesheet is imported; it is excluded from the composite
// `tsc -b` graph (Vite/esbuild own it) so the CSS side-effect import
// never trips NodeNext module resolution.

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { MonitorPage } from "./MonitorPage.js";
// Design tokens (fonts + --font-*/--avy-* vars, Google Fonts @import) MUST
// load before monitor.css: hermes.css references var(--font-body) etc. 109×
// and those custom properties are defined only here. Shipping monitor.css
// alone left the board on fallback fonts.
import "./styles/averray-tokens.css";
import "./styles/monitor.css";
// Hermes-4 design layer (PR-D1): the --h4-* token system + theme engine and
// the new shell/footer/kanban-tier styles. Loaded LAST so its additive rules
// win; namespaced so it never clobbers the shipped board's --hm-* tokens.
import "./styles/hermes4-tokens.css";
import "./styles/hermes4-shell.css";
// PR-D2: card badge families + active/mirror treatment (--h4).
import "./styles/hermes4-cards.css";
// PR-D3e: rail reskin — re-points the co-pilot rail's --hm-* surfaces to --h4-*
// so the column tracks the active color profile. Cosmetic, additive, rail-only.
import "./styles/hermes4-rail.css";
// PR-D4: full board card/lane migration — aliases the legacy --hm-* tokens onto
// the --h4 profile system so the whole board tracks the active profile.
import "./styles/hermes4-board.css";
// PR-E1: inbox-first Kanban — hero Decision Inbox + read-only tier columns.
import "./styles/hermes4-kanban.css";
// Utilities redesign: calm two-column card panel (LLM usage · suites · launcher)
// + the redesigned mission-starter. Loaded last so its additive rules win.
import "./styles/hermes4-utilities.css";

const rootEl = document.getElementById("root");
if (!rootEl) {
  throw new Error("Hermes monitor: #root element not found");
}

createRoot(rootEl).render(
  <StrictMode>
    <MonitorPage />
  </StrictMode>,
);
