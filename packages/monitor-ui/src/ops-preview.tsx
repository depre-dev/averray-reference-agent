// Dev-only preview harness for the ops board.
//
// The board IS the product now, so this is just the real <OpsBoard> in the real
// shell with fixture + stream-state switches — no mock top strip, no mock rail,
// no delivery placeholder. The two headline fixtures are the design's reference
// renders: NOMINAL (the all-day state) and STRESS (breached floor + payout
// shortfall + dead stream at once).
//
// NOT a Vite build input.

import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";

// Same style chain as main.tsx so the preview matches the real board exactly.
import "./styles/averray-tokens.css";
import "./styles/monitor.css";
import "./styles/hermes4-tokens.css";
import "./styles/hermes4-shell.css";
import "./styles/hermes4-ops.css";
import "./styles/hermes4-mobile.css";

import { OpsBoard } from "./components/ops/OpsBoard.js";
import { MobileBoard } from "./components/mobile/MobileBoard.js";
import {
  OPS_FIXTURE_NOMINAL,
  OPS_FIXTURE_STRESS,
  OPS_FIXTURE_UNVERIFIED,
  OPS_FIXTURE_LIVE,
  FIXTURE_NOW,
} from "./lib/monitor/ops-fixtures.js";

const FIXTURES = {
  nominal: { label: "FIG. 1 — Nominal", health: OPS_FIXTURE_NOMINAL, degraded: false },
  stress: { label: "FIG. 2 — Stress", health: OPS_FIXTURE_STRESS, degraded: true },
  unverified: { label: "Blind instrument", health: OPS_FIXTURE_UNVERIFIED, degraded: false },
  awaiting: { label: "Awaiting blocks", health: OPS_FIXTURE_LIVE, degraded: false },
} as const;
type FixtureKey = keyof typeof FIXTURES;

function Harness() {
  const [key, setKey] = useState<FixtureKey>("nominal");
  // The phone is a separate surface, not a narrow desktop — preview it at its
  // real 390×844 rather than by dragging the window.
  const [phone, setPhone] = useState(false);
  const active = FIXTURES[key];
  return (
    <div className="hm-shell">
      <div
        style={{
          display: "flex",
          gap: 8,
          padding: "8px 22px 0",
          fontFamily: "var(--h4-font-mono)",
          fontSize: 11,
        }}
      >
        {(Object.keys(FIXTURES) as FixtureKey[]).map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => setKey(k)}
            style={{
              padding: "3px 10px",
              cursor: "pointer",
              font: "inherit",
              color: k === key ? "var(--h4-ink)" : "var(--h4-muted)",
              background: "none",
              border: `1px solid ${k === key ? "var(--h4-line-strong)" : "var(--h4-line-2)"}`,
            }}
          >
            {FIXTURES[k].label}
          </button>
        ))}
        <button
          type="button"
          onClick={() => setPhone((v) => !v)}
          style={{
            marginLeft: "auto",
            padding: "3px 10px",
            cursor: "pointer",
            font: "inherit",
            color: phone ? "var(--h4-ink)" : "var(--h4-muted)",
            background: "none",
            border: `1px solid ${phone ? "var(--h4-line-strong)" : "var(--h4-line-2)"}`,
          }}
        >
          {phone ? "◧ Phone 390×844" : "◨ Desktop"}
        </button>
      </div>
      {phone ? (
        <div style={{ width: 390, height: 844, overflow: "auto", border: "1px solid var(--h4-line)", margin: "8px 22px" }}>
          <MobileBoard
            health={active.health}
            streamDegraded={active.degraded}
            streamStatus={active.degraded ? "reconnecting" : "open"}
            nowMs={FIXTURE_NOW}
          />
        </div>
      ) : (
      <OpsBoard
        health={active.health}
        streamDegraded={active.degraded}
        streamStatus={active.degraded ? "reconnecting" : "open"}
        nowMs={FIXTURE_NOW}
      />
      )}
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
