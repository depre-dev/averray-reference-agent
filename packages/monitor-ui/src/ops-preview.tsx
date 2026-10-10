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
import "./styles/hermes4-direction-b.css";

import { OpsBoard } from "./components/ops/OpsBoard.js";
import { MobileBoard, type MobileOpsScreen } from "./components/mobile/MobileBoard.js";
import {
  OPS_FIXTURE_ARRIVALS,
  OPS_FIXTURE_NOMINAL,
  OPS_FIXTURE_STRESS,
  OPS_FIXTURE_UNVERIFIED,
  OPS_FIXTURE_LIVE,
  OPS_FIXTURE_CROWDED,
  FIXTURE_NOW,
} from "./lib/monitor/ops-fixtures.js";
import {
  OVERNIGHT_LEDGER_LIVE,
  OVERNIGHT_LEDGER_FIXTURE,
  OVERNIGHT_LEDGER_UNAUTHORIZED,
  OVERNIGHT_LEDGER_UNAVAILABLE,
  READ_IDENTITY_FIXTURE,
  TOPUP_DESTINATIONS_FIXTURE,
} from "./lib/monitor/overnight-ledger-fixtures.js";
import type {
  OvernightLedgerPayload,
  OvernightWindow,
  RemoteFeedReading,
} from "./lib/monitor/overnight-ledger.js";

// The arrivals block is merged HERE rather than baked into the base fixtures:
// the phone-board tests compose their own arrivals over OPS_FIXTURE_NOMINAL
// and assert exact lane text, so the base fixtures stay arrivals-free while
// the preview still exercises the OUTSIDERS visualization. LIVE keeps no
// arrivals on purpose — that is the UNREACHABLE state.
const withArrivals = (health: typeof OPS_FIXTURE_NOMINAL) => ({ ...health, arrivals: OPS_FIXTURE_ARRIVALS });
const EMPTY_EVENTS_LEDGER: RemoteFeedReading<OvernightLedgerPayload> = {
  state: "live",
  data: {
    ...OVERNIGHT_LEDGER_FIXTURE,
    events: { items: [], totalCount: 0, returnedCount: 0, hasOlder: false },
  },
};
const ACTION_LEDGER: RemoteFeedReading<OvernightLedgerPayload> = {
  state: "live",
  data: {
    ...OVERNIGHT_LEDGER_FIXTURE,
    digest: { ...OVERNIGHT_LEDGER_FIXTURE.digest, warningsOpen: 1 },
  },
};

