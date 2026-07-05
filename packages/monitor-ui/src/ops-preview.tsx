// Dev-only preview harness for the Ops surface. Renders OpsBoard against the ops
// fixtures with a fixture picker + the board-level surface switch, so the look
// can be iterated in the browser without the live backend. NOT a Vite build
// input (ops-preview.html is dev-served only), so this never ships to prod.

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

function Harness() {
  const [key, setKey] = useState<FixtureKey>("live");
  const [surface, setSurface] = useState<BoardSurface>("ops");
  const health = FIXTURES[key].health;
  return (
    <div className="hm-board">
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
      {surface === "ops" ? (
        <OpsBoard health={health} nowMs={FIXTURE_NOW} />
      ) : (
        <div className="ops-board">
          <p className="ops-await">Delivery kanban renders here (unchanged in Ops work).</p>
        </div>
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
