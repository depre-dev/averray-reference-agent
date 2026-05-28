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

const rootEl = document.getElementById("root");
if (!rootEl) {
  throw new Error("Hermes monitor: #root element not found");
}

createRoot(rootEl).render(
  <StrictMode>
    <MonitorPage />
  </StrictMode>,
);