const FIXTURES = {
  nominal: {
    label: "FIG. 1 — Unauthorized ledger",
    health: withArrivals(OPS_FIXTURE_NOMINAL),
    degraded: false,
    ledger: OVERNIGHT_LEDGER_UNAUTHORIZED,
    topups: OVERNIGHT_LEDGER_UNAUTHORIZED,
  },
  ledger: {
    label: "FIG. 2 — Ledger fixture",
    health: withArrivals(OPS_FIXTURE_NOMINAL),
    degraded: false,
    ledger: OVERNIGHT_LEDGER_LIVE,
    topups: TOPUP_DESTINATIONS_FIXTURE,
  },
  actions: {
    label: "FIG. 3 — Current action",
    health: withArrivals(OPS_FIXTURE_NOMINAL),
    degraded: false,
    ledger: ACTION_LEDGER,
    topups: TOPUP_DESTINATIONS_FIXTURE,
  },
  unavailable: {
    label: "FIG. 4 — Unavailable ledger",
    health: withArrivals(OPS_FIXTURE_NOMINAL),
    degraded: false,
    ledger: OVERNIGHT_LEDGER_UNAVAILABLE,
    topups: OVERNIGHT_LEDGER_UNAVAILABLE,
  },
  stress: {
    label: "FIG. 5 — Stress",
    health: withArrivals(OPS_FIXTURE_STRESS),
    degraded: true,
    ledger: OVERNIGHT_LEDGER_UNAVAILABLE,
    topups: OVERNIGHT_LEDGER_UNAVAILABLE,
  },
  unverified: {
    label: "Blind instrument",
    health: withArrivals(OPS_FIXTURE_UNVERIFIED),
    degraded: false,
    ledger: OVERNIGHT_LEDGER_UNAVAILABLE,
    topups: OVERNIGHT_LEDGER_UNAVAILABLE,
  },
  crowded: {
    label: "Long strings — 200 incidents",
    health: withArrivals(OPS_FIXTURE_CROWDED),
    degraded: false,
    ledger: OVERNIGHT_LEDGER_LIVE,
    topups: TOPUP_DESTINATIONS_FIXTURE,
  },
  awaiting: {
    label: "Awaiting blocks",
    health: OPS_FIXTURE_LIVE,
    degraded: false,
    ledger: OVERNIGHT_LEDGER_UNAVAILABLE,
    topups: OVERNIGHT_LEDGER_UNAVAILABLE,
  },
  "events-empty": {
    label: "FIG. 6 — Empty live events",
    health: withArrivals(OPS_FIXTURE_NOMINAL),
    degraded: false,
    ledger: EMPTY_EVENTS_LEDGER,
    topups: TOPUP_DESTINATIONS_FIXTURE,
  },
} as const;
type FixtureKey = keyof typeof FIXTURES;
type PreviewDestination = MobileOpsScreen | "more";

const previewParams = new URLSearchParams(window.location.search);
const fixtureParam = previewParams.get("fixture");
const destinationParam = previewParams.get("mobile");
const captureMode = previewParams.get("capture") === "1";
const initialFixture: FixtureKey = fixtureParam && fixtureParam in FIXTURES ? fixtureParam as FixtureKey : "nominal";
const initialDestination: PreviewDestination | null = isPreviewDestination(destinationParam) ? destinationParam : null;

function Harness() {
  const [key, setKey] = useState<FixtureKey>(initialFixture);
  // The phone is a separate surface, not a narrow desktop — preview it at its
  // real 390×844 rather than by dragging the window.
  const [phone, setPhone] = useState(initialDestination !== null || captureMode);
  const [windowValue, setWindowValue] = useState<OvernightWindow>("24h");
  const active = FIXTURES[key];
  return (
    <div className="hm-shell">
      {!captureMode ? <div
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
      </div> : null}
      {phone ? (
        <div
          data-testid="ops-mobile-preview-frame"
          style={{
            width: 390,
            minHeight: 844,
            overflow: "hidden",
            border: captureMode ? "none" : "1px solid var(--h4-line)",
            margin: captureMode ? 0 : "8px 22px",
          }}
        >
          <MobileBoard
            health={active.health}
            streamDegraded={active.degraded}
            streamStatus={active.degraded ? "reconnecting" : "open"}
            nowMs={FIXTURE_NOW}
            overnightLedger={active.ledger}
            topupDestinations={active.topups}
            readIdentity={READ_IDENTITY_FIXTURE}
            overnightWindow={windowValue}
            onOvernightWindowChange={setWindowValue}
            initialScreen={initialDestination && initialDestination !== "more" ? initialDestination : "status"}
            initialMoreOpen={initialDestination === "more"}
          />
        </div>
      ) : (
      <OpsBoard
        health={active.health}
        streamDegraded={active.degraded}
        streamStatus={active.degraded ? "reconnecting" : "open"}
        nowMs={FIXTURE_NOW}
        overnightLedger={active.ledger}
        topupDestinations={active.topups}
      />
      )}
    </div>
  );
}

function isPreviewDestination(value: string | null): value is PreviewDestination {
  return value === "status" || value === "money" || value === "work" || value === "events" || value === "more";
}

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("ops-preview: #root not found");
createRoot(rootEl).render(
  <StrictMode>
    <Harness />
  </StrictMode>,
);
