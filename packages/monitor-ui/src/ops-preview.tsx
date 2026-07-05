// Dev-only preview harness for the Ops surface. Mirrors the REAL board frame
// (`.hm-board` grid → top strip · banner · `.hm-main` [lanes | rail] · footer)
// with real classNames so the actual layout CSS applies, then swaps only the
// `.hm-lanes-wrap` content between a delivery placeholder and <OpsBoard> — the
// co-pilot rail stays mounted in both views (that's the whole point of the
// split). NOT a Vite build input (ops-preview.html is dev-served only).

import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";

// Same style chain as main.tsx so the preview matches the real board exactly.
import "./styles/averray-tokens.css";
import "./styles/monitor.css";
import "./styles/hermes4-tokens.css";
import "./styles/hermes4-shell.css";
import "./styles/hermes4-cards.css";
import "./styles/hermes4-rail.css";
import "./styles/hermes4-board.css";
import "./styles/hermes4-kanban.css";
import "./styles/hermes4-utilities.css";
import "./styles/hermes4-ops.css";

import { OpsBoard } from "./components/ops/OpsBoard.js";
import { BoardSurfaceSwitch, type BoardSurface } from "./components/ops/BoardSurfaceSwitch.js";
import {
  OPS_FIXTURE_LIVE,
  OPS_FIXTURE_POPULATED,
  OPS_FIXTURE_RED,
  FIXTURE_NOW,
} from "./lib/monitor/ops-fixtures.js";

const FIXTURES = {
  live: { label: "Live (today)", health: OPS_FIXTURE_LIVE },
  populated: { label: "Populated", health: OPS_FIXTURE_POPULATED },
  red: { label: "Mainnet red", health: OPS_FIXTURE_RED },
} as const;
type FixtureKey = keyof typeof FIXTURES;

// Lightweight stand-ins for the real frame pieces (top strip, rail, footer) so
// the grid rows/columns resolve exactly like production without pulling the live
// board data those components need.
function MockTopStrip() {
  return (
    <div className="hm-top" role="banner">
      <div className="hm-brand">
        <div className="hm-brand-mark" aria-hidden>A</div>
        <div>
          <div className="hm-brand-name">Hermes</div>
          <div className="hm-brand-sub">Handoff monitor · Averray</div>
        </div>
      </div>
      <div className="hm-kpis">
        <span className="hm-kpi"><span className="n">37</span> Action needed</span>
        <span className="hm-kpi hm-kpi--zero"><span className="n">0</span> Operator review</span>
        <span className="hm-kpi hm-kpi--ok"><span className="dot" aria-hidden /> Deploy OK</span>
      </div>
      <div className="hm-top-right">
        <span className="hm-deploy-pill"><span className="ledge" aria-hidden /> Live · 10:42:47</span>
      </div>
    </div>
  );
}

function MockRail() {
  return (
    <aside
      aria-label="Hermes co-pilot (mock)"
      style={{
        background: "var(--h4-surface)",
        borderLeft: "1px solid var(--h4-line)",
        padding: "14px 16px",
        display: "flex",
        flexDirection: "column",
        gap: 10,
        minHeight: 0,
        overflow: "hidden",
      }}
    >
      <div style={{ color: "var(--h4-ink)", fontWeight: 500, fontSize: 13 }}>Hermes co-pilot</div>
      <p style={{ color: "var(--h4-muted)", fontSize: 12, margin: 0, lineHeight: 1.5 }}>
        Stays mounted in both views. In Ops, Hermes narrates product-health deltas here — the next
        chunk feeds ops signals into the digest + chat.
      </p>
      <div
        style={{
          marginTop: "auto",
          border: "1px solid var(--h4-line)",
          borderRadius: "var(--h4-r-btn)",
          padding: "9px 12px",
          color: "var(--h4-faint)",
          fontSize: 12,
        }}
      >
        Ask Hermes…
      </div>
    </aside>
  );
}

function Harness() {
  const [key, setKey] = useState<FixtureKey>("live");
  const [surface, setSurface] = useState<BoardSurface>("ops");
  const health = FIXTURES[key].health;
  return (
    <div className="hm-board">
      <div className="hm-sr-only" role="status" aria-live="assertive" />

      <div className="ops-switch-bar">
        <BoardSurfaceSwitch surface={surface} onChange={setSurface} health={health} />
        <div className="ops-switch" style={{ marginLeft: "auto" }} role="group" aria-label="Preview fixture">
          {(Object.keys(FIXTURES) as FixtureKey[]).map((k) => (
            <button
              key={k}
              type="button"
              className={`ops-switch-opt${k === key ? " is-on" : ""}`}
              onClick={() => setKey(k)}
            >
              {FIXTURES[k].label}
            </button>
          ))}
        </div>
      </div>

      <MockTopStrip />

      {surface === "delivery" ? (
        <div className="hm-now" style={{ padding: "10px 18px", color: "var(--h4-muted)" }}>
          37 decisions waiting on you — delivery banner (hidden in Ops)
        </div>
      ) : null}

      <div className="hm-main">
        <div className="hm-lanes-wrap">
          {surface === "ops" ? (
            <OpsBoard health={health} nowMs={FIXTURE_NOW} />
          ) : (
            <div className="ops-board">
              <p className="ops-await">Delivery kanban renders here (unchanged in Ops work).</p>
            </div>
          )}
        </div>
        <MockRail />
      </div>

      <footer className="h4-board-footer" aria-label="Board footer">
        <span className="h4-board-footer-end"><span className="dot" aria-hidden /> End of board</span>
        <span className="h4-board-footer-stat">40 cards · 37 waiting on you · 0 running</span>
        <span className="h4-board-footer-meta">Hermes · Averray</span>
      </footer>
    </div>
  );
}

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("ops-preview: #root not found");
createRoot(rootEl).render(
  <StrictMode>
    <Harness />
  </StrictMode>,
);
