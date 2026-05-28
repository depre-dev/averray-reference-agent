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
