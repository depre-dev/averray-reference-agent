import {
  ARRIVAL_SURFACES,
  CLIENT_SOFTWARE_CLASSES,
  isUnavailable,
  type AdminDemandFeed,
  type AdminDemandWindow,
  type ArrivalSurface,
  type ArrivalTimeline,
  type ClientSoftwareClass,
  type WorkerJourney,
  type WorkerJourneyEvent,
} from "../../lib/monitor/admin-demand.js";

export interface AdminDemandPanelProps {
  feed: AdminDemandFeed | undefined;
  window: AdminDemandWindow;
  isLoading?: boolean;
  error?: unknown;
  onWindowChange: (window: AdminDemandWindow) => void;
}

const SURFACE_LABELS: Record<ArrivalSurface, string> = {
  manifest: "manifest",
  onboarding: "onboarding",
  jobs_reads: "jobs reads",
  mcp_initialize: "MCP initialize",
  verify_profiles: "verify profiles",
};

const EVENT_LABELS: Record<WorkerJourneyEvent["type"], string> = {
  first_seen: "arrived",
  auth_nonce: "auth nonce",
  signed_in: "signed in",
  preflighted: "preflighted",
  claimed: "claimed",
  submitted: "submitted",
  verified: "verified",
  settled: "settled",
  withdrawal_intent: "withdrawal intent",
  gas_grant: "gas grant",
};

export function AdminDemandPanel({
  feed,
  window,
  isLoading = false,
  error,
  onWindowChange,
}: AdminDemandPanelProps) {
  const currentFeed = feed?.window === window ? feed : undefined;
  const collectionSince = currentFeed?.collectionSince
    ?? (!currentFeed || isUnavailable(currentFeed.timeline) ? undefined : currentFeed.timeline.collectionSince)
    ?? (!currentFeed || isUnavailable(currentFeed.journeys) ? undefined : currentFeed.journeys.collectionSince);

  return (
    <section className="ops-admin-demand" aria-label="Arrivals and worker journeys" data-testid="ops-admin-demand">
      <header className="ops-admin-demand-head">
        <span>
          <strong>ARRIVALS &amp; JOURNEYS</strong>
          <small>operator-only · pre-auth counts, wallet identity after SIWE</small>
        </span>
        <label className="ops-demand-window">
          <span>window</span>
          <select
            aria-label="Arrivals timeline window"
            value={window}
            onChange={(event) => onWindowChange(event.currentTarget.value as AdminDemandWindow)}
          >
            <option value="48h">48h · hourly</option>
            <option value="30d">30d · daily</option>
          </select>
        </label>
      </header>

      <p className="ops-demand-cutover" data-testid="ops-demand-cutover">
        {collectionSince
          ? <>data begins <time dateTime={collectionSince}>{formatCutover(collectionSince)}</time> · no backfill</>
          : "data cut-over unavailable · no history is inferred"}
      </p>

      {!currentFeed ? (
        <p className="ops-demand-status" role="status" data-testid="ops-demand-loading">
          {error ? `ADMIN READ UNAVAILABLE — ${errorMessage(error)}` : isLoading ? "LOADING ADMIN READ…" : "AWAITING ADMIN READ"}
        </p>
      ) : (
        <div className="ops-admin-demand-grid">
          <TimelineView timeline={currentFeed.timeline} />
          <JourneyList journeys={currentFeed.journeys} />
        </div>
      )}
    </section>
  );
}

function TimelineView({ timeline }: { timeline: AdminDemandFeed["timeline"] }) {
  if (isUnavailable(timeline)) {
    return <UnavailableBlock label="ARRIVAL TIMELINE" reason={timeline.unavailable} testId="ops-demand-timeline-unavailable" />;
  }

  const presentClasses = CLIENT_SOFTWARE_CLASSES.filter((clientClass) =>
    timeline.buckets.some((bucket) => bucket.counts.some((count) => count.clientClass === clientClass && count.count > 0)),
  );
  return (
    <section className="ops-demand-timeline" data-testid="ops-demand-timeline">
      <div className="ops-demand-subhead">
        <h4>PRE-AUTH ARRIVALS</h4>
        <span>{timeline.window.bucketCount} {timeline.window.bucket} buckets · aggregate only</span>
      </div>
      <div className="ops-demand-strips">
        {ARRIVAL_SURFACES.map((surface) => (
          <SurfaceStrip key={surface} surface={surface} timeline={timeline} />
        ))}
      </div>
      <div className="ops-demand-legend" aria-label="Client software classes">
        {presentClasses.length > 0 ? presentClasses.map((clientClass) => (
          <span key={clientClass} data-client={clientClass}>
            <i aria-hidden />{softwareLabel(clientClass)}
          </span>
        )) : <span>no arrivals collected in this window</span>}
      </div>
    </section>
  );
}

