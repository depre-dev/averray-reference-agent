// Hermes Handoff Monitor — degraded top strip (M11', §16).
//
// Swaps in for <TopStrip> when the SSE stream drops. The §16 hard rule:
// zero tolerance for hiding "we don't know if there's action needed." So
// the KPIs show `?` — never the last cached number — and an UNTRUSTED
// banner spells out *why* and *what to do*. The reason is built from what
// we actually know (the stream status + last-good read); we don't invent
// an upstream error code we never received.

export interface TopStripDegradedProps {
  /** Last known-good snapshot clock (e.g. "14:32:08"), if any. */
  lastKnownAt?: string;
  /** Operator-facing reason the data is untrusted. */
  reason: string;
  /** Reconnect / refresh handler. */
  onReconnect?: () => void;
}

const ROSE = "var(--hm-rose)";
const ROSE_WASH = "#fbf0ee";
const ROSE_BORDER = "rgba(162,58,58,0.32)";
const ROSE_PIP = "rgba(162,58,58,0.18)";

export function TopStripDegraded({ lastKnownAt, reason, onReconnect }: TopStripDegradedProps) {
  return (
    <>
      <div className="hm-top hm-top--degraded" role="banner">
        <div className="hm-brand">
          <div className="hm-brand-mark" style={{ background: ROSE, color: "#fffdf7" }} aria-hidden>
            !
          </div>
          <div>
            <div className="hm-brand-name">Hermes — degraded mode</div>
            <div className="hm-brand-sub" style={{ color: ROSE }}>
              {lastKnownAt ? `Live stream disconnected · last good ${lastKnownAt}` : "Live stream disconnected"}
            </div>
          </div>
        </div>

        <div className="hm-kpis" role="status" aria-live="polite" aria-label="Board KPI counts — unavailable">
          <UnknownKpi label="Action needed" />
          <UnknownKpi label="Operator review" />
          <span className="hm-kpi hm-kpi--zero">last known · {lastKnownAt || "—"}</span>
        </div>

        <div className="hm-top-right">
          <span
            className="hm-deploy-pill"
            style={{ background: ROSE_WASH, borderColor: ROSE_BORDER, color: ROSE }}
            aria-label="Stream offline"
          >
            <span className="ledge" style={{ background: ROSE }} aria-hidden />
            OFFLINE
          </span>
          <button type="button" className="hm-refresh" onClick={onReconnect} disabled={!onReconnect} aria-label="Reconnect">
            ⟳ Reconnect
          </button>
        </div>
      </div>

      <div className="hm-degraded-banner" role="alert">
        <span className="pill">UNTRUSTED</span>
        <span className="reasons">{reason}</span>
        {onReconnect ? (
          <span className="right">
            <button type="button" onClick={onReconnect}>
              Reconnect now
            </button>
          </span>
        ) : null}
      </div>
    </>
  );
}

function UnknownKpi({ label }: { label: string }) {
  return (
    <span className="hm-kpi" style={{ background: ROSE_WASH, borderColor: ROSE_BORDER, color: ROSE }}>
      <span className="n" style={{ background: ROSE_PIP, color: ROSE }}>
        ?
      </span>{" "}
      {label} · unknown
    </span>
  );
}