function SurfaceStrip({ surface, timeline }: { surface: ArrivalSurface; timeline: ArrivalTimeline }) {
  const totals = timeline.buckets.map((bucket) => bucket.counts
    .filter((count) => count.surface === surface)
    .reduce((sum, count) => sum + count.count, 0));
  const max = Math.max(1, ...totals);
  const surfaceTotal = totals.reduce((sum, count) => sum + count, 0);
  return (
    <div className="ops-demand-strip" data-surface={surface} data-testid={`ops-demand-surface-${surface}`}>
      <span className="ops-demand-strip-label">
        <b>{SURFACE_LABELS[surface]}</b><small>{surfaceTotal}</small>
      </span>
      <span className="ops-demand-bars" aria-label={`${SURFACE_LABELS[surface]} arrivals by ${timeline.window.bucket}`}>
        {timeline.buckets.map((bucket, index) => {
          const counts = bucket.counts.filter((count) => count.surface === surface && count.count > 0);
          const total = totals[index] ?? 0;
          return (
            <span
              className="ops-demand-bar"
              key={`${bucket.start}:${surface}`}
              title={bucketTitle(bucket.start, total, counts)}
              aria-label={bucketTitle(bucket.start, total, counts)}
            >
              {total > 0 ? (
                <i className="ops-demand-bar-stack" style={{ height: `${Math.max(4, (total / max) * 100)}%` }} aria-hidden>
                  {counts.map((count) => (
                    <i
                      key={count.clientClass}
                      data-client={count.clientClass}
                      style={{ height: `${(count.count / total) * 100}%` }}
                    />
                  ))}
                </i>
              ) : null}
            </span>
          );
        })}
      </span>
    </div>
  );
}

function JourneyList({ journeys }: { journeys: AdminDemandFeed["journeys"] }) {
  if (isUnavailable(journeys)) {
    return <UnavailableBlock label="WORKER JOURNEYS" reason={journeys.unavailable} testId="ops-demand-journeys-unavailable" />;
  }
  return (
    <section className="ops-demand-journeys" data-testid="ops-demand-journeys">
      <div className="ops-demand-subhead">
        <h4>RECENT WORKER JOURNEYS</h4>
        <span>{journeys.count} wallet{journeys.count === 1 ? "" : "s"} · shared identity registry</span>
      </div>
      {journeys.journeys.length === 0 ? (
        <p className="ops-demand-empty">no post-SIWE journey recorded in this window</p>
      ) : (
        <div className="ops-demand-journey-list">
          {journeys.journeys.map((journey) => <JourneyRow key={journey.wallet} journey={journey} />)}
        </div>
      )}
    </section>
  );
}

function JourneyRow({ journey }: { journey: WorkerJourney }) {
  return (
    <details className="ops-demand-journey" data-classification={journey.classification} data-testid={`ops-demand-journey-${journey.wallet}`}>
      <summary>
        <span className="ops-demand-wallet" title={journey.wallet}>{shortWallet(journey.wallet)}</span>
        <span className="ops-demand-classification">{journey.classification}</span>
        <span className="ops-demand-journey-depth">{journey.events.length} event{journey.events.length === 1 ? "" : "s"}</span>
        <span className="ops-demand-journey-last">{journey.lastActiveAt ? formatTimestamp(journey.lastActiveAt) : "last activity unavailable"}</span>
      </summary>
      <ol className="ops-demand-events">
        {journey.events.map((event) => (
          <li key={event.id} data-event={event.type}>
            <span className="ops-demand-event-chip">{EVENT_LABELS[event.type] ?? event.type}</span>
            <span className="ops-demand-event-time">
              <time dateTime={event.timestamp}>{formatTimestamp(event.timestamp)}</time>
              {event.durationFromPreviousMs == null ? null : <b>+{formatDuration(event.durationFromPreviousMs)}</b>}
            </span>
            <span className="ops-demand-event-source">{event.sourceStore}</span>
            {event.jobId ? <code title={event.jobId}>{shortId(event.jobId)}</code> : null}
            {event.txHash ? <code title={event.txHash}>tx {shortId(event.txHash)}</code> : null}
          </li>
        ))}
      </ol>
    </details>
  );
}

function UnavailableBlock({ label, reason, testId }: { label: string; reason: string; testId: string }) {
  return (
    <section className="ops-demand-unavailable" data-testid={testId}>
      <strong>{label} UNAVAILABLE</strong>
      <span>{reason}</span>
    </section>
  );
}

function bucketTitle(start: string, total: number, counts: ArrivalTimeline["buckets"][number]["counts"]): string {
  const breakdown = counts.map((count) => `${softwareLabel(count.clientClass)} ${count.count}`).join(", ");
  return `${formatTimestamp(start)} · ${total} arrival${total === 1 ? "" : "s"}${breakdown ? ` · ${breakdown}` : ""}`;
}

function softwareLabel(value: ClientSoftwareClass): string {
  return value.replaceAll("_", " ");
}

function shortWallet(value: string): string {
  return value.length > 16 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value;
}

function shortId(value: string): string {
  return value.length > 20 ? `${value.slice(0, 10)}…${value.slice(-8)}` : value;
}

function formatCutover(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function formatTimestamp(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString(undefined, {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function formatDuration(milliseconds: number): string {
  if (milliseconds < 1_000) return `${Math.round(milliseconds)}ms`;
  if (milliseconds < 60_000) return `${Math.round(milliseconds / 1_000)}s`;
  if (milliseconds < 3_600_000) return `${Math.round(milliseconds / 60_000)}m`;
  if (milliseconds < 86_400_000) return `${(milliseconds / 3_600_000).toFixed(milliseconds < 36_000_000 ? 1 : 0)}h`;
  return `${(milliseconds / 86_400_000).toFixed(1)}d`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
