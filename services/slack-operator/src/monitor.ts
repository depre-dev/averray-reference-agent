export interface MonitorConfig {
  enabled: boolean;
  token?: string;
}

export function parseMonitorConfig(env: NodeJS.ProcessEnv): MonitorConfig {
  return {
    enabled: env.SLACK_OPERATOR_MONITOR_ENABLED === "1",
    token: nonEmpty(env.SLACK_OPERATOR_MONITOR_TOKEN),
  };
}

export function isMonitorAuthorized(
  config: MonitorConfig,
  headers: Record<string, string | string[] | undefined>,
  url: URL
): boolean {
  if (!config.token) return true;
  const authorization = headerValue(headers.authorization);
  if (authorization === `Bearer ${config.token}`) return true;
  return url.searchParams.get("token") === config.token;
}

export interface MonitorCommandGuard {
  allowed: boolean;
  normalizedText: string;
  reason?: string;
}

export function guardMonitorCommand(text: string): MonitorCommandGuard {
  const normalizedText = normalizeMonitorCommandText(text);
  if (!normalizedText) return { allowed: false, normalizedText, reason: "empty_command" };
  if (isBlockedMonitorCommand(normalizedText)) {
    return { allowed: false, normalizedText, reason: "mutation_command_blocked" };
  }
  if (isAllowedMonitorCommand(normalizedText)) return { allowed: true, normalizedText };
  return { allowed: false, normalizedText, reason: "command_not_allowed_from_monitor" };
}

export function normalizeMonitorCommandText(text: string): string {
  return text.trim().toLowerCase().replace(/[.!?]+$/g, "").replace(/\s+/g, " ");
}

function isBlockedMonitorCommand(text: string): boolean {
  return Boolean(
    /\b(approve|execute|merge)\b.*\b(merge steward|github merge steward)\b/.test(text)
    || /\b(merge steward|github merge steward)\b.*\b(approve|execute|merge)\b/.test(text)
    || /\b(merge\s+(pr|#|now)|deploy(?! for)|rollback(?! for)|restart|rotate|set secret|secret set|ssh|claim|submit)\b/.test(text)
    || /\bwikipedia citation repair\b/.test(text)
    || /\b(if safe|live|guarded live|mutation|mutate|write)\b/.test(text)
  );
}

function isAllowedMonitorCommand(text: string): boolean {
  return Boolean(
    /^(handoff monitor|agent handoff monitor|hermes handoff monitor|hermes monitor|what is hermes doing|current handoffs|active handoffs|handoff status)( details?| full| audit)?$/.test(text)
    || /^(github status|github open prs|github ci failures|github issue digest|merge steward|take care of open prs)( details?| full| audit)?$/.test(text)
    || /^(operator status|ops health|business ledger|daily operator brief|find safe work|admin readiness|project memory|known projects|codex handoff protocol)( details?| full| audit)?$/.test(text)
    || /^what (can|should) (i|we) do next( details?| full| audit)?$/.test(text)
    || /^what is happening now( details?| full| audit)?$/.test(text)
    || /^what is (codex|hermes) doing( right now)?( details?| full| audit)?$/.test(text)
    || /^what needs my action( details?| full| audit)?$/.test(text)
    || /^what can you do for us( details?| full| audit)?$/.test(text)
    || /^(how do we deploy|runbook for|secret rotation runbook)( .*)?$/.test(text)
    || /^propose (merge|deploy|secret rotation|rollback)\b/.test(text)
    || /^run testbed e2e read[ -]?only( details?| full| audit)?$/.test(text)
  );
}

// Inline SVG used for the PWA icon and apple-touch-icon. The brand mark
// is the same wedge that appears in the topbar — render once, ship as a
// data URL so we don't add another HTTP round-trip and don't need a
// favicon hosting setup.
const MONITOR_BRAND_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#0c1713"/><path d="M16 50 L32 14 L48 50 L32 36 Z" fill="none" stroke="#d89a2b" stroke-width="3.2" stroke-linejoin="round"/><circle cx="32" cy="38" r="3.4" fill="#d89a2b"/></svg>`;

function svgDataUrl(svg: string): string {
  return "data:image/svg+xml;utf8," + encodeURIComponent(svg);
}

/**
 * Web App Manifest served at `/monitor/manifest.webmanifest`. Lets the
 * monitor install as a PWA on mobile (Add to Home Screen on iOS Safari,
 * the install prompt on Chrome) so on-call operators get a fast launch
 * point. Same origin as `/monitor`, same auth boundary.
 */
export function renderMonitorManifest(options: { name?: string; shortName?: string } = {}): string {
  const name = options.name ?? "Hermes Handoff Monitor";
  const shortName = options.shortName ?? "Hermes";
  return JSON.stringify(
    {
      name,
      short_name: shortName,
      description: "On-call view of the Averray PR handoff pipeline.",
      start_url: "/monitor",
      scope: "/monitor",
      display: "standalone",
      orientation: "portrait",
      background_color: "#050d0b",
      theme_color: "#0c1713",
      icons: [
        { src: svgDataUrl(MONITOR_BRAND_SVG), sizes: "any", type: "image/svg+xml", purpose: "any" },
        { src: svgDataUrl(MONITOR_BRAND_SVG), sizes: "any", type: "image/svg+xml", purpose: "maskable" },
      ],
    },
    null,
    2,
  );
}

export function renderMonitorHtml(options: { title?: string; eventsPath?: string; streamPath?: string; commandPath?: string; codexTasksPath?: string; recheckPath?: string; collaborationPath?: string; manifestPath?: string } = {}): string {
  const title = escapeHtml(options.title ?? "Hermes Handoff Monitor");
  const eventsPath = JSON.stringify(options.eventsPath ?? "/monitor/events");
  const streamPath = JSON.stringify(options.streamPath ?? "/monitor/stream");
  const commandPath = JSON.stringify(options.commandPath ?? "/monitor/command");
  const codexTasksPath = JSON.stringify(options.codexTasksPath ?? "/monitor/codex-tasks");
  const recheckPath = JSON.stringify(options.recheckPath ?? "/monitor/recheck");
  const collaborationPath = JSON.stringify(options.collaborationPath ?? "/monitor/collaboration");
  const manifestPath = options.manifestPath ?? "/monitor/manifest.webmanifest";
  const brandIcon = svgDataUrl(MONITOR_BRAND_SVG);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="theme-color" content="#0c1713">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <meta name="apple-mobile-web-app-title" content="Hermes">
  <link rel="manifest" href="${manifestPath}">
  <link rel="icon" type="image/svg+xml" href="${brandIcon}">
  <link rel="apple-touch-icon" href="${brandIcon}">
  <title>${title}</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #050d0b;
      --panel: #0c1713;
      --panel-2: #101f19;
      --surface: rgba(11, 24, 19, 0.92);
      --surface-soft: rgba(10, 22, 18, 0.72);
      --surface-strong: rgba(16, 31, 25, 0.96);
      --line: #29473d;
      --line-soft: rgba(84, 121, 108, 0.28);
      --text: #f3ead7;
      --cream: #f3ead7;
      --muted: #8d9b91;
      --faint: #5f7169;
      --accent: #d89a2b;
      --amber: #d9ad42;
      --ok: #63c789;
      --bad: #ee6260;
      --warn: #d9ad42;
      --cyan: #56cce4;
      --violet: #928eff;
      --ok-bg: rgba(99, 199, 137, 0.12);
      --bad-bg: rgba(238, 98, 96, 0.12);
      --warn-bg: rgba(217, 173, 66, 0.12);
      --accent-bg: rgba(216, 154, 43, 0.12);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background:
        radial-gradient(circle at top left, rgba(24, 49, 40, 0.82), transparent 31rem),
        linear-gradient(90deg, #06110e, var(--bg) 38rem);
      color: var(--text);
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    main {
      width: min(1180px, calc(100vw - 32px));
      margin: 24px auto 48px;
    }
    header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 16px;
      margin-bottom: 18px;
    }
    h1 {
      margin: 0 0 6px;
      font-size: clamp(1.5rem, 2vw, 2rem);
      letter-spacing: 0;
    }
    p { color: var(--muted); margin: 0; }
    .live-status {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      margin-left: 8px;
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 2px 8px;
      color: var(--muted);
      font-size: 0.78rem;
      white-space: nowrap;
    }
    .live-status::before {
      content: "";
      width: 7px;
      height: 7px;
      border-radius: 999px;
      background: var(--warn);
    }
    .live-status[data-state="live"]::before { background: var(--ok); }
    .live-status[data-state="polling"]::before { background: #64d2ff; }
    .live-status[data-state="error"]::before { background: var(--bad); }
    button {
      min-height: 38px;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: var(--panel-2);
      color: var(--text);
      padding: 0 14px;
      cursor: pointer;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(5, minmax(0, 1fr));
      gap: 12px;
      margin-bottom: 16px;
    }
    .card {
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--surface);
      padding: 14px;
      box-shadow: 0 14px 48px rgba(0, 0, 0, 0.24);
    }
    .metric {
      color: var(--muted);
      font-size: 0.78rem;
      text-transform: uppercase;
      letter-spacing: 0.12em;
    }
    .value {
      display: block;
      margin-top: 8px;
      font-size: 1.6rem;
      font-weight: 700;
    }
    .section-title {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      margin: 22px 0 10px;
    }
    .section-title h2 {
      margin: 0;
      font-size: 1rem;
      text-transform: uppercase;
      letter-spacing: 0.12em;
    }
    .list {
      display: grid;
      gap: 10px;
    }
    .handoff {
      border: 1px solid var(--line);
      border-left: 5px solid var(--accent);
      border-radius: 8px;
      background: rgba(10, 48, 44, 0.92);
      padding: 14px;
    }
    .handoff[data-status="completed"],
    .handoff[data-status="passed"],
    .handoff[data-verdict="pass"] { border-left-color: var(--ok); }
    .handoff[data-status="failed"],
    .handoff[data-status="blocked"],
    .handoff[data-verdict="block"] { border-left-color: var(--bad); }
    .handoff[data-status="needs_review"],
    .handoff[data-verdict="needs-review"] { border-left-color: var(--warn); }
    .handoff[data-verdict="running"] { border-left-color: var(--accent); }
    .handoff-why {
      margin: 0 0 12px;
      color: var(--text);
      line-height: 1.4;
    }
    .tags {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin: 0 0 12px;
    }
    .pipeline-list {
      display: grid;
      gap: 10px;
    }
    .repo-group {
      display: grid;
      gap: 10px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: rgba(10, 48, 44, 0.5);
      padding: 12px;
    }
    .repo-head {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 12px;
    }
    .repo-title {
      min-width: 0;
      font-weight: 700;
      overflow-wrap: anywhere;
    }
    .repo-summary {
      display: flex;
      flex-wrap: wrap;
      justify-content: flex-end;
      gap: 6px;
    }
    .repo-empty {
      color: var(--muted);
      border: 1px dashed var(--line);
      border-radius: 8px;
      padding: 16px;
      text-align: center;
    }
    .repo-history-label {
      color: var(--muted);
      font-size: 0.78rem;
      text-transform: uppercase;
      letter-spacing: 0.1em;
    }
    .pr-board {
      display: grid;
      grid-template-columns: repeat(5, minmax(0, 1fr));
      gap: 10px;
      margin-bottom: 14px;
    }
    .filter-button {
      min-height: 58px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: rgba(10, 48, 44, 0.86);
      color: var(--text);
      padding: 10px 12px;
      text-align: left;
    }
    .filter-button[aria-pressed="true"] {
      border-color: var(--accent);
      background: var(--accent-bg);
    }
    .filter-label {
      color: var(--muted);
      font-size: 0.78rem;
      text-transform: uppercase;
      letter-spacing: 0.1em;
    }
    .filter-count {
      font-size: 1.35rem;
      font-weight: 700;
    }
    .staleness-summary {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 10px;
      margin-bottom: 14px;
    }
    .staleness-card {
      border: 1px solid var(--line);
      border-radius: 8px;
      background: rgba(10, 48, 44, 0.7);
      padding: 12px;
    }
    .staleness-card[data-age="stale"] {
      border-color: var(--bad);
      background: var(--bad-bg);
    }
    .staleness-card[data-age="waiting"] {
      border-color: var(--warn);
      background: var(--warn-bg);
    }
    .age-label {
      display: block;
      color: var(--muted);
      font-size: 0.78rem;
      text-transform: uppercase;
      letter-spacing: 0.1em;
    }
    .age-count {
      display: block;
      margin-top: 6px;
      font-size: 1.35rem;
      font-weight: 700;
    }
    .owner-summary {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 10px;
      margin-bottom: 14px;
    }
    .owner-card {
      border: 1px solid var(--line);
      border-radius: 8px;
      background: rgba(10, 48, 44, 0.7);
      padding: 12px;
    }
    .owner-label {
      display: block;
      color: var(--muted);
      font-size: 0.78rem;
      text-transform: uppercase;
      letter-spacing: 0.1em;
    }
    .owner-count {
      display: block;
      margin-top: 6px;
      font-size: 1.35rem;
      font-weight: 700;
    }
    .owner-lanes {
      display: grid;
      grid-template-columns: repeat(5, minmax(0, 1fr));
      gap: 10px;
      align-items: start;
    }
    .owner-lane {
      display: grid;
      gap: 8px;
      min-width: 0;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: rgba(10, 48, 44, 0.5);
      padding: 10px;
    }
    .owner-lane-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      min-height: 28px;
    }
    .owner-lane-title {
      font-weight: 700;
      overflow-wrap: anywhere;
    }
    .owner-lane-items {
      display: grid;
      gap: 8px;
    }
    .owner-lane-empty {
      color: var(--muted);
      border: 1px dashed var(--line);
      border-radius: 8px;
      padding: 14px 10px;
      text-align: center;
      font-size: 0.9rem;
    }
    .lane-card {
      display: grid;
      gap: 8px;
      border: 1px solid var(--line);
      border-left: 4px solid var(--accent);
      border-radius: 8px;
      background: rgba(10, 48, 44, 0.86);
      padding: 10px;
    }
    .lane-card[data-verdict="pass"] { border-left-color: var(--ok); }
    .lane-card[data-verdict="block"] { border-left-color: var(--bad); }
    .lane-card[data-verdict="needs-review"] { border-left-color: var(--warn); }
    .lane-card[data-verdict="running"] { border-left-color: var(--accent); }
    .lane-card-title {
      font-weight: 700;
      overflow-wrap: anywhere;
    }
    .lane-card-meta,
    .lane-card-action {
      color: var(--muted);
      font-size: 0.9rem;
      line-height: 1.35;
    }
    .phase-badges {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin: 0;
    }
    .pipeline-card {
      border: 1px solid var(--line);
      border-left: 5px solid var(--accent);
      border-radius: 8px;
      background: rgba(10, 48, 44, 0.92);
      padding: 14px;
    }
    .pipeline-card[data-verdict="pass"] { border-left-color: var(--ok); }
    .pipeline-card[data-verdict="block"] { border-left-color: var(--bad); }
    .pipeline-card[data-verdict="needs-review"] { border-left-color: var(--warn); }
    .pipeline-card[data-verdict="running"] { border-left-color: var(--accent); }
    .pipeline-card[data-age="stale"] {
      border-color: var(--bad);
      box-shadow: 0 0 0 1px rgba(255, 107, 107, 0.22);
    }
    .pipeline-card[data-age="waiting"] {
      box-shadow: 0 0 0 1px rgba(255, 209, 102, 0.16);
    }
    .pipeline-head {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 10px;
    }
    .pipeline-title {
      min-width: 0;
      font-weight: 700;
      overflow-wrap: anywhere;
    }
    .pipeline-why {
      margin: 0 0 12px;
      color: var(--text);
      line-height: 1.4;
    }
    .next-action {
      border: 1px solid var(--line);
      border-radius: 8px;
      background: rgba(255, 255, 255, 0.04);
      padding: 10px 12px;
      margin-bottom: 12px;
      line-height: 1.4;
    }
    .next-action strong {
      color: var(--text);
    }
    .fix-request {
      border: 1px solid var(--line);
      border-left: 5px solid var(--warn);
      border-radius: 8px;
      background: rgba(255, 255, 255, 0.04);
      padding: 12px;
      margin-bottom: 12px;
    }
    .fix-request[data-level="block"] {
      border-left-color: var(--bad);
      background: var(--bad-bg);
    }
    .fix-request[data-level="needs-review"] {
      border-left-color: var(--warn);
      background: var(--warn-bg);
    }
    .block-resolution {
      border-left: 4px solid var(--bad);
    }
    .resolution-summary {
      margin: 0;
      color: var(--text);
      line-height: 1.42;
    }
    .resolution-grid {
      display: grid;
      grid-template-columns: 118px minmax(0, 1fr);
      gap: 7px 10px;
      margin: 10px 0;
    }
    .resolution-grid dt {
      color: var(--muted);
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.62rem;
      letter-spacing: 0.1em;
      text-transform: uppercase;
    }
    .resolution-grid dd {
      margin: 0;
      overflow-wrap: anywhere;
    }
    .resolution-steps {
      display: grid;
      gap: 8px;
      margin: 10px 0 0;
      padding-left: 20px;
    }
    .resolution-steps li {
      color: var(--text);
      line-height: 1.35;
    }
    .resolution-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 12px;
    }
    .operator-decision {
      border-left: 4px solid var(--warn);
    }
    .operator-brief {
      display: grid;
      gap: 10px;
    }
    .operator-brief-line {
      margin: 0;
      color: var(--text);
      line-height: 1.42;
    }
    .operator-evidence {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px;
    }
    .operator-evidence-item {
      border: 1px solid var(--line-soft);
      border-radius: 7px;
      background: rgba(255, 255, 255, 0.025);
      padding: 8px;
    }
    .operator-evidence-label {
      display: block;
      color: var(--muted);
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.62rem;
      letter-spacing: 0.1em;
      text-transform: uppercase;
    }
    .operator-evidence-value {
      display: block;
      margin-top: 4px;
      color: var(--text);
      overflow-wrap: anywhere;
    }
    .operator-checklist {
      display: grid;
      gap: 7px;
      margin: 0;
      padding: 0;
      list-style: none;
    }
    .operator-checklist li {
      display: grid;
      grid-template-columns: 14px minmax(0, 1fr);
      gap: 8px;
      color: var(--text);
      line-height: 1.35;
    }
    .operator-checklist li::before {
      content: "";
      width: 10px;
      height: 10px;
      margin-top: 4px;
      border: 1px solid var(--warn);
      border-radius: 3px;
      background: rgba(217, 173, 66, 0.1);
    }
    .fix-request-title {
      margin: 0 0 8px;
      font-weight: 700;
    }
    .fix-request-copy {
      margin: 0 0 10px;
      line-height: 1.4;
    }
    .fix-request-meta {
      display: grid;
      grid-template-columns: 130px minmax(0, 1fr);
      gap: 6px 10px;
      margin: 0;
    }
    .fix-request-meta dt {
      color: var(--muted);
      font-size: 0.78rem;
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }
    .fix-request-meta dd {
      margin: 0;
      overflow-wrap: anywhere;
    }
    .decision-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 10px;
    }
    .decision-button {
      min-height: 32px;
      border-radius: 6px;
      padding: 0 10px;
      font-size: 0.82rem;
    }
    .decision-button[data-monitor-decision="approve"] {
      border-color: var(--ok);
      background: var(--ok-bg);
      color: var(--ok);
    }
    .decision-note {
      border: 1px solid var(--ok);
      border-radius: 8px;
      background: var(--ok-bg);
      padding: 10px 12px;
      margin-bottom: 12px;
      line-height: 1.4;
    }
    .age-line {
      color: var(--muted);
      margin: -4px 0 12px;
      line-height: 1.4;
    }
    .age-line[data-age="stale"] { color: var(--bad); }
    .age-line[data-age="waiting"] { color: var(--warn); }
    .pipeline-steps {
      display: grid;
      grid-template-columns: repeat(6, minmax(0, 1fr));
      gap: 6px;
      margin-bottom: 12px;
    }
    .pipeline-step {
      min-height: 30px;
      border: 1px solid var(--line);
      border-radius: 999px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 4px 8px;
      color: var(--muted);
      background: rgba(255, 255, 255, 0.04);
      font-size: 0.78rem;
      white-space: nowrap;
    }
    .pipeline-step[data-state="done"] {
      border-color: var(--ok);
      color: var(--ok);
      background: var(--ok-bg);
    }
    .pipeline-step[data-state="active"] {
      border-color: var(--accent);
      color: var(--accent);
      background: var(--accent-bg);
      font-weight: 700;
    }
    .pipeline-step[data-state="blocked"] {
      border-color: var(--bad);
      color: var(--bad);
      background: var(--bad-bg);
      font-weight: 700;
    }
    .pipeline-step[data-state="review"] {
      border-color: var(--warn);
      color: var(--warn);
      background: var(--warn-bg);
      font-weight: 700;
    }
    .pr-timeline {
      display: grid;
      grid-template-columns: repeat(6, minmax(0, 1fr));
      gap: 6px;
      margin-bottom: 12px;
    }
    .pr-timeline-item {
      min-width: 0;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: rgba(255, 255, 255, 0.04);
      padding: 8px;
    }
    .pr-timeline-item[data-state="done"] {
      border-color: var(--ok);
      background: var(--ok-bg);
    }
    .pr-timeline-item[data-state="active"] {
      border-color: var(--accent);
      background: var(--accent-bg);
    }
    .pr-timeline-item[data-state="blocked"] {
      border-color: var(--bad);
      background: var(--bad-bg);
    }
    .pr-timeline-item[data-state="review"] {
      border-color: var(--warn);
      background: var(--warn-bg);
    }
    .pr-timeline-label {
      display: block;
      font-size: 0.78rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }
    .pr-timeline-meta {
      display: block;
      margin-top: 4px;
      color: var(--muted);
      font-size: 0.78rem;
      line-height: 1.3;
      overflow-wrap: anywhere;
    }
    .pipeline-meta {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 8px 12px;
      margin: 0;
    }
    .pipeline-meta dt {
      color: var(--muted);
      font-size: 0.78rem;
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }
    .pipeline-meta dd {
      margin: 2px 0 0;
      overflow-wrap: anywhere;
    }
    .pipeline-detail-title {
      margin: 12px 0 8px;
      color: var(--muted);
      font-size: 0.78rem;
      text-transform: uppercase;
      letter-spacing: 0.1em;
    }
    .pipeline-detail {
      display: grid;
      grid-template-columns: 170px minmax(0, 1fr);
      gap: 8px 12px;
      margin: 0;
      border-top: 1px solid var(--line);
      padding-top: 12px;
    }
    .pipeline-detail dt {
      color: var(--muted);
      font-size: 0.78rem;
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }
    .pipeline-detail dd {
      margin: 0;
      overflow-wrap: anywhere;
    }
    .pipeline-links {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-top: 12px;
    }
    .handoff-head {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 10px;
    }
    .handoff-title {
      min-width: 0;
      font-weight: 700;
      overflow-wrap: anywhere;
    }
    .pill {
      display: inline-flex;
      align-items: center;
      min-height: 22px;
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 2px 7px;
      color: var(--text);
      background: rgba(255, 255, 255, 0.035);
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.72rem;
      white-space: nowrap;
    }
    .state-pill {
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .state-pill[data-level="pass"] {
      border-color: var(--ok);
      background: var(--ok-bg);
      color: var(--ok);
    }
    .state-pill[data-level="block"] {
      border-color: var(--bad);
      background: var(--bad-bg);
      color: var(--bad);
    }
    .state-pill[data-level="needs-review"] {
      border-color: var(--warn);
      background: var(--warn-bg);
      color: var(--warn);
    }
    .state-pill[data-level="running"] {
      border-color: var(--accent);
      background: var(--accent-bg);
      color: var(--accent);
    }
    dl {
      display: grid;
      grid-template-columns: 150px minmax(0, 1fr);
      gap: 8px 12px;
      margin: 0;
    }
    dt { color: var(--muted); }
    dd {
      margin: 0;
      overflow-wrap: anywhere;
    }
    code {
      border: 1px solid var(--line);
      border-radius: 5px;
      padding: 1px 5px;
      background: rgba(255, 255, 255, 0.035);
      color: var(--text);
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.72rem;
    }
    a { color: var(--accent); }
    .empty {
      color: var(--muted);
      border: 1px dashed var(--line);
      border-radius: 8px;
      padding: 22px;
      text-align: center;
    }
    .error {
      border-color: var(--bad);
      color: var(--bad);
    }
    .command-shell {
      width: 100vw;
      height: 100vh;
      min-width: 0;
      display: grid;
      grid-template-rows: auto auto minmax(0, 1fr) auto;
      overflow: hidden;
      background:
        radial-gradient(1200px 560px at 12% -18%, rgba(73, 114, 97, 0.13), transparent 58%),
        linear-gradient(90deg, rgba(15, 34, 27, 0.96) 0, rgba(5, 13, 11, 0.98) 24rem, #050d0b 100%),
        var(--bg);
    }
    .cmdbar {
      display: grid;
      grid-template-columns: minmax(210px, 0.72fr) minmax(0, 1.45fr) minmax(250px, auto);
      align-items: center;
      gap: 18px;
      padding: 10px 18px;
      border-bottom: 1px solid var(--line-soft);
      background: rgba(3, 12, 10, 0.94);
      backdrop-filter: blur(10px);
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 10px;
      min-width: 0;
    }
    .brand-mark {
      width: 32px;
      height: 32px;
      display: grid;
      place-items: center;
      border-radius: 7px;
      border: 1px solid var(--line);
      color: var(--accent);
      background: rgba(216, 154, 43, 0.08);
      font-weight: 800;
    }
    .brand-name {
      font-size: 0.9rem;
      font-weight: 700;
      line-height: 1;
    }
    .brand-sub {
      margin-top: 4px;
      color: var(--muted);
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.62rem;
      text-transform: uppercase;
      letter-spacing: 0.12em;
    }
    .cmd-status {
      display: inline-flex;
      align-items: center;
      justify-self: center;
      gap: 8px;
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 6px 10px;
      color: var(--text);
      background: var(--surface-soft);
      white-space: nowrap;
    }
    .cmd-status::before {
      content: "";
      width: 7px;
      height: 7px;
      border-radius: 999px;
      background: var(--warn);
      box-shadow: 0 0 0 0 rgba(255, 209, 102, 0.55);
    }
    .cmd-status[data-state="live"]::before {
      background: var(--ok);
      animation: pulse 1.8s ease-out infinite;
    }
    .cmd-status[data-state="polling"]::before,
    .cmd-status[data-state="connecting"]::before { background: #64d2ff; }
    .cmd-status[data-state="error"]::before { background: var(--bad); }
    @keyframes pulse {
      0% { box-shadow: 0 0 0 0 rgba(82, 210, 115, 0.5); }
      70% { box-shadow: 0 0 0 9px rgba(82, 210, 115, 0); }
      100% { box-shadow: 0 0 0 0 rgba(82, 210, 115, 0); }
    }
    .cmd-counters {
      display: flex;
      align-items: center;
      gap: 8px;
      justify-content: center;
      min-width: 0;
      flex-wrap: wrap;
    }
    .counter-chip {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      height: 30px;
      padding: 0 10px;
      border: 1px solid var(--line);
      border-radius: 7px;
      background: var(--surface-soft);
      white-space: nowrap;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      line-height: 1;
    }
    .counter-chip[data-tone="warn"] {
      border-color: rgba(255, 209, 102, 0.66);
      background: rgba(255, 209, 102, 0.1);
    }
    .counter-chip[data-tone="bad"] {
      border-color: rgba(255, 107, 107, 0.68);
      background: rgba(255, 107, 107, 0.1);
    }
    .counter-chip[data-tone="ok"] {
      border-color: rgba(82, 210, 115, 0.62);
      background: rgba(82, 210, 115, 0.1);
    }
    .counter-number {
      display: inline-flex;
      align-items: center;
      color: var(--text);
      font-weight: 800;
      font-size: 0.92rem;
      line-height: 1;
    }
    .counter-label {
      display: inline-flex;
      align-items: center;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.08em;
      font-size: 0.62rem;
      line-height: 1;
      padding-top: 1px; /* nudges small caps onto the visual midline */
    }
    .refresh-cluster {
      display: flex;
      align-items: center;
      gap: 10px;
      justify-content: flex-end;
    }
    .refresh-meta {
      display: grid;
      gap: 2px;
      text-align: right;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.68rem;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.06em;
    }
    .filterbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 14px;
      min-width: 0;
      padding: 8px 18px;
      border-bottom: 1px solid var(--line-soft);
      background: rgba(4, 13, 11, 0.78);
    }
    .filter-left,
    .filter-right {
      display: flex;
      align-items: center;
      gap: 10px;
      min-width: 0;
    }
    .fb-pill-group {
      display: flex;
      align-items: center;
      gap: 6px;
      min-width: 0;
      white-space: nowrap;
    }
    .monitor-search {
      width: min(320px, 32vw);
      min-height: 34px;
      border: 1px solid var(--line);
      border-radius: 7px;
      color: var(--text);
      background: var(--surface-soft);
      padding: 0 12px;
      outline: none;
    }
    .monitor-search::placeholder { color: var(--muted); }
    .toggle-pill {
      min-height: 32px;
      padding: 0 10px;
      border-radius: 7px;
      font-size: 0.78rem;
      background: var(--surface-soft);
    }
    .toggle-pill[aria-pressed="true"] {
      border-color: var(--accent);
      background: var(--accent-bg);
    }
    .board-shell {
      min-height: 0;
      min-width: 0;
      display: grid;
      grid-template-rows: auto auto minmax(0, 1fr);
      gap: 12px;
      /* The bottom collaboration dock is fixed-positioned and claims a
         substantial chunk of viewport height (see .command-console
         min-height below). Reserve enough room here so content scrolled
         to the bottom of the board never hides behind the dock. */
      padding: 12px 14px min(56vh, 560px);
      overflow: hidden;
    }
    .live-lane {
      display: grid;
      grid-template-columns: auto 1fr auto;
      align-items: center;
      gap: 12px;
      min-height: 42px;
      border: 1px dashed var(--line);
      border-radius: 10px;
      color: var(--muted);
      background: rgba(12, 24, 19, 0.46);
      padding: 8px 12px;
    }
    .live-lane strong {
      color: var(--text);
      text-transform: uppercase;
      letter-spacing: 0.12em;
      font-size: 0.74rem;
    }
    .agent-activity {
      display: grid;
      grid-template-columns: minmax(260px, 1fr) minmax(260px, 1fr) minmax(320px, 1.1fr);
      gap: 10px;
      min-width: 0;
    }
    .agent-status-card,
    .handoff-radar {
      min-width: 0;
      border: 1px solid var(--line);
      border-radius: 10px;
      background: rgba(12, 24, 19, 0.62);
      box-shadow: inset 0 1px rgba(255, 255, 255, 0.025);
    }
    .agent-status-card {
      display: grid;
      gap: 9px;
      padding: 10px 12px;
      border-left: 3px solid var(--muted);
    }
    .agent-status-card[data-agent="codex"] { --agent-color: var(--violet); }
    .agent-status-card[data-agent="hermes"] { --agent-color: var(--cyan); }
    .agent-status-card[data-state="active"],
    .agent-status-card[data-state="waiting"] {
      border-left-color: var(--agent-color);
    }
    .agent-status-card[data-state="idle"] {
      opacity: 0.78;
    }
    .agent-status-head,
    .handoff-radar-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      min-width: 0;
    }
    .agent-status-title {
      display: flex;
      align-items: center;
      gap: 7px;
      min-width: 0;
      color: var(--cream);
      font-size: 0.86rem;
      font-weight: 800;
    }
    .agent-status-title::before {
      content: "";
      width: 7px;
      height: 7px;
      flex: 0 0 auto;
      border-radius: 999px;
      background: var(--muted);
    }
    .agent-status-card[data-state="active"] .agent-status-title::before {
      background: var(--agent-color);
      box-shadow: 0 0 0 4px color-mix(in srgb, var(--agent-color) 18%, transparent);
      animation: pulse 1.8s ease-out infinite;
    }
    .agent-status-card[data-state="waiting"] .agent-status-title::before {
      background: var(--agent-color);
    }
    .agent-status-state {
      flex: 0 0 auto;
      color: var(--muted);
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.62rem;
      letter-spacing: 0.1em;
      text-transform: uppercase;
    }
    .agent-status-card[data-state="active"] .agent-status-state { color: var(--agent-color); }
    .agent-status-card[data-state="waiting"] .agent-status-state { color: var(--amber); }
    .agent-status-line {
      min-width: 0;
      color: var(--text);
      font-size: 0.78rem;
      line-height: 1.35;
    }
    .agent-status-line strong {
      color: var(--cream);
    }
    .agent-status-focus {
      display: grid;
      gap: 4px;
      padding: 8px;
      border: 1px solid rgba(122, 174, 151, 0.16);
      border-radius: 8px;
      background: rgba(0, 0, 0, 0.13);
      color: var(--text);
      font-size: 0.76rem;
      line-height: 1.35;
    }
    .agent-status-focus strong {
      color: var(--muted);
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.58rem;
      letter-spacing: 0.11em;
      text-transform: uppercase;
    }
    .agent-status-grid {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 6px;
    }
    .agent-mini {
      display: grid;
      gap: 3px;
      min-width: 0;
      padding: 7px;
      border: 1px solid rgba(122, 174, 151, 0.12);
      border-radius: 7px;
      background: rgba(0, 0, 0, 0.1);
    }
    .agent-mini span {
      color: var(--muted);
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.55rem;
      letter-spacing: 0.1em;
      text-transform: uppercase;
    }
    .agent-mini strong {
      min-width: 0;
      color: var(--text);
      font-size: 0.7rem;
      line-height: 1.25;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .agent-status-meta {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
      min-width: 0;
    }
    .handoff-radar {
      display: grid;
      grid-template-rows: auto minmax(0, 1fr);
      gap: 6px;
      padding: 10px 12px;
    }
    .handoff-radar-head strong {
      color: var(--cream);
      font-size: 0.84rem;
    }
    .handoff-radar-head span {
      color: var(--muted);
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.62rem;
      letter-spacing: 0.1em;
      text-transform: uppercase;
    }
    .handoff-radar-list {
      display: grid;
      gap: 6px;
      min-width: 0;
      margin: 0;
      padding: 0;
      list-style: none;
    }
    .handoff-radar-list li {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr) auto;
      align-items: start;
      gap: 8px;
      min-width: 0;
      color: var(--text);
      font-size: 0.73rem;
      padding: 6px 0;
      border-bottom: 1px solid rgba(122, 174, 151, 0.08);
    }
    .handoff-radar-list li:last-child {
      border-bottom: none;
    }
    .activity-dot {
      width: 7px;
      height: 7px;
      margin-top: 5px;
      border-radius: 999px;
      background: var(--muted);
    }
    .handoff-radar-list li[data-owner="Codex"] .activity-dot { background: var(--violet); }
    .handoff-radar-list li[data-owner="Hermes"] .activity-dot { background: var(--cyan); }
    .handoff-radar-list li[data-owner="Operator"] .activity-dot { background: var(--amber); }
    .handoff-radar-list li[data-owner="Merge queue"] .activity-dot { background: var(--ok); }
    .radar-main {
      min-width: 0;
      display: grid;
      gap: 2px;
    }
    .radar-main strong {
      color: var(--cream);
      font-weight: 800;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .radar-main span {
      color: var(--muted);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .radar-age {
      color: var(--muted);
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.62rem;
      white-space: nowrap;
    }
    .kanban-board {
      min-height: 0;
      min-width: 0;
      display: grid;
      grid-template-columns:
        minmax(190px, 1.08fr)
        minmax(186px, 1fr)
        minmax(186px, 1fr)
        minmax(190px, 1fr)
        minmax(190px, 1fr)
        minmax(186px, 0.96fr)
        56px;
      gap: 12px;
      overflow-x: hidden;
      overflow-y: hidden;
      align-items: stretch;
      padding-bottom: 8px;
    }
    .kanban-board[data-done-expanded="true"] {
      grid-template-columns: repeat(7, minmax(220px, 1fr));
      overflow-x: auto;
    }
    .lane {
      min-height: 0;
      min-width: 0;
      display: grid;
      grid-template-rows: auto minmax(0, 1fr);
      border: 1px solid rgba(77, 118, 111, 0.5);
      border-radius: 10px;
      background: rgba(4, 12, 10, 0.74);
      overflow: hidden;
      --lane-accent: var(--muted);
    }
    .lane[data-lane="attention"] { --lane-accent: var(--bad); }
    .lane[data-lane="codex"] { --lane-accent: var(--violet); }
    .lane[data-lane="hermes"],
    .lane[data-lane="deploy"] { --lane-accent: var(--cyan); }
    .lane[data-lane="operator"] { --lane-accent: var(--warn); }
    .lane[data-lane="queue"] { --lane-accent: var(--ok); }
    .lane[data-lane="done"] { --lane-accent: #6da58e; }
    .lane-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      min-width: 0;
      min-height: 44px;
      border-bottom: 1px solid var(--line-soft);
      border-top: 2px solid var(--lane-accent);
      padding: 10px 12px;
      background: rgba(12, 24, 19, 0.84);
    }
    .lane-title {
      display: flex;
      align-items: center;
      gap: 8px;
      font-weight: 800;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .lane-title::before {
      content: "";
      width: 7px;
      height: 7px;
      border-radius: 999px;
      background: var(--lane-accent);
    }
    .lane-subtitle {
      color: var(--muted);
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.62rem;
      text-transform: uppercase;
      letter-spacing: 0.1em;
      white-space: nowrap;
    }
    .lane-body {
      min-height: 0;
      min-width: 0;
      overflow-y: auto;
      display: grid;
      align-content: start;
      gap: 10px;
      padding: 10px;
      scrollbar-width: thin;
      scrollbar-color: var(--line) transparent;
    }
    .lane-empty {
      min-height: 84px;
      display: grid;
      place-items: center;
      border: 1px dashed var(--line);
      border-radius: 8px;
      color: var(--muted);
      text-align: center;
      padding: 12px;
      font-size: 0.86rem;
    }
    .handoff-card {
      position: relative;
      display: grid;
      gap: 8px;
      min-width: 0;
      border: 1px solid var(--line);
      border-left: 3px solid var(--verdict-accent, var(--lane-accent));
      border-radius: 8px;
      background: var(--surface-strong);
      box-shadow: 0 10px 28px rgba(0, 0, 0, 0.24);
      padding: 10px;
      cursor: pointer;
      text-align: left;
      color: var(--text);
      transition: transform 0.14s ease, border-color 0.14s ease, opacity 0.14s ease;
    }
    .handoff-card[data-verdict="block"]        { --verdict-accent: var(--bad); }
    .handoff-card[data-verdict="needs-review"] { --verdict-accent: var(--warn); }
    .handoff-card[data-verdict="running"]      { --verdict-accent: var(--cyan); }
    .handoff-card[data-verdict="pass"]         { --verdict-accent: var(--ok); }
    .handoff-card:hover,
    .handoff-card[data-selected="true"] {
      transform: translateY(-1px);
      border-color: var(--verdict-accent, var(--lane-accent));
    }
    .command-shell.has-selection .handoff-card:not([data-selected="true"]) {
      opacity: 0.42;
    }
    .card-head,
    .card-foot,
    .card-meta-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      min-width: 0;
    }
    .card-head > *,
    .card-foot > *,
    .card-meta-row > * {
      min-width: 0;
    }
    .card-title {
      margin: 0;
      font-size: 0.9rem;
      line-height: 1.25;
      font-weight: 800;
      overflow-wrap: anywhere;
    }
    .card-subtitle,
    .card-why,
    .card-next {
      color: var(--muted);
      font-size: 0.78rem;
      line-height: 1.35;
    }
    .card-why {
      color: var(--text);
      display: -webkit-box;
      -webkit-line-clamp: 3;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }
    .mini-steps {
      display: grid;
      grid-template-columns: repeat(6, minmax(0, 1fr));
      gap: 4px;
    }
    .mini-step {
      height: 4px;
      border-radius: 999px;
      background: rgba(167, 181, 170, 0.28);
    }
    .mini-step[data-state="done"] { background: var(--ok); }
    .mini-step[data-state="active"] { background: var(--cyan); }
    .mini-step[data-state="review"] { background: var(--warn); }
    .mini-step[data-state="blocked"] { background: var(--bad); }
    .card-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      justify-content: flex-end;
    }
    /* Done-rail: the collapsed Done lane lives as a vertical 56px rail on
       the right edge of the kanban board. Clicking it toggles into the
       expanded Done lane view (showDone=true), which uses the .done-row
       compact row layout below. Width was bumped from 44px so the
       horizontal count pill + vertical DONE label have room to breathe. */
    .done-rail {
      min-width: 56px;
      width: 56px;
      cursor: pointer;
      border-style: dashed;
      background: rgba(2, 15, 13, 0.5);
      transition: background 120ms ease, border-color 120ms ease;
    }
    .done-rail:hover {
      background: color-mix(in srgb, var(--lane-accent) 8%, rgba(2, 15, 13, 0.5));
      border-color: color-mix(in srgb, var(--lane-accent) 55%, var(--line-soft));
    }
    .done-rail:focus-visible {
      outline: 1px solid color-mix(in srgb, var(--lane-accent) 70%, var(--cyan));
      outline-offset: 2px;
    }
    .done-rail .lane-head {
      min-height: 100%;
      height: 100%;
      justify-content: space-between;
      padding: 10px 4px 10px;
      gap: 10px;
      border-top-width: 0;
      border-left: 2px solid var(--lane-accent);
    }
    /* Top accent dot — matches the lane-title dot every other lane has,
       so the rail reads as "yes this is a lane" not "a mystery sliver". */
    .done-rail .lane-head::before {
      content: "";
      width: 6px;
      height: 6px;
      border-radius: 999px;
      background: var(--lane-accent);
      opacity: 0.75;
      margin: 0 auto;
      flex-shrink: 0;
    }
    .done-rail .lane-title {
      writing-mode: vertical-rl;
      transform: rotate(180deg);
      align-items: center;
      justify-content: center;
      gap: 10px;
      overflow: visible;
      flex: 1;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.7rem;
      letter-spacing: 0.16em;
      text-transform: uppercase;
      color: var(--muted);
    }
    .done-rail:hover .lane-title { color: var(--cream); }
    /* The pill is rendered inside the vertical-rl title, so rotating it
       back to horizontal keeps the count number readable. Sized up so
       the number is the focal point of the rail. */
    .done-rail .lane-title .pill {
      writing-mode: horizontal-tb;
      transform: rotate(180deg);
      padding: 3px 10px;
      border-radius: 999px;
      border: 1px solid color-mix(in srgb, var(--lane-accent) 45%, var(--line-soft));
      background: color-mix(in srgb, var(--lane-accent) 10%, rgba(2, 15, 13, 0.7));
      color: var(--cream);
      font-size: 0.84rem;
      font-weight: 800;
      letter-spacing: 0.02em;
      min-width: 34px;
      text-align: center;
    }
    .done-rail .lane-title::before,
    .done-rail .lane-body,
    .done-rail .lane-subtitle {
      display: none;
    }
    .soft-button {
      min-height: 28px;
      padding: 0 9px;
      border-radius: 6px;
      font-size: 0.78rem;
      color: var(--text);
      background: rgba(255, 255, 255, 0.035);
    }
    .soft-button[data-action="primary"] {
      border-color: var(--lane-accent);
      color: var(--lane-accent);
      background: color-mix(in srgb, var(--lane-accent) 12%, transparent);
    }
    .drawer {
      position: fixed;
      inset: 0 0 0 auto;
      width: clamp(420px, 31vw, 640px);
      z-index: 20;
      display: grid;
      grid-template-rows: auto minmax(0, 1fr) auto;
      border-left: 1px solid var(--line);
      background: rgba(7, 15, 12, 0.985);
      box-shadow: -30px 0 80px rgba(0, 0, 0, 0.46);
      transform: translateX(104%);
      transition: transform 0.2s ease;
      overflow: hidden;
    }
    .drawer-handle { display: none; }
    .drawer[data-open="true"] { transform: translateX(0); }
    .drawer-head {
      display: grid;
      gap: 10px;
      border-bottom: 1px solid var(--line);
      padding: 16px 18px;
      background: var(--surface-strong);
    }
    .drawer-topline,
    .drawer-links,
    .drawer-footer {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      flex-wrap: wrap;
    }
    .drawer-title {
      margin: 0;
      font-size: 1.3rem;
      line-height: 1.2;
      letter-spacing: 0;
    }
    .drawer-body {
      min-height: 0;
      overflow: auto;
      display: grid;
      align-content: start;
      gap: 12px;
      padding: 16px 18px 22px;
    }
    .drawer-section {
      border: 1px solid var(--line-soft);
      border-radius: 8px;
      background: rgba(12, 24, 19, 0.62);
      padding: 12px;
    }
    .drawer-section h3 {
      margin: 0 0 8px;
      color: var(--muted);
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.68rem;
      letter-spacing: 0.12em;
      text-transform: uppercase;
    }
    .drawer-section p {
      color: var(--text);
      line-height: 1.45;
    }
    .drawer-footer {
      position: sticky;
      bottom: 0;
      border-top: 1px solid var(--line);
      background: rgba(7, 15, 12, 0.97);
      padding: 12px 18px;
    }
    .command-console {
      position: fixed;
      left: 14px;
      right: 14px;
      bottom: 10px;
      z-index: 18;
      display: grid;
      grid-template-columns: minmax(0, 1fr) clamp(320px, 25vw, 430px);
      gap: 14px;
      align-items: stretch;
      /* The collaboration thread is now a workspace, not a status strip.
         Claim the empty space below the board so the page doesn't show
         a black void between a short kanban + a thin chat dock. */
      min-height: min(52vh, 520px);
      max-height: min(64vh, 640px);
      border: 1px solid var(--line);
      border-radius: 14px;
      background:
        linear-gradient(180deg, rgba(13, 29, 23, 0.98), rgba(5, 13, 11, 0.985)),
        rgba(7, 15, 12, 0.98);
      box-shadow: 0 22px 70px rgba(0, 0, 0, 0.42);
      padding: 12px;
      backdrop-filter: blur(16px);
    }
    .command-shell.has-selection .command-console {
      right: calc(clamp(420px, 31vw, 640px) + 18px);
    }
    .console-main {
      display: grid;
      min-height: 0;
      min-width: 0;
      border: 1px solid rgba(84, 121, 108, 0.18);
      border-radius: 10px;
      background: rgba(2, 9, 8, 0.34);
      overflow: hidden;
    }
    .console-compose {
      min-width: 0;
      display: grid;
      align-content: start;
      gap: 10px;
      padding-left: 2px;
    }
    .console-context {
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
      color: var(--muted);
      font-size: 0.78rem;
    }
    .console-row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 8px;
    }
    .console-input {
      min-height: 40px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--surface-soft);
      color: var(--text);
      padding: 0 12px;
      outline: none;
    }
    .console-input:focus {
      border-color: color-mix(in srgb, var(--cyan) 55%, var(--line));
      box-shadow: 0 0 0 3px rgba(86, 204, 228, 0.08);
    }
    .console-output {
      min-height: 0;
      max-height: none;
      overflow: auto;
      color: var(--muted);
      font-size: 0.82rem;
      line-height: 1.4;
      white-space: pre-wrap;
    }
    .console-output[data-mode="thread"] {
      white-space: normal;
    }
    .collab-thread {
      display: flex;
      flex-direction: column;
      align-content: start;
      min-height: 100%;
      padding: 10px 12px 12px;
      color: var(--text);
    }
    /* Per-message margin (not container gap) so grouped rows can use
       margin-top: 0 to visually attach to the previous same-speaker
       row. Grid gap does not yield to negative margins reliably. */
    .collab-message + .collab-message { margin-top: 8px; }
    .collab-message[data-grouped="true"] { margin-top: 0; }
    .collab-head {
      position: sticky;
      top: 0;
      z-index: 1;
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 10px;
      color: var(--muted);
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.64rem;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      padding: 2px 0 6px;
      margin-bottom: 2px;
      border-bottom: 1px solid rgba(184, 211, 196, 0.08);
      background: linear-gradient(180deg, rgba(5, 13, 11, 0.98), rgba(5, 13, 11, 0.72));
    }
    .collab-head strong {
      color: var(--cream);
      font-size: 0.7rem;
      letter-spacing: 0.14em;
      letter-spacing: 0.01em;
    }
    /* ── Collaboration thread (ops-console aesthetic) ──────────────────────
       Matches the rest of the page: 3px solid left-rail in agent color
       (same idiom as the kanban cards), uppercase tracked monospace
       speaker labels (matching ACTION RECIPE / HERMES VERDICT section
       headers), 8px radius, low-contrast hairline borders, dense rows.
       No round avatars, no asymmetric layout — this is a dashboard
       panel, not a consumer chat app. */
    .collab-message {
      display: grid;
      grid-template-rows: auto auto;
      gap: 4px;
      align-items: flex-start;
      padding: 8px 12px 8px 13px;
      border: 1px solid var(--line-soft);
      border-left: 3px solid var(--speaker-accent, var(--line));
      border-radius: 8px;
      background: rgba(8, 18, 14, 0.55);
      min-width: 0;
    }
    .collab-message[data-speaker="codex"] { --speaker-accent: var(--violet); }
    .collab-message[data-speaker="hermes"] { --speaker-accent: var(--cyan); }
    .collab-message[data-speaker="operator"] { --speaker-accent: var(--warn); }
    .collab-message[data-speaker="system"] { --speaker-accent: var(--muted); }
    /* System / idle rows: centered dashed note. Reads as a status line,
       not a fake agent message. Matches the .lane-empty placeholder
       idiom elsewhere on the page. */
    .collab-message[data-speaker="system"] {
      border: 1px dashed rgba(184, 211, 196, 0.18);
      border-left: 1px dashed rgba(184, 211, 196, 0.18);
      background: rgba(122, 134, 130, 0.04);
      text-align: center;
      padding: 6px 12px;
    }
    .collab-message[data-speaker="system"] .collab-byline { justify-content: center; }
    .collab-byline {
      display: flex;
      align-items: baseline;
      gap: 10px;
      min-width: 0;
      flex-wrap: wrap;
    }
    /* Speaker label uses the same uppercase-tracked-monospace voice as
       the drawer section headers (HERMES VERDICT / ACTION RECIPE / etc.). */
    .collab-speaker {
      color: var(--speaker-accent, var(--muted));
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.66rem;
      font-weight: 800;
      letter-spacing: 0.12em;
      text-transform: uppercase;
    }
    .collab-meta {
      color: var(--muted);
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.64rem;
      letter-spacing: 0.02em;
      white-space: nowrap;
      margin-left: auto;
    }
    .collab-text {
      color: var(--text);
      font-size: 0.85rem;
      line-height: 1.45;
      overflow-wrap: anywhere;
    }
    /* Posted messages: stronger left-rail width + a faint speaker-color
       wash so real posts read as more "load-bearing" than synthesized
       status lines, without changing the layout idiom. */
    .collab-message[data-posted="true"] {
      border-left-width: 4px;
      background: color-mix(in srgb, var(--speaker-accent, var(--muted)) 5%, rgba(8, 18, 14, 0.7));
    }
    .collab-message[data-kind="request_help"] {
      border-left-color: var(--warn);
      background: color-mix(in srgb, var(--warn) 8%, rgba(8, 18, 14, 0.7));
    }
    /* Grouped messages: a second+ message in a same-speaker run. The
       top border + radius collapses into the previous row to make a
       continuous left-rail "thread", so the eye sees one speaker
       saying multiple things rather than a fresh row each time. The
       margin-top: 0 override at the top of this block kills the
       8px inter-row gap; padding-top adds back a small breath. */
    .collab-message[data-grouped="true"] {
      border-top: 0;
      border-top-left-radius: 0;
      border-top-right-radius: 0;
      padding-top: 4px;
    }
    /* When a same-speaker run continues we hide the heavy hairline
       between rows so the rail reads as one thread. */
    .collab-message[data-grouped="true"]::before {
      content: "";
      display: block;
      height: 1px;
      background: color-mix(in srgb, var(--speaker-accent, var(--line)) 18%, transparent);
      margin: 0 -12px 4px -13px;
    }
    .collab-follow {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.62rem;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: color-mix(in srgb, var(--speaker-accent, var(--muted)) 70%, var(--muted));
    }
    /* The newest message in the thread gets a subtle one-shot pulse so
       the eye lands on it when new chat arrives — "this is alive". The
       animation runs once then stays at rest. */
    @keyframes collab-pulse {
      0%   { box-shadow: 0 0 0 0 color-mix(in srgb, var(--speaker-accent, var(--cyan)) 42%, transparent); }
      60%  { box-shadow: 0 0 0 6px color-mix(in srgb, var(--speaker-accent, var(--cyan)) 0%, transparent); }
      100% { box-shadow: 0 0 0 0 transparent; }
    }
    .collab-message[data-newest="true"] {
      animation: collab-pulse 1.4s ease-out 1;
    }
    .collab-tag {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 1px 8px;
      border-radius: 999px;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.58rem;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      border: 1px solid var(--line-soft);
      color: var(--muted);
      background: rgba(2, 9, 8, 0.5);
    }
    .collab-tag[data-tag="proposal"] {
      border-color: color-mix(in srgb, var(--cyan) 42%, var(--line-soft));
      color: color-mix(in srgb, var(--cyan) 92%, var(--text));
    }
    .collab-tag[data-tag="help"] {
      border-color: color-mix(in srgb, var(--warn) 52%, var(--line-soft));
      color: color-mix(in srgb, var(--warn) 96%, var(--text));
    }
    .collab-tag[data-tag="status"] {
      border-color: color-mix(in srgb, var(--violet) 42%, var(--line-soft));
      color: color-mix(in srgb, var(--violet) 92%, var(--text));
    }
    .collab-tag[data-tag="posted"] {
      border-color: color-mix(in srgb, var(--speaker-accent, var(--muted)) 60%, var(--line-soft));
      color: color-mix(in srgb, var(--speaker-accent, var(--muted)) 92%, var(--text));
    }
    .collab-addressed {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.72rem;
      color: var(--cyan);
      letter-spacing: 0.02em;
    }
    /* Compose form mode toggle + post-mode controls (target / intent). */
    .compose-mode {
      display: inline-flex;
      gap: 4px;
      padding: 2px;
      border: 1px solid var(--line-soft);
      border-radius: 999px;
      background: var(--surface-soft);
    }
    .compose-mode button {
      padding: 4px 10px;
      border-radius: 999px;
      font-size: 0.72rem;
      color: var(--muted);
      background: transparent;
      border: none;
    }
    .compose-mode button[aria-pressed="true"] {
      background: color-mix(in srgb, var(--cyan) 18%, transparent);
      color: var(--cream);
    }
    .compose-meta {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: center;
      min-width: 0;
    }
    .compose-meta label {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      color: var(--muted);
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.66rem;
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }
    .compose-meta select {
      min-height: 28px;
      padding: 0 8px;
      border-radius: 8px;
      border: 1px solid var(--line);
      background: var(--surface-soft);
      color: var(--text);
      font-size: 0.78rem;
    }
    .compose-mode-hint {
      color: var(--muted);
      font-size: 0.7rem;
      line-height: 1.35;
    }
    .console-status {
      color: var(--muted);
      font-size: 0.72rem;
      min-height: 1em;
    }
    .console-status[data-tone="error"] { color: var(--warn); }
    .console-status[data-tone="ok"] { color: color-mix(in srgb, var(--cyan) 88%, var(--text)); }
    .quick-asks {
      display: grid;
      gap: 7px;
      min-width: 0;
    }
    .quick-asks-label {
      color: var(--muted);
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.62rem;
      letter-spacing: 0.12em;
      text-transform: uppercase;
    }
    .suggestions {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 6px;
      align-items: stretch;
    }
    .suggestion {
      min-height: 30px;
      padding: 0 10px;
      border-radius: 999px;
      font-size: 0.78rem;
      background: var(--surface-soft);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .hidden { display: none !important; }
    @media (max-width: 760px) {
      main { width: min(100vw - 20px, 1180px); margin-top: 14px; }
      header { flex-direction: column; }
      .grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .repo-head { flex-direction: column; }
      .repo-summary { justify-content: flex-start; }
      .pr-board { grid-template-columns: 1fr; }
      .staleness-summary { grid-template-columns: 1fr; }
      .owner-summary { grid-template-columns: 1fr; }
      .owner-lanes { grid-template-columns: 1fr; }
      .pipeline-steps,
      .pr-timeline,
      .fix-request-meta,
      .pipeline-meta,
      .operator-evidence,
      .resolution-grid,
      .pipeline-detail { grid-template-columns: 1fr; }
      dl { grid-template-columns: 1fr; }
      .cmdbar,
      .filterbar,
      .command-console { grid-template-columns: 1fr; }
      .board-shell { padding-bottom: 340px; }
      .command-console {
        max-height: min(42vh, 380px);
        overflow: auto;
      }
      .console-main { min-height: 160px; }
      .cmd-counters,
      .filter-left,
      .filter-right,
      .suggestions { justify-content: flex-start; overflow-x: auto; }
      .suggestions { grid-template-columns: repeat(3, minmax(0, 1fr)); }
      .agent-activity {
        grid-template-columns: 1fr;
      }
      .kanban-board,
      .kanban-board[data-done-expanded="true"] {
        grid-template-columns: repeat(7, minmax(250px, 82vw));
        overflow-x: auto;
      }
      /* On mobile the vertical 56px rail makes no sense — expand it into a
         full-width horizontal row so the Done lane stays accessible. */
      .done-rail {
        min-width: 250px;
        width: auto;
      }
      .done-rail .lane-head {
        justify-content: space-between;
        border-left: 0;
        border-top: 2px solid var(--lane-accent);
      }
      .done-rail .lane-title {
        writing-mode: horizontal-tb;
        transform: none;
      }
      .command-shell.has-selection .command-console { right: 14px; }
      .drawer { width: 100vw; }
    }

    /* ── Mockup-parity additions ─────────────────────────────────────────── */

    /* Topbar — system block + sys-agents */
    .cmd-left {
      display: flex;
      align-items: center;
      gap: 18px;
      min-width: 0;
    }
    .sys {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 6px 10px;
      border: 1px solid var(--line);
      border-radius: 999px;
      background: var(--surface-soft);
      white-space: nowrap;
    }
    .sys-dot {
      width: 7px;
      height: 7px;
      border-radius: 999px;
      background: var(--faint);
    }
    .sys.running .sys-dot { background: var(--ok); animation: pulse 1.8s ease-out infinite; }
    .sys-label {
      font-size: 0.78rem;
      letter-spacing: 0.005em;
      font-weight: 700;
    }
    .sys-agents {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding-left: 8px;
      margin-left: 2px;
      border-left: 1px solid var(--line);
    }
    .sys-agent {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      font-size: 0.72rem;
      color: var(--muted);
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      white-space: nowrap;
    }
    .sa-dot {
      width: 5px;
      height: 5px;
      border-radius: 999px;
      background: var(--cyan);
    }
    .sys-agent[data-agent="codex"] .sa-dot { background: var(--violet); }
    .sys-agent[data-agent="hermes"] .sa-dot { background: var(--cyan); }
    .sys-agent[data-agent="deploy"] .sa-dot { background: var(--ok); }
    .sys-agent.empty { opacity: 0.55; }

    /* Topbar — deploy-health pill (6th chip) — horizontal to match the other counter chips */
    .counter-chip.cc-health {
      align-items: center;
      gap: 6px;
      padding: 0 10px;
      border-color: var(--line);
    }
    .counter-chip.cc-health .counter-number {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 0.78rem;
      font-weight: 800;
      letter-spacing: 0.06em;
      text-transform: uppercase;
    }
    .counter-chip.cc-health .counter-number::before {
      content: "";
      width: 7px;
      height: 7px;
      border-radius: 999px;
      background: var(--faint);
    }
    .counter-chip.cc-health[data-state="ok"]      { border-color: rgba(82, 210, 115, 0.62); background: var(--ok-bg); color: var(--ok); }
    .counter-chip.cc-health[data-state="ok"] .counter-number::before { background: var(--ok); }
    .counter-chip.cc-health[data-state="verifying"] { border-color: rgba(86, 204, 228, 0.55); background: rgba(86, 204, 228, 0.10); color: var(--cyan); }
    .counter-chip.cc-health[data-state="verifying"] .counter-number::before { background: var(--cyan); animation: pulse 1.4s ease-out infinite; }
    .counter-chip.cc-health[data-state="fail"]    { border-color: rgba(238, 98, 96, 0.68); background: var(--bad-bg); color: var(--bad); box-shadow: 0 0 0 1px rgba(238, 98, 96, 0.16); }
    .counter-chip.cc-health[data-state="fail"] .counter-number::before { background: var(--bad); animation: pulse 1.4s ease-out infinite; }
    .counter-chip.cc-health .counter-label { color: inherit; opacity: 0.7; }

    /* Topbar — richer live indicator + pause button */
    .cmd-status.cmd-status-rich {
      flex-direction: column;
      align-items: flex-start;
      gap: 0;
      padding: 4px 12px;
    }
    .cmd-status-rich .cmd-status-state {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 0.8rem;
      font-weight: 700;
      letter-spacing: 0.005em;
    }
    .cmd-status-rich .cmd-status-state::before {
      content: "";
      width: 7px;
      height: 7px;
      border-radius: 999px;
      background: var(--ok);
    }
    .cmd-status-rich .cmd-status-sub {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.62rem;
      letter-spacing: 0.04em;
      color: var(--muted);
      margin-top: 2px;
    }
    .cmd-status-rich[data-state="live"] .cmd-status-state::before { background: var(--ok); animation: pulse 1.8s ease-out infinite; }
    .cmd-status-rich[data-state="polling"] .cmd-status-state::before,
    .cmd-status-rich[data-state="reconnecting"] .cmd-status-state::before,
    .cmd-status-rich[data-state="connecting"] .cmd-status-state::before { background: var(--cyan); }
    .cmd-status-rich[data-state="paused"] .cmd-status-state::before { background: var(--faint); }
    .cmd-status-rich[data-state="stale"] .cmd-status-state::before { background: var(--warn); }
    .cmd-status-rich[data-state="error"] .cmd-status-state::before { background: var(--bad); }
    .cmd-status::before { display: none; }
    .cmd-pause {
      min-height: 30px;
      width: 30px;
      padding: 0;
      border-radius: 7px;
      background: var(--surface-soft);
      color: var(--muted);
      display: inline-grid;
      place-items: center;
    }
    .cmd-pause:hover { border-color: var(--line); color: var(--text); }
    .cmd-pause[aria-pressed="true"] { color: var(--accent); border-color: var(--accent); }

    /* Filterbar sort hint */
    .fb-hint {
      color: var(--muted);
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.62rem;
      text-transform: uppercase;
      letter-spacing: 0.1em;
      white-space: nowrap;
      padding-right: 4px;
      border-right: 1px solid var(--line-soft);
      margin-right: 2px;
      padding-left: 0;
    }
    .filter-right { gap: 8px; flex-wrap: wrap; row-gap: 6px; justify-content: flex-end; }
    .filter-right .fb-pill-group { gap: 4px; }

    /* KanbanCard — active-agent dot, stale dot, local approved badge, restructured head */
    .card-head {
      align-items: flex-start;
      flex-wrap: wrap;
      justify-content: flex-start;
      row-gap: 6px;
    }
    .kc-head-l {
      display: inline-flex;
      flex: 1 1 150px;
      flex-wrap: wrap;
      align-items: center;
      gap: 6px;
      min-width: 0;
    }
    .kc-head-r {
      display: inline-flex;
      flex: 0 0 auto;
      align-items: center;
      justify-content: flex-end;
      gap: 6px;
      min-width: 0;
      margin-left: auto;
    }
    .active-agent {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      max-width: 100%;
      padding: 2px 8px;
      border: 1px solid var(--line);
      border-radius: 999px;
      background: var(--surface-soft);
      font-size: 0.7rem;
      color: var(--muted);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .kc-head-l .pill {
      max-width: 100%;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .active-agent .aa-dot {
      width: 6px;
      height: 6px;
      border-radius: 999px;
      background: var(--cyan);
      animation: pulse 1.4s ease-out infinite;
    }
    .active-agent[data-agent="codex"] .aa-dot  { background: var(--violet); }
    .active-agent[data-agent="hermes"] .aa-dot { background: var(--cyan); }
    .active-agent[data-agent="deploy"] .aa-dot { background: var(--ok); }
    .work-state {
      display: inline-flex;
      align-items: center;
      max-width: 100%;
      border: 1px solid color-mix(in oklab, var(--state-accent, var(--line)) 55%, transparent);
      border-radius: 999px;
      padding: 2px 7px;
      color: var(--state-accent, var(--muted));
      background: color-mix(in oklab, var(--state-accent, var(--line)) 10%, transparent);
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.68rem;
      font-weight: 800;
      letter-spacing: 0.05em;
      text-transform: uppercase;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .work-state[data-state="waiting"] { --state-accent: var(--violet); }
    .work-state[data-state="proposed"] { --state-accent: var(--warn); }
    .work-state[data-state="approved"] { --state-accent: var(--ok); }
    .work-state[data-state="active"] { --state-accent: var(--cyan); }
    .work-state[data-state="ci"] { --state-accent: var(--warn); }
    .stale-dot {
      width: 8px;
      height: 8px;
      border-radius: 999px;
      background: var(--ok);
      box-shadow: 0 0 0 2px rgba(82, 210, 115, 0.18);
      flex-shrink: 0;
    }
    .stale-dot[data-stale="waiting"] { background: var(--warn); box-shadow: 0 0 0 2px rgba(217, 173, 66, 0.22); }
    .stale-dot[data-stale="stale"]   { background: var(--bad);  box-shadow: 0 0 0 2px rgba(238, 98, 96, 0.24); animation: pulse 1.6s ease-out infinite; }
    .card-age {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.7rem;
      color: var(--muted);
      letter-spacing: 0.04em;
      text-transform: uppercase;
      white-space: nowrap;
    }
    .card-head .stale-dot[data-stale="stale"] ~ .card-age { color: var(--bad); }
    .card-head .stale-dot[data-stale="waiting"] ~ .card-age { color: var(--warn); }
    .kc-id {
      display: flex;
      align-items: baseline;
      gap: 6px;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.72rem;
      color: var(--muted);
      letter-spacing: 0.02em;
    }
    .kc-id .kc-repo { color: var(--muted); }
    .kc-id .kc-num  { color: var(--text); font-weight: 700; }
    .kc-local {
      margin-left: 4px;
      padding: 1px 6px;
      border-radius: 999px;
      border: 1px solid rgba(82, 210, 115, 0.45);
      background: var(--ok-bg);
      color: var(--ok);
      font-size: 0.62rem;
      font-weight: 700;
      letter-spacing: 0.04em;
      text-transform: uppercase;
    }
    .kc-local::before { content: "● "; font-size: 0.5rem; }

    /* Drawer — rich body sections */
    .failure-callout {
      display: grid;
      grid-template-columns: 22px 1fr;
      align-items: center;
      gap: 10px;
      border: 1px solid rgba(238, 98, 96, 0.5);
      background: var(--bad-bg);
      border-radius: 8px;
      padding: 10px 12px;
    }
    .failure-callout .fc-icon {
      display: grid;
      place-items: center;
      width: 22px;
      height: 22px;
      border-radius: 999px;
      background: var(--bad);
      color: #fff;
      font-weight: 800;
    }
    .failure-callout .fc-text {
      color: var(--text);
      line-height: 1.4;
    }
    .verdict-box {
      display: grid;
      gap: 6px;
      border: 1px solid var(--line);
      border-left: 3px solid var(--accent);
      background: var(--accent-bg);
      border-radius: 8px;
      padding: 10px 12px;
    }
    .verdict-box[data-level="block"]        { border-left-color: var(--bad);  background: var(--bad-bg); }
    .verdict-box[data-level="needs-review"] { border-left-color: var(--warn); background: var(--warn-bg); }
    .verdict-box[data-level="pass"]         { border-left-color: var(--ok);   background: var(--ok-bg); }
    .verdict-box[data-level="running"]      { border-left-color: var(--cyan); background: rgba(86, 204, 228, 0.10); }
    .verdict-box .vb-head {
      display: flex;
      align-items: center;
      gap: 8px;
      color: var(--muted);
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.66rem;
      letter-spacing: 0.1em;
      text-transform: uppercase;
    }
    .verdict-box .vb-head .vb-age { color: var(--muted); }
    .verdict-box .vb-text { color: var(--text); line-height: 1.4; }
    .owner-contract {
      display: grid;
      gap: 10px;
    }
    .owner-contract .oc-current {
      display: grid;
      gap: 4px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--surface-soft);
      padding: 10px 12px;
    }
    .oc-owner {
      color: var(--text);
      font-weight: 800;
    }
    .oc-action {
      color: var(--muted);
      line-height: 1.4;
    }
    .oc-roles {
      display: grid;
      gap: 6px;
    }
    .oc-role {
      display: grid;
      grid-template-columns: 80px 1fr;
      gap: 10px;
      color: var(--muted);
      font-size: 0.8rem;
      line-height: 1.35;
    }
    .oc-role strong { color: var(--text); }
    .action-recipe {
      display: grid;
      gap: 10px;
    }
    .recipe-grid {
      display: grid;
      grid-template-columns: 96px minmax(0, 1fr);
      gap: 8px 12px;
      margin: 0;
    }
    .recipe-grid dt {
      color: var(--muted);
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.68rem;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }
    .recipe-grid dd {
      margin: 0;
      color: var(--text);
      line-height: 1.4;
      min-width: 0;
    }
    .recipe-proof {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }
    .codex-task-prompt {
      display: grid;
      gap: 10px;
    }
    .codex-state-note {
      margin: 0;
      color: var(--muted);
      line-height: 1.4;
    }
    .codex-queue-box {
      display: grid;
      gap: 8px;
      border: 1px solid var(--line);
      border-left: 3px solid var(--violet);
      border-radius: 8px;
      padding: 10px 12px;
      background: rgba(146, 142, 255, 0.08);
    }
    .codex-queue-box[data-status="proposed"] { border-left-color: var(--warn); background: var(--warn-bg); }
    .codex-queue-box[data-status="approved"] { border-left-color: var(--ok); background: var(--ok-bg); }
    .codex-queue-box[data-status="running"] { border-left-color: var(--cyan); background: rgba(86, 204, 228, 0.10); }
    .codex-queue-box[data-status="cancelled"],
    .codex-queue-box[data-status="failed"] { border-left-color: var(--bad); background: var(--bad-bg); }
    .codex-queue-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      color: var(--muted);
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.68rem;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }
    .codex-queue-body {
      color: var(--text);
      line-height: 1.4;
      font-size: 0.86rem;
    }
    .codex-queue-id {
      color: var(--muted);
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.7rem;
      overflow-wrap: anywhere;
    }
    .codex-queue-progress {
      display: grid;
      gap: 4px;
      padding: 8px;
      border: 1px solid rgba(146, 142, 255, 0.18);
      border-radius: 8px;
      background: rgba(0, 0, 0, 0.16);
      color: var(--text);
      font-size: 0.78rem;
      line-height: 1.35;
    }
    .codex-queue-progress code {
      color: var(--cyan);
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    .codex-task-events {
      display: grid;
      gap: 5px;
      margin: 0;
      padding: 0;
      list-style: none;
      color: var(--muted);
      font-size: 0.76rem;
      line-height: 1.35;
    }
    .codex-task-events li {
      display: grid;
      grid-template-columns: 72px minmax(0, 1fr);
      gap: 8px;
      align-items: start;
    }
    .codex-task-events time {
      color: var(--muted-2);
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.68rem;
      text-transform: uppercase;
    }
    .prompt-box {
      margin: 0;
      padding: 10px;
      border: 1px dashed var(--line);
      border-radius: 8px;
      color: var(--text);
      background: var(--panel-2);
      white-space: pre-wrap;
      line-height: 1.45;
      max-height: 180px;
      overflow: auto;
    }

    /* ActorPill — coloured dot + arrow + actor name for "next" handoff display */
    .card-next {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      min-width: 0;
    }
    .card-next-label {
      color: var(--muted);
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.6rem;
      letter-spacing: 0.1em;
      text-transform: uppercase;
    }
    .actor-pill {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 2px 7px;
      border-radius: 999px;
      border: 1px solid var(--line);
      background: var(--surface-soft);
      color: var(--text);
      font-size: 0.74rem;
      font-weight: 700;
      white-space: nowrap;
      --actor-accent: var(--muted);
    }
    .actor-pill[data-actor="codex"]    { --actor-accent: var(--violet); }
    .actor-pill[data-actor="hermes"]   { --actor-accent: var(--cyan); }
    .actor-pill[data-actor="operator"] { --actor-accent: var(--warn); }
    .actor-pill[data-actor="merge"]    { --actor-accent: var(--ok); }
    .actor-pill[data-actor="deploy"]   { --actor-accent: var(--cyan); }
    .actor-pill[data-actor="done"]     { --actor-accent: var(--muted); }
    .actor-pill {
      border-color: color-mix(in srgb, var(--actor-accent) 40%, var(--line));
      background: color-mix(in srgb, var(--actor-accent) 12%, transparent);
      color: var(--actor-accent);
    }
    .actor-pill .actor-dot {
      width: 6px;
      height: 6px;
      border-radius: 999px;
      background: var(--actor-accent);
    }
    .actor-pill .actor-arrow {
      font-size: 0.74rem;
      opacity: 0.7;
    }
    .actor-pill .actor-label {
      letter-spacing: 0.02em;
    }

    /* Lane empty — small leading dot before the empty-state copy */
    .lane-empty {
      gap: 8px;
    }
    .lane-empty::before {
      content: "";
      width: 6px;
      height: 6px;
      border-radius: 999px;
      background: var(--lane-accent);
      opacity: 0.55;
      flex-shrink: 0;
      display: inline-block;
      margin-right: 8px;
      vertical-align: middle;
    }
    .done-rail .lane-empty::before { display: none; }
    /* Done lane — compact rows instead of full kanban cards when expanded */
    .done-row {
      display: grid;
      grid-template-columns: 16px minmax(0, 0.35fr) minmax(0, 1fr) auto;
      align-items: center;
      gap: 10px;
      padding: 7px 10px;
      border: 1px solid var(--line-soft);
      border-left: 3px solid var(--ok);
      border-radius: 7px;
      background: var(--surface-strong);
      color: var(--text);
      cursor: pointer;
      text-align: left;
      font-size: 0.8rem;
      transition: border-color 0.14s ease, transform 0.14s ease;
    }
    .done-row[data-verdict="block"] { border-left-color: var(--bad); }
    .done-row:hover,
    .done-row[data-selected="true"] {
      transform: translateY(-1px);
      border-color: var(--ok);
    }
    .done-row .done-check {
      width: 14px;
      height: 14px;
      border-radius: 999px;
      background: var(--ok);
      display: grid;
      place-items: center;
      color: #08120e;
      font-size: 10px;
      font-weight: 800;
    }
    .done-row[data-verdict="block"] .done-check { background: var(--bad); }
    .done-row .done-id {
      display: inline-flex;
      gap: 5px;
      align-items: baseline;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.72rem;
      color: var(--muted);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .done-row .done-id .done-num {
      color: var(--text);
      font-weight: 700;
    }
    .done-row .done-title {
      color: var(--text);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .done-row .done-age {
      color: var(--muted);
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.7rem;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      white-space: nowrap;
    }

    /* Operator checklist with real checkboxes */
    .operator-checklist { display: grid; gap: 6px; }
    .operator-checklist-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      color: var(--muted);
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.66rem;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      margin-bottom: 6px;
    }
    .hc-item {
      display: grid;
      grid-template-columns: 18px 1fr;
      align-items: center;
      gap: 8px;
      padding: 4px 0;
      cursor: pointer;
    }
    .hc-item input {
      width: 14px;
      height: 14px;
      accent-color: var(--ok);
    }
    .hc-item span { color: var(--text); line-height: 1.35; }
    .hc-item[data-checked="true"] span { color: var(--muted); text-decoration: line-through; }

    /* Agent pre-check ledger */
    .precheck-list { display: grid; gap: 5px; }
    .pc-item {
      display: grid;
      grid-template-columns: 14px 1fr auto;
      align-items: center;
      gap: 8px;
    }
    .pc-tick {
      width: 12px;
      height: 12px;
      border-radius: 3px;
      background: var(--ok);
      display: grid;
      place-items: center;
    }
    .pc-tick[data-state="warn"] { background: var(--warn); }
    .pc-tick[data-state="bad"]  { background: var(--bad); }
    .pc-tick::before {
      content: "✓";
      color: #08120e;
      font-size: 10px;
      font-weight: 800;
      line-height: 1;
    }
    .pc-tick[data-state="bad"]::before { content: "✕"; }
    .pc-label { color: var(--text); font-size: 0.84rem; }
    .pc-note { color: var(--muted); font-size: 0.74rem; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }

    /* Check matrix */
    .check-matrix { display: grid; gap: 4px; }
    .cm-row {
      display: grid;
      grid-template-columns: 10px 1fr auto;
      align-items: center;
      gap: 8px;
      padding: 4px 6px;
      border-radius: 6px;
      background: rgba(12, 24, 19, 0.46);
    }
    .cm-dot {
      width: 6px;
      height: 6px;
      border-radius: 999px;
      background: var(--ok);
    }
    .cm-row[data-state="fail"] .cm-dot { background: var(--bad); }
    .cm-row[data-state="pending"] .cm-dot { background: var(--warn); }
    .cm-name { color: var(--text); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.78rem; }
    .cm-state-pill {
      display: inline-flex;
      align-items: center;
      padding: 1px 8px;
      border-radius: 999px;
      border: 1px solid rgba(82, 210, 115, 0.45);
      background: var(--ok-bg);
      color: var(--ok);
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.66rem;
      font-weight: 800;
      letter-spacing: 0.1em;
      text-transform: uppercase;
    }
    .cm-row[data-state="fail"] .cm-state-pill    { border-color: rgba(238, 98, 96, 0.55); background: var(--bad-bg); color: var(--bad); }
    .cm-row[data-state="pending"] .cm-state-pill { border-color: rgba(217, 173, 66, 0.5);  background: var(--warn-bg); color: var(--warn); }
    .cm-summary {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
      color: var(--muted);
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.72rem;
      padding-top: 6px;
    }
    .cm-summary span {
      display: inline-flex;
      align-items: baseline;
      gap: 4px;
      padding: 2px 8px;
      border: 1px solid var(--line-soft);
      border-radius: 999px;
      font-weight: 700;
    }
    .cm-summary .cm-sum-label { font-weight: 500; opacity: 0.75; font-size: 0.66rem; text-transform: uppercase; letter-spacing: 0.08em; }
    .cm-summary .cm-sum-pass    { color: var(--ok);   border-color: rgba(82, 210, 115, 0.36); }
    .cm-summary .cm-sum-fail    { color: var(--bad);  border-color: rgba(238, 98, 96, 0.36); }
    .cm-summary .cm-sum-pending { color: var(--warn); border-color: rgba(217, 173, 66, 0.36); }

    /* Touched files — compact chip row when no paths are surfaced */
    .touched-files-compact {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 6px;
    }
    .touched-files-compact .tf-chip {
      display: inline-flex;
      align-items: center;
      padding: 2px 8px;
      border-radius: 999px;
      border: 1px solid var(--line-soft);
      background: rgba(12, 24, 19, 0.55);
      color: var(--accent);
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.72rem;
      letter-spacing: 0.02em;
    }
    .touched-files-compact .tf-note {
      color: var(--muted);
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.66rem;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      margin-left: 4px;
    }

    /* Drawer header tightened — pill + close + links on a single row */
    .drawer-topline {
      align-items: center;
      gap: 8px;
      flex-wrap: nowrap;
    }
    .drawer-topline .dr-spacer { flex: 1 1 auto; }
    .drawer-topline .drawer-head-links {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      flex-shrink: 1;
      min-width: 0;
      overflow: hidden;
    }
    .drawer-topline .drawer-head-links .pill {
      padding: 2px 8px;
      font-size: 0.72rem;
      min-width: 0;
      max-width: 120px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .drawer-topline .dr-age {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.7rem;
      color: var(--muted);
      letter-spacing: 0.04em;
      text-transform: uppercase;
    }
    .drawer-topline .dr-close {
      min-height: 26px;
      min-width: 26px;
      padding: 0;
      display: grid;
      place-items: center;
      font-size: 0.9rem;
      color: var(--muted);
      flex: 0 0 auto;
    }
    .drawer-topline .dr-close:hover { color: var(--text); }
    .drawer-title {
      display: flex;
      flex-direction: column;
      gap: 4px;
      margin: 6px 0 0;
    }
    .drawer-title .drawer-title-id {
      color: var(--muted);
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.7rem;
      letter-spacing: 0.04em;
      font-weight: 500;
    }
    .drawer-title .drawer-title-text {
      color: var(--text);
      font-size: 1.18rem;
      line-height: 1.25;
      font-weight: 700;
    }

    /* Review why — severity chip + body */
    .review-why { margin-top: 10px; }
    .rw-list { display: grid; gap: 6px; }
    .rw-row {
      display: grid;
      grid-template-columns: 60px 1fr;
      align-items: start;
      gap: 10px;
    }
    .rw-sev {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 2px 6px;
      border-radius: 999px;
      border: 1px solid var(--line);
      color: var(--muted);
      background: var(--surface-soft);
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.62rem;
      font-weight: 800;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }
    .rw-sev[data-severity="bad"]  { color: var(--bad);  border-color: rgba(238, 98, 96, 0.55); background: var(--bad-bg); }
    .rw-sev[data-severity="warn"] { color: var(--warn); border-color: rgba(217, 173, 66, 0.55); background: var(--warn-bg); }
    .rw-sev[data-severity="info"] { color: var(--cyan); border-color: rgba(86, 204, 228, 0.45); background: rgba(86, 204, 228, 0.10); }
    .rw-body {
      display: flex;
      flex-direction: column;
      gap: 3px;
      min-width: 0;
    }
    .rw-code {
      color: var(--muted);
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.7rem;
      letter-spacing: 0.04em;
    }
    .rw-msg { color: var(--text); line-height: 1.4; font-size: 0.86rem; }
    .rw-note {
      color: var(--text);
      line-height: 1.4;
      font-size: 0.86rem;
      margin-top: 10px;
    }

    /* Touched files grouped by area */
    .touched-files { display: grid; gap: 8px; }
    .tf-group {
      display: grid;
      gap: 4px;
      padding: 8px 10px;
      border: 1px solid var(--line-soft);
      border-radius: 6px;
      background: rgba(12, 24, 19, 0.46);
    }
    .tf-group-head {
      display: flex;
      align-items: baseline;
      gap: 8px;
    }
    .tf-area {
      color: var(--accent);
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.74rem;
      font-weight: 700;
      letter-spacing: 0.02em;
    }
    .tf-count {
      color: var(--muted);
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.66rem;
    }
    .tf-path {
      color: var(--muted);
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.74rem;
      line-height: 1.5;
      overflow-wrap: anywhere;
    }

    /* Timeline list */
    .timeline-list { display: grid; gap: 4px; }
    .tl-row {
      display: grid;
      grid-template-columns: 8px 1fr auto;
      align-items: center;
      gap: 10px;
      padding: 3px 0;
    }
    .tl-dot {
      width: 8px;
      height: 8px;
      border-radius: 999px;
      background: var(--line);
    }
    .tl-row[data-state="pass"] .tl-dot { background: var(--ok); }
    .tl-row[data-state="fail"] .tl-dot { background: var(--bad); }
    .tl-row[data-state="review"] .tl-dot { background: var(--warn); }
    .tl-row[data-state="running"] .tl-dot { background: var(--cyan); animation: pulse 1.6s ease-out infinite; }
    .tl-label { color: var(--text); font-size: 0.86rem; }
    .tl-row[data-state="pending"] .tl-label { color: var(--muted); }
    .tl-state {
      color: var(--muted);
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.7rem;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }
    .tl-row[data-state="pass"]    .tl-state { color: var(--ok); }
    .tl-row[data-state="fail"]    .tl-state { color: var(--bad); }
    .tl-row[data-state="review"]  .tl-state { color: var(--warn); }
    .tl-row[data-state="running"] .tl-state { color: var(--cyan); }

    /* References KV block */
    .ref-kv {
      display: grid;
      grid-template-columns: 110px 1fr;
      gap: 4px 12px;
      align-items: baseline;
    }
    .ref-kv dt {
      color: var(--muted);
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.66rem;
      letter-spacing: 0.1em;
      text-transform: uppercase;
    }
    .ref-kv dd {
      margin: 0;
      color: var(--text);
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.78rem;
      overflow-wrap: anywhere;
    }

    /* Phase history */
    .phase-history { display: grid; gap: 4px; }
    .ph-row {
      display: grid;
      grid-template-columns: 70px 8px 1fr;
      align-items: center;
      gap: 8px;
      padding: 2px 0;
      font-size: 0.78rem;
      color: var(--text);
    }
    .ph-row .ph-time {
      color: var(--muted);
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.7rem;
    }
    .ph-row .ph-dot {
      width: 7px;
      height: 7px;
      border-radius: 999px;
      background: var(--cyan);
    }
    .ph-row[data-state="pass"] .ph-dot { background: var(--ok); }
    .ph-row[data-state="fail"] .ph-dot { background: var(--bad); }
    .ph-row[data-state="review"] .ph-dot { background: var(--warn); }

    /* ── Mobile (≤640px) ───────────────────────────────────────────────── */

    /* Default: hide mobile-only chrome on desktop. */
    .mobile-only { display: none !important; }
    .mobile-tabs { display: none; }
    .lane-chip   { display: none; }
    #fab-ask, #ask-sheet, #ask-sheet-scrim { display: none; }
    #pull-indicator { display: none; }

    @media (max-width: 640px) {
      :root { --topbar-pad: 8px; }
      .mobile-only { display: revert !important; }
      .desktop-only { display: none !important; }

      /* Topbar: single row, compact brand, status pill, "..." menu. */
      .cmdbar {
        grid-template-columns: auto 1fr auto;
        gap: 8px;
        padding: 8px 12px;
      }
      .brand .brand-sub { display: none; }
      .brand-name { font-size: 0.8rem; }
      .brand-mark { width: 28px; height: 28px; }
      .cmd-left { gap: 8px; }
      .cmd-left .sys-agents { display: none; }
      .cmd-left .sys-label { font-size: 0.74rem; }
      .cmd-counters {
        order: 3;
        grid-column: 1 / -1;
        margin-top: 2px;
        flex-wrap: nowrap;
        justify-content: flex-start;
        gap: 6px;
        overflow-x: auto;
        scrollbar-width: none;
        -webkit-overflow-scrolling: touch;
        padding-bottom: 2px;
      }
      .cmd-counters::-webkit-scrollbar { display: none; }
      .counter-chip { flex-shrink: 0; height: 28px; padding: 0 8px; }
      .counter-chip .counter-number { font-size: 0.84rem; }
      .counter-chip .counter-label { font-size: 0.58rem; }
      .refresh-cluster { gap: 6px; }
      .refresh-cluster .refresh-meta,
      .refresh-cluster #refresh { display: none; }
      .cmd-status.cmd-status-rich { padding: 4px 8px; min-height: 28px; }
      .cmd-status-rich .cmd-status-sub { display: none; }
      .cmd-pause { width: 28px; min-height: 28px; }

      /* Filter bar: collapse + replace with horizontal mobile tabs. */
      .filterbar { display: none; }
      .mobile-tabs {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 8px 10px;
        overflow-x: auto;
        scrollbar-width: none;
        -webkit-overflow-scrolling: touch;
        border-bottom: 1px solid var(--line-soft);
        background: rgba(4, 13, 11, 0.78);
        scroll-snap-type: x mandatory;
      }
      .mobile-tabs::-webkit-scrollbar { display: none; }
      .mobile-tab {
        flex-shrink: 0;
        display: inline-flex;
        align-items: center;
        gap: 5px;
        min-height: 34px;
        padding: 0 12px;
        border: 1px solid var(--line);
        border-radius: 999px;
        background: var(--surface-soft);
        color: var(--text);
        font-size: 0.82rem;
        font-weight: 600;
        white-space: nowrap;
        cursor: pointer;
        scroll-snap-align: start;
      }
      .mobile-tab .mt-count {
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 0.7rem;
        color: var(--muted);
        padding: 1px 6px;
        border-radius: 999px;
        background: rgba(255,255,255,0.04);
      }
      .mobile-tab[aria-pressed="true"] {
        border-color: var(--accent);
        background: var(--accent-bg);
        color: var(--accent);
      }
      .mobile-tab[aria-pressed="true"] .mt-count { color: inherit; }

      /* Board: stacked single-column flat list. */
      .board-shell {
        padding: 8px 10px 88px;
        gap: 8px;
      }
      .agent-activity {
        grid-template-columns: 1fr;
        gap: 8px;
      }
      .agent-status-card,
      .handoff-radar {
        border-radius: 8px;
        padding: 9px 10px;
      }
      .agent-status-grid {
        grid-template-columns: 1fr;
      }
      .handoff-radar-list li {
        grid-template-columns: auto minmax(0, 1fr);
      }
      .radar-age {
        display: none;
      }
      .live-lane {
        display: none;
      }
      .kanban-board,
      .kanban-board[data-done-expanded="true"] {
        display: flex;
        flex-direction: column;
        gap: 6px;
        overflow-x: hidden;
        overflow-y: auto;
        padding-bottom: 12px;
      }
      .lane {
        background: transparent;
        border: none;
        border-radius: 0;
      }
      .lane-head { display: none; }
      .lane-body {
        padding: 0;
        gap: 8px;
        overflow: visible;
      }
      /* The collapsed Done rail is a desktop convenience; on phones it'd
         break the flat-list layout, so it's just hidden. The full Done
         lane is still reachable via the "done lane N" counter chip. */
      .done-rail { display: none; }
      /* Cards: keep all content; add the lane chip; bump touch sizes. */
      .handoff-card {
        padding: 12px;
        gap: 9px;
      }
      .lane-chip {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 2px 8px;
        border-radius: 999px;
        border: 1px solid var(--line);
        background: var(--surface-soft);
        color: var(--muted);
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 0.62rem;
        letter-spacing: 0.1em;
        text-transform: uppercase;
        white-space: nowrap;
        --lc-accent: var(--muted);
      }
      .lane-chip[data-lane="attention"] { --lc-accent: var(--bad); }
      .lane-chip[data-lane="codex"]     { --lc-accent: var(--violet); }
      .lane-chip[data-lane="hermes"]    { --lc-accent: var(--cyan); }
      .lane-chip[data-lane="operator"]  { --lc-accent: var(--warn); }
      .lane-chip[data-lane="queue"]     { --lc-accent: var(--ok); }
      .lane-chip[data-lane="deploy"]    { --lc-accent: var(--cyan); }
      .lane-chip[data-lane="done"]      { --lc-accent: var(--muted); }
      .lane-chip {
        color: var(--lc-accent);
        border-color: color-mix(in srgb, var(--lc-accent) 40%, var(--line));
        background: color-mix(in srgb, var(--lc-accent) 10%, transparent);
      }
      .lane-chip::before {
        content: "";
        width: 5px;
        height: 5px;
        border-radius: 999px;
        background: var(--lc-accent);
      }
      .handoff-card .soft-button {
        min-height: 36px;
        padding: 0 12px;
        font-size: 0.84rem;
      }
      .card-foot { flex-wrap: wrap; gap: 6px; }

      /* Drawer becomes a bottom sheet. */
      .drawer {
        top: auto;
        left: 0;
        right: 0;
        bottom: 0;
        width: 100vw;
        height: 90vh;
        max-height: 90vh;
        border-left: none;
        border-top: 1px solid var(--line);
        border-top-left-radius: 16px;
        border-top-right-radius: 16px;
        transform: translateY(102%);
        transition: transform 0.22s ease;
        grid-template-rows: auto auto minmax(0, 1fr) auto;
        box-shadow: 0 -30px 80px rgba(0, 0, 0, 0.46);
      }
      .drawer[data-open="true"] { transform: translateY(0); }
      .drawer-handle {
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 6px 0 2px;
        cursor: grab;
        touch-action: none;
      }
      .drawer-handle::before {
        content: "";
        width: 36px;
        height: 4px;
        border-radius: 999px;
        background: var(--line);
      }
      .drawer-handle.dragging { cursor: grabbing; }
      .drawer-head { padding: 6px 16px 10px; }
      .drawer-title { font-size: 1.05rem; }
      .drawer-body { padding: 12px 16px 16px; }
      .drawer-footer {
        padding: 10px 14px;
        padding-bottom: max(10px, env(safe-area-inset-bottom));
      }

      /* Bottom Ask Hermes console gets folded into a FAB + sheet. */
      .command-console { display: none; }
      .command-shell.has-selection .command-console { display: none; }
      #fab-ask {
        display: inline-flex;
        position: fixed;
        right: 14px;
        bottom: max(14px, env(safe-area-inset-bottom));
        z-index: 25;
        width: 52px;
        height: 52px;
        align-items: center;
        justify-content: center;
        border-radius: 999px;
        border: 1px solid color-mix(in srgb, var(--accent) 45%, var(--line));
        background: linear-gradient(180deg, color-mix(in srgb, var(--accent) 24%, var(--panel-2)), var(--panel-2));
        color: var(--accent);
        font-size: 1.2rem;
        box-shadow: 0 14px 40px rgba(0,0,0,0.42);
      }
      #fab-ask:active { transform: scale(0.97); }
      #ask-sheet-scrim {
        display: block;
        position: fixed;
        inset: 0;
        background: rgba(0,0,0,0.42);
        opacity: 0;
        pointer-events: none;
        z-index: 24;
        transition: opacity 0.18s ease;
      }
      #ask-sheet-scrim[data-open="true"] {
        opacity: 1;
        pointer-events: auto;
      }
      #ask-sheet {
        display: grid;
        position: fixed;
        left: 0;
        right: 0;
        bottom: 0;
        z-index: 26;
        max-height: 70vh;
        background: rgba(7, 15, 12, 0.985);
        border-top: 1px solid var(--line);
        border-top-left-radius: 16px;
        border-top-right-radius: 16px;
        transform: translateY(102%);
        transition: transform 0.22s ease;
        padding: 14px 14px max(14px, env(safe-area-inset-bottom));
        gap: 10px;
        grid-template-rows: auto auto auto auto;
        box-shadow: 0 -20px 60px rgba(0,0,0,0.46);
      }
      #ask-sheet[data-open="true"] { transform: translateY(0); }
      #ask-sheet .ask-handle {
        justify-self: center;
        width: 36px;
        height: 4px;
        border-radius: 999px;
        background: var(--line);
      }
      #ask-sheet .console-context {
        color: var(--muted);
        font-size: 0.78rem;
      }
      #ask-sheet .console-row {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        gap: 8px;
      }
      #ask-sheet .console-input {
        min-height: 42px;
        border: 1px solid var(--line);
        border-radius: 8px;
        background: var(--surface-soft);
        color: var(--text);
        padding: 0 12px;
      }
      #ask-sheet button[type="submit"] { min-height: 42px; }
      #ask-sheet .console-output {
        color: var(--muted);
        font-size: 0.78rem;
        max-height: 28vh;
        overflow: auto;
      }
      #ask-sheet .suggestions {
        display: flex;
        gap: 6px;
        overflow-x: auto;
        scrollbar-width: none;
      }
      #ask-sheet .suggestions::-webkit-scrollbar { display: none; }
      #ask-sheet .suggestion { flex-shrink: 0; min-height: 32px; }

      /* Pull-to-refresh indicator. */
      #pull-indicator {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 6px;
        height: 0;
        overflow: hidden;
        color: var(--muted);
        font-size: 0.78rem;
        transition: height 0.18s ease;
      }
      #pull-indicator[data-state="pulling"] { height: 32px; }
      #pull-indicator[data-state="ready"] { height: 32px; color: var(--accent); }
      #pull-indicator[data-state="refreshing"] {
        height: 32px;
        color: var(--cyan);
      }
      #pull-indicator .pi-spinner {
        width: 12px;
        height: 12px;
        border-radius: 999px;
        border: 2px solid var(--line);
        border-top-color: var(--accent);
        animation: spin 0.8s linear infinite;
      }
      #pull-indicator:not([data-state="refreshing"]) .pi-spinner { display: none; }
      @keyframes spin { to { transform: rotate(360deg); } }
    }
  </style>
</head>
<body>
  <main id="monitor-shell" class="command-shell">
    <header class="cmdbar">
      <div class="cmd-left">
        <div class="brand">
          <div class="brand-mark">A</div>
          <div>
            <div class="brand-name">Hermes</div>
            <div class="brand-sub">handoff monitor · averray</div>
          </div>
        </div>
        <div id="sys-block" class="sys" data-state="idle">
          <span class="sys-dot"></span>
          <span id="sys-label" class="sys-label">system idle</span>
          <span id="sys-agents" class="sys-agents hidden" aria-label="Active agents"></span>
        </div>
      </div>
      <div class="cmd-counters" aria-label="Release counters">
        <span class="counter-chip" data-tone="warn"><span id="attention-chip" class="counter-number">0</span><span class="counter-label">needs attention</span></span>
        <span class="counter-chip" data-tone="bad"><span id="blocked-chip" class="counter-number">0</span><span class="counter-label">blocked</span></span>
        <span class="counter-chip"><span id="review-chip" class="counter-number">0</span><span class="counter-label">review</span></span>
        <span class="counter-chip" data-tone="ok"><span id="ready-chip" class="counter-number">0</span><span class="counter-label">ready</span></span>
        <span class="counter-chip"><span id="running-chip" class="counter-number">0</span><span class="counter-label">in flight</span></span>
        <span id="deploy-health-chip" class="counter-chip cc-health" data-state="idle"><span class="counter-number" id="deploy-health-state">IDLE</span><span class="counter-label">deploy health</span></span>
      </div>
      <div class="refresh-cluster">
        <span id="live-status" class="cmd-status cmd-status-rich" data-state="connecting" title="connecting to monitor stream">
          <span class="cmd-status-state" id="live-status-state">connecting</span>
          <span class="cmd-status-sub" id="live-status-sub">auto 5s</span>
        </span>
        <button id="pause" class="cmd-pause" type="button" aria-pressed="false" title="Pause live updates">❚❚</button>
        <span class="refresh-meta"><span>last refresh</span><span id="generated">waiting</span></span>
        <button id="refresh" type="button">Refresh</button>
      </div>
    </header>
    <section class="filterbar" aria-label="Monitor filters">
      <div class="filter-left">
        <input id="monitor-search" class="monitor-search" type="search" placeholder="search PR, repo, correlation id..." autocomplete="off">
        <span class="fb-pill-group">
          <span class="filter-label">Repo</span>
          <button class="toggle-pill" type="button" data-repo-filter="all" aria-pressed="true">all</button>
          <button class="toggle-pill" type="button" data-repo-filter="averray-agent/agent" aria-pressed="false">agent</button>
        </span>
        <span class="fb-pill-group">
          <span class="filter-label">Agent</span>
          <button class="toggle-pill" type="button" data-agent-filter="all" aria-pressed="true">all</button>
          <button class="toggle-pill" type="button" data-agent-filter="codex" aria-pressed="false">codex</button>
          <button class="toggle-pill" type="button" data-agent-filter="hermes" aria-pressed="false">hermes</button>
        </span>
      </div>
      <div class="filter-right">
        <span class="fb-hint">sorted by next-action urgency</span>
        <span class="fb-pill-group" aria-label="Pipeline filters">
          <button class="toggle-pill" type="button" data-pipeline-filter="all" aria-pressed="true">all <span id="board-all">0</span></button>
          <button class="toggle-pill" type="button" data-pipeline-filter="block" aria-pressed="false">blocked <span id="board-block">0</span></button>
          <button class="toggle-pill" type="button" data-pipeline-filter="needs-review" aria-pressed="false">review <span id="board-review">0</span></button>
          <button class="toggle-pill" type="button" data-pipeline-filter="pass" aria-pressed="false">ready <span id="board-ready">0</span></button>
          <button class="toggle-pill" type="button" data-pipeline-filter="running" aria-pressed="false">running <span id="board-running">0</span></button>
        </span>
        <button id="toggle-done" class="toggle-pill" type="button" aria-pressed="false">done lane <span id="done-count">0</span></button>
      </div>
    </section>
    <nav id="mobile-tabs" class="mobile-tabs" aria-label="Mobile lane filters">
      <button class="mobile-tab" type="button" data-mobile-tab="all" aria-pressed="true">All <span class="mt-count" id="mt-all">0</span></button>
      <button class="mobile-tab" type="button" data-mobile-tab="attention" aria-pressed="false">Attention <span class="mt-count" id="mt-attention">0</span></button>
      <button class="mobile-tab" type="button" data-mobile-tab="codex" aria-pressed="false">Codex <span class="mt-count" id="mt-codex">0</span></button>
      <button class="mobile-tab" type="button" data-mobile-tab="hermes" aria-pressed="false">Hermes <span class="mt-count" id="mt-hermes">0</span></button>
      <button class="mobile-tab" type="button" data-mobile-tab="operator" aria-pressed="false">Review <span class="mt-count" id="mt-operator">0</span></button>
      <button class="mobile-tab" type="button" data-mobile-tab="queue" aria-pressed="false">Ready <span class="mt-count" id="mt-queue">0</span></button>
      <button class="mobile-tab" type="button" data-mobile-tab="deploy" aria-pressed="false">Deploy <span class="mt-count" id="mt-deploy">0</span></button>
      <button class="mobile-tab" type="button" data-mobile-tab="done" aria-pressed="false">Done <span class="mt-count" id="mt-done">0</span></button>
    </nav>
    <section class="board-shell">
      <div id="pull-indicator" data-state="idle" aria-hidden="true"><span class="pi-spinner"></span><span class="pi-label">Pull to refresh</span></div>
      <section id="owner-lanes" class="kanban-board" aria-label="Release command board"><div class="empty">Loading command board...</div></section>
    </section>
    <aside id="detail-drawer" class="drawer" data-open="false" aria-label="Selected handoff detail"></aside>
    <form id="command-console" class="command-console" autocomplete="off">
      <section class="console-main" aria-label="Hermes and Codex collaboration transcript">
        <div id="command-output" class="console-output" data-mode="thread" data-auto="true">Waiting for Hermes, Codex, and operator messages...</div>
      </section>
      <aside class="console-compose" aria-label="Collaborate with Codex and Hermes">
        <div class="console-context">
          <span class="compose-mode" role="tablist" aria-label="Compose mode">
            <button type="button" data-compose-mode="post" aria-pressed="true">Post message</button>
            <button type="button" data-compose-mode="ask" aria-pressed="false">Ask Hermes</button>
          </span>
          <span id="console-context">global monitor context</span>
        </div>
        <div class="compose-meta" id="compose-meta">
          <label>To
            <select id="compose-target" name="addressedTo">
              <option value="everyone">Everyone</option>
              <option value="codex">Codex</option>
              <option value="hermes">Hermes</option>
              <option value="operator">Operator</option>
            </select>
          </label>
          <label>Intent
            <select id="compose-intent" name="kind">
              <option value="chat">Chat</option>
              <option value="proposal">Proposal</option>
              <option value="request_help">Needs help</option>
              <option value="status">Status</option>
            </select>
          </label>
        </div>
        <div class="console-row">
          <input id="command-input" class="console-input" name="text" placeholder="Post to Codex, Hermes, or the operator..." autocomplete="off">
          <button id="command-submit" type="submit">Send</button>
        </div>
        <p id="compose-status" class="console-status" aria-live="polite"></p>
        <div class="quick-asks" id="quick-asks">
          <span class="quick-asks-label">Quick asks</span>
          <div class="suggestions" aria-label="Suggested Hermes commands">
            <button class="suggestion" type="button" data-command-suggestion="what is happening now">now</button>
            <button class="suggestion" type="button" data-command-suggestion="what are agents doing">agents</button>
            <button class="suggestion" type="button" data-command-suggestion="what is Codex doing">codex</button>
            <button class="suggestion" type="button" data-command-suggestion="what is Hermes doing">hermes</button>
            <button class="suggestion" type="button" data-command-suggestion="what needs my action">my action</button>
            <button class="suggestion" type="button" data-command-suggestion="handoff monitor details">handoff monitor</button>
            <button class="suggestion" type="button" data-command-suggestion="merge steward details">merge steward</button>
          </div>
        </div>
      </aside>
    </form>
    <button id="fab-ask" type="button" aria-label="Ask Hermes" title="Ask Hermes">💬</button>
    <div id="ask-sheet-scrim" data-open="false"></div>
    <form id="ask-sheet" data-open="false" autocomplete="off" aria-label="Ask Hermes (mobile)">
      <span class="ask-handle"></span>
      <div class="console-context"><strong>Ask Hermes</strong> · <span id="ask-context">global monitor context</span></div>
      <div class="console-row">
        <input id="ask-input" class="console-input" name="text" placeholder="Ask for status, merge steward, why this PR is here..." autocomplete="off">
        <button id="ask-submit" type="submit">Send</button>
      </div>
      <div id="ask-output" class="console-output" data-mode="thread" data-auto="true">Waiting for Hermes, Codex, and operator messages...</div>
      <div class="suggestions" aria-label="Suggested Hermes commands (mobile)">
        <button class="suggestion" type="button" data-command-suggestion="what is happening now">now</button>
        <button class="suggestion" type="button" data-command-suggestion="what are agents doing">agents</button>
        <button class="suggestion" type="button" data-command-suggestion="what is Codex doing">codex</button>
        <button class="suggestion" type="button" data-command-suggestion="what is Hermes doing">hermes</button>
        <button class="suggestion" type="button" data-command-suggestion="what needs my action">my action</button>
        <button class="suggestion" type="button" data-command-suggestion="handoff monitor details">handoff monitor</button>
        <button class="suggestion" type="button" data-command-suggestion="merge steward details">merge steward</button>
      </div>
    </form>
  </main>
  <script>
    const eventsPath = ${eventsPath};
    const streamPath = ${streamPath};
    const commandPath = ${commandPath};
    const codexTasksPath = ${codexTasksPath};
    const recheckPath = ${recheckPath};
    const collaborationPath = ${collaborationPath};
    const token = new URLSearchParams(location.search).get("token");
    const withToken = buildMonitorUrl(eventsPath);
    const streamUrl = buildMonitorUrl(streamPath);
    const commandUrl = buildCommandUrl(commandPath);
    const codexTasksUrl = buildCommandUrl(codexTasksPath);
    const recheckUrl = buildCommandUrl(recheckPath);
    const collaborationUrl = buildCommandUrl(collaborationPath);
    const decisionStorageKey = "averray-monitor-operator-decisions:v1";
    let pipelineFilter = "all";
    let repoFilter = "all";
    let agentFilter = "all";
    let searchText = "";
    let showDone = false;
    let mobileLaneTab = "all"; // mobile-only lane filter (matches boardLaneForItem keys + "all")
    const isMobileViewport = () => window.matchMedia("(max-width: 640px)").matches;
    let selectedKey = "";
    let autoFocusPending = true;
    let latestPipelineItems = [];
    let latestCodexTasks = [];
    let latestCodexRunner = null;
    let latestPayload = null;
    let latestCollabMessages = [];
    // Compose state for the new collaboration "post" mode. The compose form
    // can run in two modes: "post" (POST /monitor/collaboration → real
    // multi-agent message) and "ask" (POST /monitor/command → Hermes
    // read-only insight). Operators flip the toggle; agents always post.
    let composeMode = "post";
    let composeTarget = "everyone";
    let composeIntent = "chat";
    let monitorDecisions = loadMonitorDecisions();
    let pollTimer = null;
    let streamSource = null;

    document.getElementById("refresh").addEventListener("click", () => load());
    document.getElementById("pause").addEventListener("click", () => {
      const btn = document.getElementById("pause");
      const wasPaused = btn.getAttribute("aria-pressed") === "true";
      setMonitorPaused(!wasPaused);
    });
    document.addEventListener("change", (event) => {
      const target = event.target;
      if (!target || target.getAttribute("data-checklist-id") == null) return;
      const id = String(target.getAttribute("data-checklist-id") || "");
      const key = String(target.getAttribute("data-decision-key") || "");
      if (!id || !key) return;
      toggleChecklistItem(key, id, target.checked === true);
      const label = target.closest(".hc-item");
      if (label) label.setAttribute("data-checked", target.checked ? "true" : "false");
    });
    document.getElementById("monitor-search").addEventListener("input", (event) => {
      searchText = String(event.target.value || "").trim().toLowerCase();
      renderBoard(latestPipelineItems);
    });
    document.getElementById("toggle-done").addEventListener("click", () => {
      showDone = !showDone;
      document.getElementById("toggle-done").setAttribute("aria-pressed", String(showDone));
      renderBoard(latestPipelineItems);
    });
    document.addEventListener("click", (event) => {
      const card = event.target && event.target.closest ? event.target.closest("[data-select-card]") : null;
      const interactive = event.target && event.target.closest ? event.target.closest("button,a,input") : null;
      if (card && !interactive) {
        selectedKey = String(card.getAttribute("data-select-card") || "");
        autoFocusPending = false;
        renderBoard(latestPipelineItems);
        renderDrawer(selectedItem());
        renderCommandContext();
        return;
      }
      const closeDrawer = event.target && event.target.closest ? event.target.closest("[data-close-drawer]") : null;
      if (closeDrawer) {
        closeSelectedDrawer();
        return;
      }
      const reviewCard = event.target && event.target.closest ? event.target.closest("[data-review-card]") : null;
      if (reviewCard) {
        selectedKey = String(reviewCard.getAttribute("data-review-card") || "");
        autoFocusPending = false;
        renderBoard(latestPipelineItems);
        renderDrawer(selectedItem());
        renderCommandContext();
        return;
      }
      const copyButton = event.target && event.target.closest ? event.target.closest("[data-copy-text]") : null;
      if (copyButton) {
        const value = String(copyButton.getAttribute("data-copy-text") || "");
        const label = String(copyButton.getAttribute("data-copy-label") || "Copied");
        void navigator.clipboard?.writeText(value);
        const output = document.getElementById("command-output");
        if (output) output.textContent = label + ".";
        return;
      }
      const suggestion = event.target && event.target.closest ? event.target.closest("[data-command-suggestion]") : null;
      if (suggestion) {
        const value = String(suggestion.getAttribute("data-command-suggestion") || "");
        const targetInput = suggestion.closest("#ask-sheet") ? document.getElementById("ask-input") : document.getElementById("command-input");
        if (targetInput) {
          targetInput.value = contextualCommand(value);
          targetInput.focus();
        }
        return;
      }
      const codexTaskButton = event.target && event.target.closest ? event.target.closest("[data-codex-task-action]") : null;
      if (codexTaskButton) {
        void handleCodexTaskAction(codexTaskButton);
        return;
      }
      const recheckButton = event.target && event.target.closest ? event.target.closest("[data-hermes-recheck]") : null;
      if (recheckButton) {
        void handleHermesRecheckAction(recheckButton);
        return;
      }
      const button = event.target && event.target.closest ? event.target.closest("[data-monitor-decision]") : null;
      if (!button) {
        const drawer = event.target && event.target.closest ? event.target.closest("#detail-drawer") : null;
        const consoleSurface = event.target && event.target.closest ? event.target.closest("#command-console,#ask-sheet,#fab-ask") : null;
        if (selectedKey && !drawer && !consoleSurface) closeSelectedDrawer();
        return;
      }
      const key = String(button.getAttribute("data-decision-key") || "");
      const decision = String(button.getAttribute("data-monitor-decision") || "");
      if (!key) return;
      if (decision === "approve") setMonitorDecision(key, { status: "approved", at: new Date().toISOString() });
      if (decision === "reset") setMonitorDecision(key, null);
      if (latestPayload) render(latestPayload);
    });

    function closeSelectedDrawer() {
      selectedKey = "";
      autoFocusPending = false;
      renderBoard(latestPipelineItems);
      renderDrawer(null);
      renderCommandContext();
    }
    document.querySelectorAll("[data-pipeline-filter]").forEach((button) => {
      button.addEventListener("click", () => {
        pipelineFilter = String(button.getAttribute("data-pipeline-filter") || "all");
        updatePipelineFilterButtons();
        renderBoard(latestPipelineItems);
      });
    });
    document.querySelectorAll("[data-repo-filter]").forEach((button) => {
      button.addEventListener("click", () => {
        repoFilter = String(button.getAttribute("data-repo-filter") || "all");
        updateToggleGroup("[data-repo-filter]", repoFilter);
        renderBoard(latestPipelineItems);
      });
    });
    document.querySelectorAll("[data-agent-filter]").forEach((button) => {
      button.addEventListener("click", () => {
        agentFilter = String(button.getAttribute("data-agent-filter") || "all");
        updateToggleGroup("[data-agent-filter]", agentFilter);
        renderBoard(latestPipelineItems);
      });
    });
    document.getElementById("command-console").addEventListener("submit", (event) => {
      event.preventDefault();
      const input = document.getElementById("command-input");
      const text = String(input.value || "").trim();
      if (!text) return;
      if (composeMode === "post") {
        void submitCollaborationPost(text);
      } else {
        void submitMonitorCommand(text);
      }
    });

    // Mode toggle: "post" sends a real message to /monitor/collaboration,
    // "ask" routes back to the existing read-only Hermes insight command.
    document.querySelectorAll("[data-compose-mode]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const mode = String(btn.getAttribute("data-compose-mode") || "post");
        setComposeMode(mode);
      });
    });
    document.getElementById("compose-target")?.addEventListener("change", (event) => {
      composeTarget = String(event.target.value || "everyone");
    });
    document.getElementById("compose-intent")?.addEventListener("change", (event) => {
      composeIntent = String(event.target.value || "chat");
    });
    setComposeMode(composeMode);

    function setComposeMode(mode) {
      composeMode = mode === "ask" ? "ask" : "post";
      document.querySelectorAll("[data-compose-mode]").forEach((btn) => {
        btn.setAttribute("aria-pressed", btn.getAttribute("data-compose-mode") === composeMode ? "true" : "false");
      });
      const composeMeta = document.getElementById("compose-meta");
      const quickAsks = document.getElementById("quick-asks");
      const input = document.getElementById("command-input");
      if (composeMode === "post") {
        if (composeMeta) composeMeta.style.display = "flex";
        if (quickAsks) quickAsks.style.display = "none";
        if (input) input.placeholder = "Post to Codex, Hermes, or the operator...";
        // Switching into post mode is an explicit re-engagement with the
        // conversation; re-engage the thread render too so the operator
        // isn't still staring at a stale Ask-Hermes response.
        forceThreadMode();
        renderAutoCollaborationThread();
      } else {
        if (composeMeta) composeMeta.style.display = "none";
        if (quickAsks) quickAsks.style.display = "grid";
        if (input) input.placeholder = "Ask for status, merge steward, why this PR is here...";
      }
      setComposeStatus("", "");
    }

    function setComposeStatus(text, tone) {
      const el = document.getElementById("compose-status");
      if (!el) return;
      el.textContent = text || "";
      el.setAttribute("data-tone", tone || "");
    }

    // Reset both console outputs to auto-thread mode so the next render
    // pass paints the collaboration thread (and not the residue of a
    // prior "Ask Hermes" response).
    function forceThreadMode() {
      [document.getElementById("command-output"), document.getElementById("ask-output")].forEach((output) => {
        if (!output) return;
        output.dataset.auto = "true";
        output.dataset.mode = "thread";
      });
    }

    // Short post-message poll: after an operator posts, hit GET
    // /monitor/collaboration?sinceMs=<just-posted-ts> a handful of times
    // over ~3 seconds so any Hermes auto-reply (recorded server-side
    // ~800ms after our POST) surfaces visibly without waiting for the
    // next SSE snapshot tick (up to 5s). Bails out as soon as a new
    // message arrives so we don't keep polling forever.
    function pollCollaborationSince(sinceMs) {
      let attempts = 0;
      const maxAttempts = 5;
      const intervalMs = 700;
      const tick = async () => {
        attempts += 1;
        try {
          const url = buildCommandUrl(collaborationPath + "?sinceMs=" + (sinceMs + 1));
          const resp = await fetch(url);
          if (resp.ok) {
            const body = await resp.json();
            if (body && Array.isArray(body.messages) && body.messages.length > 0) {
              const known = new Set((latestCollabMessages || []).map((m) => m && m.id).filter(Boolean));
              const fresh = body.messages.filter((m) => m && m.id && !known.has(m.id));
              if (fresh.length > 0) {
                latestCollabMessages = (latestCollabMessages || []).concat(fresh);
                forceThreadMode();
                renderAutoCollaborationThread();
                return; // got the reply, stop polling
              }
            }
          }
        } catch (e) {
          // Network blips are fine — the next SSE snapshot will surface
          // the reply anyway. Don't spam the console.
        }
        if (attempts < maxAttempts) setTimeout(tick, intervalMs);
      };
      setTimeout(tick, intervalMs);
    }

    async function submitCollaborationPost(text) {
      const submit = document.getElementById("command-submit");
      const input = document.getElementById("command-input");
      const item = selectedItem();
      const payload = {
        author: "operator",
        kind: composeIntent,
        text,
        addressedTo: composeTarget,
      };
      const pr = item && (item.pullRequestNumber || pullRequestNumberFromCorrelation(item.correlationId));
      if (item && pr) payload.relatedPr = { repo: String(item.repo || "averray-agent/agent"), number: Number(pr) };
      if (item && item.correlationId) payload.relatedCorrelationId = String(item.correlationId);
      if (submit) submit.disabled = true;
      setComposeStatus("Posting...", "");
      try {
        const response = await fetch(collaborationUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(result.message || result.error || "HTTP " + response.status);
        if (result && result.message) {
          // Optimistic merge so the new message shows up immediately even
          // before the next SSE snapshot lands (snapshot tick is ~5s).
          const merged = (latestCollabMessages || []).slice();
          merged.push(result.message);
          latestCollabMessages = merged;
          // If the operator had used Ask Hermes earlier in the session the
          // outputs are pinned to data-auto="false" and the thread render
          // would silently no-op. Posting is an explicit re-engagement with
          // the conversation — force the outputs back into thread mode so
          // the new message shows up.
          forceThreadMode();
          renderAutoCollaborationThread();
          // Hermes auto-replies on the server ~800ms after our post. The
          // next SSE snapshot tick is up to 5s away, which feels sluggish
          // for a conversation. Run a short GET poll loop so the reply
          // surfaces in roughly a second.
          pollCollaborationSince(result.message.ts);
        }
        setComposeStatus("Posted.", "ok");
        if (input) input.value = "";
      } catch (error) {
        setComposeStatus("Post failed: " + String(error.message || error), "error");
      } finally {
        if (submit) submit.disabled = false;
      }
    }

    // ── Mobile-only wiring (no-ops on desktop because the elements are hidden) ──

    // Mobile lane-tab strip — clicking a tab filters the flat list to that lane.
    document.querySelectorAll("[data-mobile-tab]").forEach((tab) => {
      tab.addEventListener("click", () => {
        mobileLaneTab = String(tab.getAttribute("data-mobile-tab") || "all");
        document.querySelectorAll("[data-mobile-tab]").forEach((t) => {
          t.setAttribute("aria-pressed", t === tab ? "true" : "false");
        });
        renderBoard(latestPipelineItems);
      });
    });

    // Ask Hermes FAB + bottom sheet (mobile).
    const askFab = document.getElementById("fab-ask");
    const askSheet = document.getElementById("ask-sheet");
    const askScrim = document.getElementById("ask-sheet-scrim");
    function setAskSheetOpen(open) {
      if (!askSheet || !askScrim) return;
      askSheet.setAttribute("data-open", open ? "true" : "false");
      askScrim.setAttribute("data-open", open ? "true" : "false");
      if (open) {
        const item = selectedItem();
        const ctx = document.getElementById("ask-context");
        if (ctx) ctx.textContent = item ? pipelineTitle(item) + " · " + (item.correlationId || "no correlation") : "global monitor context";
        setTimeout(() => document.getElementById("ask-input")?.focus(), 0);
      }
    }
    askFab?.addEventListener("click", () => setAskSheetOpen(askSheet?.getAttribute("data-open") !== "true"));
    askScrim?.addEventListener("click", () => setAskSheetOpen(false));
    askSheet?.addEventListener("submit", (event) => {
      event.preventDefault();
      const input = document.getElementById("ask-input");
      const text = String((input && input.value) || "").trim();
      if (!text) return;
      void submitMonitorCommandFrom(text, document.getElementById("ask-output"));
    });

    // Pull-to-refresh on the board container (mobile).
    const boardEl = document.querySelector(".board-shell");
    const pullIndicator = document.getElementById("pull-indicator");
    let pullStartY = 0;
    let pullDelta = 0;
    let pullActive = false;
    const PULL_THRESHOLD = 64;
    if (boardEl && pullIndicator) {
      boardEl.addEventListener("touchstart", (event) => {
        if (!isMobileViewport()) return;
        if (boardEl.scrollTop > 4) return;
        pullStartY = event.touches[0]?.clientY ?? 0;
        pullDelta = 0;
        pullActive = true;
      }, { passive: true });
      boardEl.addEventListener("touchmove", (event) => {
        if (!pullActive) return;
        const y = event.touches[0]?.clientY ?? 0;
        pullDelta = y - pullStartY;
        if (pullDelta <= 0) {
          pullIndicator.setAttribute("data-state", "idle");
          return;
        }
        pullIndicator.setAttribute("data-state", pullDelta >= PULL_THRESHOLD ? "ready" : "pulling");
        const label = pullIndicator.querySelector(".pi-label");
        if (label) label.textContent = pullDelta >= PULL_THRESHOLD ? "Release to refresh" : "Pull to refresh";
      }, { passive: true });
      boardEl.addEventListener("touchend", () => {
        if (!pullActive) return;
        pullActive = false;
        if (pullDelta >= PULL_THRESHOLD) {
          pullIndicator.setAttribute("data-state", "refreshing");
          const label = pullIndicator.querySelector(".pi-label");
          if (label) label.textContent = "Refreshing…";
          load().finally(() => {
            setTimeout(() => { pullIndicator.setAttribute("data-state", "idle"); }, 400);
          });
        } else {
          pullIndicator.setAttribute("data-state", "idle");
        }
        pullDelta = 0;
      });
    }

    // Bottom-sheet drawer drag-to-dismiss (mobile).
    const drawerEl = document.getElementById("detail-drawer");
    let drawerDragStartY = 0;
    let drawerDragDelta = 0;
    let drawerDragging = false;
    function attachDrawerDragHandle() {
      const handle = drawerEl?.querySelector(".drawer-handle");
      if (!handle || handle.dataset.bound === "1") return;
      handle.dataset.bound = "1";
      handle.addEventListener("touchstart", (event) => {
        if (!isMobileViewport()) return;
        drawerDragStartY = event.touches[0]?.clientY ?? 0;
        drawerDragDelta = 0;
        drawerDragging = true;
        handle.classList.add("dragging");
      }, { passive: true });
      handle.addEventListener("touchmove", (event) => {
        if (!drawerDragging || !drawerEl) return;
        const y = event.touches[0]?.clientY ?? 0;
        drawerDragDelta = Math.max(0, y - drawerDragStartY);
        drawerEl.style.transform = "translateY(" + drawerDragDelta + "px)";
      }, { passive: true });
      handle.addEventListener("touchend", () => {
        if (!drawerDragging || !drawerEl) return;
        drawerDragging = false;
        handle.classList.remove("dragging");
        drawerEl.style.transform = "";
        if (drawerDragDelta > 80) {
          selectedKey = "";
          renderBoard(latestPipelineItems);
          renderDrawer(null);
          renderCommandContext();
        }
        drawerDragDelta = 0;
      });
    }
    // The handle lives inside the drawer body which is rebuilt by
    // renderDrawer(); rebind after every render via a small MutationObserver.
    if (drawerEl) {
      new MutationObserver(() => attachDrawerDragHandle()).observe(drawerEl, { childList: true });
    }

    load();
    startLiveUpdates();

    async function load() {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 12_000);
      try {
        const response = await fetch(withToken, { cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error("HTTP " + response.status);
        render(await response.json());
      } catch (error) {
        updateLiveStatus("error", "update failed");
        renderMonitorLoadError(error);
      } finally {
        clearTimeout(timeout);
      }
    }

    function startLiveUpdates() {
      startPolling("polling 5s");
      if ("EventSource" in window) {
        connectMonitorStream();
      }
    }

    function connectMonitorStream() {
      updateLiveStatus("connecting", "connecting");
      streamSource = new EventSource(streamUrl);
      streamSource.addEventListener("open", () => updateLiveStatus("live", "live"));
      streamSource.addEventListener("monitor", (event) => {
        updateLiveStatus("live", "live");
        render(JSON.parse(event.data));
      });
      streamSource.addEventListener("error", () => {
        updateLiveStatus("error", "reconnecting");
        if (streamSource) streamSource.close();
        streamSource = null;
        startPolling("polling fallback 5s");
      });
    }

    function startPolling(label) {
      if (!streamSource) updateLiveStatus("polling", label || "polling 5s");
      if (pollTimer) return;
      pollTimer = setInterval(load, 5000);
    }

    function renderMonitorLoadError(error) {
      const message = String(error && error.message || error || "unknown error");
      const board = document.getElementById("owner-lanes");
      if (board) {
        board.innerHTML = '<div class="empty error">Monitor data unavailable: ' + escapeHtml(message) + '</div>';
      }
    }

    function updateLiveStatus(state, label) {
      const target = document.getElementById("live-status");
      if (!target) return;
      target.dataset.state = state;
      const stateEl = document.getElementById("live-status-state");
      const subEl = document.getElementById("live-status-sub");
      if (stateEl) stateEl.textContent = liveConnectionLabel(state);
      if (subEl) subEl.textContent = liveConnectionSub(state, label);
      target.setAttribute("title", liveConnectionTitle(state));
    }

    function liveConnectionLabel(state) {
      if (state === "live") return "Live";
      if (state === "polling") return "Polling";
      if (state === "connecting") return "Connecting";
      if (state === "reconnecting") return "Reconnecting";
      if (state === "paused") return "Paused";
      if (state === "stale") return "Stale";
      if (state === "error") return "Error";
      return state;
    }

    function liveConnectionSub(state, label) {
      const text = String(label || "").trim().toLowerCase();
      if (state === "paused") return "click ▶ to resume";
      if (state === "stale") return "no updates · refresh";
      if (state === "live") return text && text !== "live" ? label : "stream open";
      if (state === "polling") return text && text !== "polling" ? label : "auto 5s";
      if (state === "reconnecting" || state === "connecting") return "reconnecting…";
      if (state === "error") return text && text !== "error" ? label : "see console";
      return text || "auto 5s";
    }

    function liveConnectionTitle(state) {
      if (state === "live") return "Connected via SSE · /monitor/stream";
      if (state === "polling") return "Polling fallback · /monitor/events";
      if (state === "reconnecting") return "Reconnecting to event stream…";
      if (state === "paused") return "Live updates paused";
      if (state === "stale") return "No recent events — possibly stale";
      if (state === "error") return "Error fetching events";
      return "Connecting…";
    }

    function setMonitorPaused(paused) {
      const btn = document.getElementById("pause");
      if (btn) {
        btn.setAttribute("aria-pressed", paused ? "true" : "false");
        btn.textContent = paused ? "▶" : "❚❚";
        btn.setAttribute("title", paused ? "Resume live updates" : "Pause live updates");
      }
      if (paused) {
        if (streamSource) { streamSource.close(); streamSource = null; }
        if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
        updateLiveStatus("paused", "paused");
      } else {
        startLiveUpdates();
        load();
      }
    }

    function updateDeployHealth(items) {
      const chip = document.getElementById("deploy-health-chip");
      const state = document.getElementById("deploy-health-state");
      if (!chip || !state) return;
      const deployItems = items.filter(isDeployItem);
      let next = "idle";
      let label = "IDLE";
      if (deployItems.some((d) => releaseVerdict(d).level === "block")) { next = "fail"; label = "FAIL"; }
      else if (deployItems.some((d) => d.active === true || d.activeState === "running" || normalize(d.status) === "running")) { next = "verifying"; label = "VERIFYING"; }
      else if (deployItems.some((d) => releaseVerdict(d).level === "pass")) { next = "ok"; label = "OK"; }
      chip.dataset.state = next;
      state.textContent = label;
    }

    function updateSysAgents(items) {
      const block = document.getElementById("sys-block");
      const labelEl = document.getElementById("sys-label");
      const agentsEl = document.getElementById("sys-agents");
      if (!block || !labelEl || !agentsEl) return;
      const codex = items.filter(isCodexActivelyWorking).length;
      const hermes = items.filter((it) => boardLaneForItem(it, releaseVerdict(it)).key === "hermes").length;
      const deploy = items.filter(isDeployItem).filter((it) => it.active === true || it.activeState === "running" || normalize(it.status) === "running").length;
      const total = codex + hermes + deploy;
      block.classList.toggle("running", total > 0);
      block.dataset.state = total > 0 ? "running" : "idle";
      labelEl.textContent = total > 0 ? "system running" : "system idle";
      const parts = [];
      if (codex > 0) parts.push('<span class="sys-agent" data-agent="codex"><span class="sa-dot"></span>codex ' + codex + '</span>');
      if (hermes > 0) parts.push('<span class="sys-agent" data-agent="hermes"><span class="sa-dot"></span>hermes ' + hermes + '</span>');
      if (deploy > 0) parts.push('<span class="sys-agent" data-agent="deploy"><span class="sa-dot"></span>deploy ' + deploy + '</span>');
      agentsEl.innerHTML = parts.join("");
      agentsEl.classList.toggle("hidden", parts.length === 0);
    }

    function isCodexActivelyWorking(item) {
      const verdict = releaseVerdict(item);
      if (boardLaneForItem(item, verdict).key !== "codex") return false;
      const state = codexWorkState(item, pipelineStage(item, verdict));
      return state.state === "active" || state.state === "ci";
    }

    function toggleChecklistItem(decisionKey, itemId, checked) {
      const existing = monitorDecisions[decisionKey] || {};
      const checklist = Object.assign({}, existing.checklist || {});
      checklist[itemId] = !!checked;
      monitorDecisions[decisionKey] = Object.assign({}, existing, { checklist });
      try { localStorage.setItem(decisionStorageKey, JSON.stringify(monitorDecisions)); } catch {}
    }

    function render(payload) {
      latestPayload = payload;
      const counts = payload.counts || {};
      const recent = payload.recent || [];
      setText("generated", payload.generatedAt ? new Date(payload.generatedAt).toLocaleTimeString() : "unknown");
      latestCollabMessages = normalizeCollabMessages(payload.collaborationMessages);
      latestCodexTasks = normalizeCodexTasks(payload.codexTasks);
      latestCodexRunner = normalizeCodexRunner(payload.codexTasks && payload.codexTasks.runner);
      latestPipelineItems = groupPrPipelineItems(collectPipelineItems(payload));
      const laneCounts = commandBoardLaneCounts(latestPipelineItems);
      const blocked = laneCounts.attention || 0;
      const review = laneCounts.operator || 0;
      const ready = laneCounts.queue || 0;
      const running = (laneCounts.hermes || 0) + (laneCounts.deploy || 0);
      setText("attention-chip", String(blocked + review + (laneCounts.codex || 0)));
      setText("blocked-chip", String(blocked));
      setText("review-chip", String(review));
      setText("ready-chip", String(ready));
      setText("running-chip", String(running));
      updateSysAgents(latestPipelineItems);
      updateDeployHealth(latestPipelineItems);
      renderPipelineBoard(latestPipelineItems);
      renderBoard(latestPipelineItems);
      renderDrawer(selectedItem());
      renderCommandContext();
      renderAutoCollaborationThread();
    }

    function renderList(id, entries, emptyText) {
      const target = document.getElementById(id);
      if (!target) return;
      if (!entries.length) {
        target.innerHTML = '<div class="empty">' + escapeHtml(emptyText) + '</div>';
        return;
      }
      target.innerHTML = entries.map(renderHandoff).join("");
    }

    function renderLiveLane(entries) {
      const target = document.getElementById("active");
      if (!target) return;
      const running = entries.filter((item) => item.active === true || item.activeState === "running" || normalize(item.status) === "running");
      const justFinished = entries.filter((item) => item.activeState === "just_finished");
      if (!running.length && !justFinished.length) {
        target.innerHTML = '<strong>Live lane</strong><span>No running or just-finished handoffs.</span><span class="pill">idle</span>';
        return;
      }
      const lead = running[0] || justFinished[0];
      const parts = [
        running.length ? running.length + " running" : "",
        justFinished.length ? justFinished.length + " just finished" : "",
      ].filter(Boolean).join(" · ");
      target.innerHTML = '<strong>Live lane</strong><span>' + escapeHtml(pipelineTitle(lead) + " - " + releaseReason(lead.summary || {}, lead, "running")) + '</span><span class="pill">' + escapeHtml(parts) + '</span>';
    }

    function renderAgentActivity(items, activeEntries, recentEntries) {
      const target = document.getElementById("agent-activity");
      if (!target) return;
      const codex = codexAgentSnapshot(items);
      const hermes = hermesAgentSnapshot(items, activeEntries);
      target.innerHTML = renderAgentStatusCard(codex) + renderAgentStatusCard(hermes) + renderHandoffRadar(items, activeEntries, recentEntries, codex, hermes);
    }

    function renderAgentStatusCard(snapshot) {
      const tags = snapshot.tags.length
        ? '<div class="agent-status-meta">' + snapshot.tags.map((tag) => '<span class="pill">' + escapeHtml(tag) + '</span>').join("") + '</div>'
        : "";
      const focus = snapshot.detail
        ? '<span><strong>' + escapeHtml(snapshot.title) + '</strong> ' + escapeHtml(snapshot.detail) + '</span>'
        : '<span><strong>' + escapeHtml(snapshot.title) + '</strong></span>';
      return '<article class="agent-status-card" data-agent="' + escapeAttr(snapshot.agent.toLowerCase()) + '" data-state="' + escapeAttr(snapshot.state) + '">' +
        '<div class="agent-status-head"><span class="agent-status-title">' + escapeHtml(snapshot.agent) + '</span><span class="agent-status-state">' + escapeHtml(snapshot.stateLabel) + '</span></div>' +
        '<div class="agent-status-focus"><strong>Now</strong>' + focus + '</div>' +
        '<div class="agent-status-grid">' +
          '<span class="agent-mini"><span>Waiting on</span><strong>' + escapeHtml(snapshot.waitingOn) + '</strong></span>' +
          '<span class="agent-mini"><span>Next handoff</span><strong>' + escapeHtml(snapshot.nextHandoff) + '</strong></span>' +
          '<span class="agent-mini"><span>Updated</span><strong>' + escapeHtml(snapshot.updated) + '</strong></span>' +
        '</div>' +
        tags +
      '</article>';
    }

    function codexAgentSnapshot(items) {
      const runner = latestCodexRunner;
      const runnerStatus = normalize(runner && runner.status);
      const runnerLabel = codexRunnerStatusLabel(runner);
      const tasks = latestCodexTasks.slice().sort((a, b) => taskUpdatedMs(b) - taskUpdatedMs(a));
      const runningTask = tasks.find((task) => normalize(task.status) === "running");
      const approvedTask = tasks.find((task) => normalize(task.status) === "approved");
      const proposedTask = tasks.find((task) => normalize(task.status) === "proposed");
      const codexOwned = topConsoleItems(items.filter((item) => nextPipelineAction(item, releaseVerdict(item)).owner === "Codex"), 1)[0];
      const ciItem = topConsoleItems(items.filter(isCodexActivelyWorking), 1)[0];
      if (runningTask) {
        return {
          agent: "Codex",
          state: "active",
          stateLabel: "active",
          title: codexTaskTitle(runningTask),
          detail: runningTask.progressMessage || "task runner is working now.",
          waitingOn: runner && runner.runnerId ? "runner " + runner.runnerId : "Codex CLI worker",
          nextHandoff: "push branch -> CI -> Hermes",
          updated: taskAgeLabel(runningTask),
          tags: ["runner active", runnerLabel, taskAgeLabel(runningTask)].filter(Boolean),
        };
      }
      if (ciItem) {
        return {
          agent: "Codex",
          state: "active",
          stateLabel: "active",
          title: pipelineTitle(ciItem),
          detail: nextPipelineAction(ciItem, releaseVerdict(ciItem)).text,
          waitingOn: "GitHub checks",
          nextHandoff: "Hermes re-check",
          updated: handoffAge(ciItem).duration,
          tags: ["ci / commit flow", handoffAge(ciItem).duration],
        };
      }
      if (approvedTask) {
        return {
          agent: "Codex",
          state: "waiting",
          stateLabel: "queued",
          title: codexTaskTitle(approvedTask),
          detail: "approved task is waiting for the Codex runner to claim it.",
          waitingOn: runnerStatus ? runnerLabel : "runner pickup",
          nextHandoff: "Codex starts",
          updated: taskAgeLabel(approvedTask),
          tags: ["approved", runnerStatus ? runnerLabel : "waiting runner"],
        };
      }
      if (proposedTask) {
        return {
          agent: "Codex",
          state: "waiting",
          stateLabel: "needs approval",
          title: codexTaskTitle(proposedTask),
          detail: "task is proposed but not approved yet.",
          waitingOn: "operator approval",
          nextHandoff: "Codex runner",
          updated: taskAgeLabel(proposedTask),
          tags: ["proposed", "operator gate"],
        };
      }
      if (codexOwned) {
        return {
          agent: "Codex",
          state: "waiting",
          stateLabel: "needed",
          title: pipelineTitle(codexOwned),
          detail: nextPipelineAction(codexOwned, releaseVerdict(codexOwned)).text,
          waitingOn: "Codex assignment",
          nextHandoff: "commit + CI",
          updated: handoffAge(codexOwned).duration,
          tags: [handoffAge(codexOwned).label.toLowerCase(), "no active run"],
        };
      }
      if (runner && runner.stale) {
        return {
          agent: "Codex",
          state: "waiting",
          stateLabel: "heartbeat stale",
          title: "Codex worker heartbeat is stale.",
          detail: runner.message || "Last runner heartbeat is older than the freshness window.",
          waitingOn: "runner heartbeat",
          nextHandoff: "verify Codex runner",
          updated: codexRunnerAgeLabel(runner),
          tags: [runnerLabel, "check runner"].filter(Boolean),
        };
      }
      if (runnerStatus === "idle" || runnerStatus === "completed") {
        return {
          agent: "Codex",
          state: "idle",
          stateLabel: "idle / online",
          title: "Codex worker online.",
          detail: runner.message || "No approved task is waiting.",
          waitingOn: "approved task",
          nextHandoff: "starts when a task is approved",
          updated: codexRunnerAgeLabel(runner),
          tags: [runnerLabel, runner && runner.stale ? "stale heartbeat" : "heartbeat ok"].filter(Boolean),
        };
      }
      if (["misconfigured", "failed", "error", "disabled"].includes(runnerStatus)) {
        return {
          agent: "Codex",
          state: "waiting",
          stateLabel: runnerStatus === "disabled" ? "disabled" : "runner issue",
          title: "Codex worker needs attention.",
          detail: runner.message || "Runner cannot safely claim work.",
          waitingOn: runnerStatus === "disabled" ? "operator enable" : "runner config",
          nextHandoff: "fix runner before dispatch",
          updated: codexRunnerAgeLabel(runner),
          tags: [runnerLabel, runner && runner.stale ? "stale heartbeat" : "heartbeat"].filter(Boolean),
        };
      }
      return {
        agent: "Codex",
        state: "idle",
        stateLabel: "no heartbeat",
        title: "No Codex heartbeat visible.",
        detail: "Queue proposals can be created, but no Codex runner has checked in yet.",
        waitingOn: "runner heartbeat",
        nextHandoff: "start / verify Codex runner",
        updated: "now",
        tags: ["runner unknown"],
      };
    }

    function hermesAgentSnapshot(items, activeEntries) {
      const active = topConsoleItems(activeEntries.filter((item) => item.active === true || item.activeState === "running" || normalize(item.status) === "running"), 1)[0];
      const hermesOwned = topConsoleItems(items.filter((item) => nextPipelineAction(item, releaseVerdict(item)).owner === "Hermes"), 1)[0];
      const hermesLane = topConsoleItems(items.filter((item) => boardLaneForItem(item, releaseVerdict(item)).key === "hermes"), 1)[0];
      const waiting = hermesOwned || hermesLane;
      if (active) {
        return {
          agent: "Hermes",
          state: "active",
          stateLabel: "active",
          title: pipelineTitle(active),
          detail: "handoff or verification is running now.",
          waitingOn: "Hermes tools",
          nextHandoff: "publish verdict",
          updated: handoffAge(active).duration,
          tags: ["stream event", handoffAge(active).duration],
        };
      }
      if (waiting) {
        return {
          agent: "Hermes",
          state: "waiting",
          stateLabel: "queued",
          title: pipelineTitle(waiting),
          detail: nextPipelineAction(waiting, releaseVerdict(waiting)).text,
          waitingOn: "Hermes invocation",
          nextHandoff: "operator / queue",
          updated: handoffAge(waiting).duration,
          tags: [pipelineStage(waiting, releaseVerdict(waiting)).label, handoffAge(waiting).duration],
        };
      }
      return {
        agent: "Hermes",
        state: "idle",
        stateLabel: "idle",
        title: "No Hermes check active.",
        detail: "No PR re-check, handoff, or deploy verification is waiting on Hermes.",
        waitingOn: "GitHub / operator",
        nextHandoff: "none",
        updated: "now",
        tags: [],
      };
    }

    function renderHandoffRadar(items, activeEntries, recentEntries, codex, hermes) {
      const radarItems = buildAgentRadarItems(items, activeEntries, recentEntries, codex, hermes).slice(0, 5);
      const list = radarItems.length
        ? radarItems.map((entry) => '<li data-owner="' + escapeAttr(entry.owner) + '"><span class="activity-dot"></span><span class="radar-main"><strong>' + escapeHtml(entry.title) + '</strong><span>' + escapeHtml(entry.text) + '</span></span><span class="radar-age">' + escapeHtml(entry.age) + '</span></li>').join("")
        : '<li><span class="activity-dot"></span><span class="radar-main"><strong>All quiet.</strong><span>Codex and Hermes are idle; no owner is currently blocked.</span></span></li>';
      return '<section class="handoff-radar" aria-label="Agent handoff radar">' +
        '<div class="handoff-radar-head"><strong>Agent handoff radar</strong><span>auto-updating</span></div>' +
        '<ul class="handoff-radar-list">' + list + '</ul>' +
      '</section>';
    }

    function buildAgentRadarItems(items, activeEntries, recentEntries, codex, hermes) {
      const rows = buildActivityStreamItems(items, activeEntries, recentEntries);
      return [
        {
          owner: "Codex",
          title: "Codex is " + codex.stateLabel,
          text: codex.title + " - " + codex.detail + " Next: " + codex.nextHandoff + ".",
          age: codex.updated,
          ts: Date.now(),
          priority: codex.state === "active" ? 500 : codex.state === "waiting" ? 360 : 120,
        },
        {
          owner: "Hermes",
          title: "Hermes is " + hermes.stateLabel,
          text: hermes.title + " - " + hermes.detail + " Next: " + hermes.nextHandoff + ".",
          age: hermes.updated,
          ts: Date.now() - 1,
          priority: hermes.state === "active" ? 490 : hermes.state === "waiting" ? 350 : 110,
        },
        ...rows.map((row) => ({
          owner: row.actor,
          title: row.actor,
          text: row.text,
          age: row.age,
          ts: row.ts,
          priority: row.priority,
        })),
      ].sort((a, b) => b.priority - a.priority || b.ts - a.ts);
    }

    function buildActivityStreamItems(items, activeEntries, recentEntries) {
      const rows = [];
      activeEntries.forEach((item) => {
        const isRunning = item.active === true || item.activeState === "running" || normalize(item.status) === "running";
        if (!isRunning) return;
        rows.push({
          actor: "Hermes",
          text: "running " + pipelineTitle(item),
          age: handoffAge(item).duration,
          ts: itemUpdatedMs(item),
          priority: 400,
        });
      });
      if (latestCodexRunner) {
        const runnerStatus = normalize(latestCodexRunner.status);
        const runnerPriority = runnerStatus === "running" ? 390 : ["failed", "error", "misconfigured", "disabled"].includes(runnerStatus) ? 340 : 100;
        rows.push({
          actor: "Codex",
          text: "runner " + codexRunnerStatusLabel(latestCodexRunner) + " - " + (latestCodexRunner.message || "no runner message"),
          age: codexRunnerAgeLabel(latestCodexRunner),
          ts: Date.parse(String(latestCodexRunner.updatedAt || "")) || Date.now(),
          priority: runnerPriority,
        });
      }
      latestCodexTasks.forEach((task) => {
        const status = normalize(task.status);
        if (isTerminalCodexTask(task) && status !== "completed") return;
        if (!["running", "approved", "proposed", "completed"].includes(status)) return;
        const detail = status === "running" && task.progressMessage ? " - " + task.progressMessage : "";
        rows.push({
          actor: "Codex",
          text: status + " " + codexTaskTitle(task) + detail,
          age: taskAgeLabel(task),
          ts: taskUpdatedMs(task),
          priority: status === "running" ? 380 : status === "approved" ? 300 : status === "proposed" ? 220 : 120,
        });
      });
      items.forEach((item) => {
        const verdict = releaseVerdict(item);
        const action = nextPipelineAction(item, verdict);
        if (action.owner === "Done") return;
        rows.push({
          actor: action.owner,
          text: pipelineTitle(item) + " - " + action.text,
          age: handoffAge(item).duration,
          ts: itemUpdatedMs(item),
          priority: action.owner === "Hermes" ? 320 : action.owner === "Codex" ? 280 : action.owner === "Operator" ? 260 : 160,
        });
      });
      recentEntries.slice(0, 6).forEach((item) => {
        if (!item || !item.correlationId) return;
        rows.push({
          actor: item.requester === "github-actions" ? "Hermes" : titleCaseActor(item.requester || item.source || "event"),
          text: (item.intent || "handoff") + " updated " + pipelineTitle(item),
          age: handoffAge(item).duration,
          ts: itemUpdatedMs(item),
          priority: 80,
        });
      });
      return dedupeActivityRows(rows)
        .sort((a, b) => b.priority - a.priority || b.ts - a.ts);
    }

    function dedupeActivityRows(rows) {
      const seen = new Set();
      return rows.filter((row) => {
        const key = row.actor + "|" + row.text;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }

    function codexTaskTitle(task) {
      const repo = task && task.repo ? String(task.repo) : "unknown repo";
      const pr = task && task.pullRequestNumber ? "#" + String(task.pullRequestNumber) : "PR ?";
      return repo + " " + pr;
    }

    function taskUpdatedMs(task) {
      const parsed = Date.parse(String((task && (task.updatedAt || task.createdAt)) || ""));
      return Number.isFinite(parsed) ? parsed : 0;
    }

    function taskAgeLabel(task) {
      const ms = taskUpdatedMs(task);
      if (!ms) return "unknown";
      return formatDuration(Math.max(0, Math.floor((Date.now() - ms) / 60000)));
    }

    function normalizeCodexRunner(value) {
      if (!value || typeof value !== "object") return null;
      return value;
    }

    function codexRunnerAgeLabel(runner) {
      const parsed = Date.parse(String((runner && runner.updatedAt) || ""));
      if (!Number.isFinite(parsed)) return "unknown";
      return formatDuration(Math.max(0, Math.floor((Date.now() - parsed) / 60000)));
    }

    function codexRunnerStatusLabel(runner) {
      if (!runner) return "";
      const status = normalize(runner.status);
      if (runner.stale) return status ? status + " / stale" : "stale heartbeat";
      return status || "heartbeat";
    }

    function titleCaseActor(value) {
      const text = String(value || "event").replace(/[-_]+/g, " ");
      return text.charAt(0).toUpperCase() + text.slice(1);
    }

    function renderBoard(entries) {
      const target = document.getElementById("owner-lanes");
      if (!target) return;
      const filtered = filterCommandBoardItems(entries);
      if (selectedKey && !filtered.some((item) => boardItemKey(item) === selectedKey)) selectedKey = "";
      if (!selectedKey && autoFocusPending) {
        const focusItem = defaultFocusItem(filtered);
        if (focusItem) selectedKey = boardItemKey(focusItem);
      }
      target.dataset.doneExpanded = String(showDone);
      document.getElementById("monitor-shell")?.classList.toggle("has-selection", Boolean(selectedKey));
      const lanes = boardLaneDefinitions();
      // Mobile-tab filter narrows the set to a single lane (or all). The
      // mobile board renders lanes in order, with empty lanes suppressed
      // — empty placeholders are visual noise on a phone.
      const mobile = isMobileViewport();
      const visibleLanes = lanes.filter((lane) => {
        if (mobile) {
          if (mobileLaneTab !== "all" && lane.key !== mobileLaneTab) return false;
          // Hide the Done lane unless the operator explicitly picked it.
          if (lane.key === "done" && mobileLaneTab !== "done") return false;
        } else if (lane.key === "done" && !showDone) {
          return false;
        }
        return true;
      });
      target.innerHTML = visibleLanes
        .map((lane) => renderBoardLane(lane, filtered, { mobile }))
        .join("") + (!mobile && !showDone ? renderDoneStub(filtered) : "");
      updateMobileTabCounts(filtered);
    }

    // Collapsed Done lane: a 44px vertical rail on the right edge of the
    // kanban-board. Click anywhere on it to trigger the existing
    // toggle-done button and expand into the full Done lane. Skipped on
    // mobile (the flat list there has its own done-tab path).
    function renderDoneStub(entries) {
      const done = entries.filter((item) => boardLaneForItem(item, releaseVerdict(item)).key === "done");
      setText("done-count", String(done.length));
      return '<button class="lane done-rail" data-lane="done" type="button" id="done-stub" aria-label="Show done lane" onclick="document.getElementById(\\'toggle-done\\').click()">' +
        '<div class="lane-head"><div class="lane-title">Done ▾ <span class="pill">' + escapeHtml(String(done.length)) + '</span></div></div>' +
        '<div class="lane-body"><div class="lane-empty">' + escapeHtml(done.length ? done.length + " history item" + (done.length === 1 ? "" : "s") + " · click" : "history · click") + '</div></div>' +
        '</button>';
    }

    function updateMobileTabCounts(entries) {
      const counts = { all: 0, attention: 0, codex: 0, hermes: 0, operator: 0, queue: 0, deploy: 0, done: 0 };
      entries.forEach((item) => {
        const key = boardLaneForItem(item, releaseVerdict(item)).key;
        if (counts[key] !== undefined) counts[key] += 1;
        if (key !== "done") counts.all += 1;
      });
      Object.keys(counts).forEach((key) => {
        const el = document.getElementById("mt-" + key);
        if (el) el.textContent = String(counts[key]);
      });
    }

    function filterCommandBoardItems(entries) {
      return entries.filter((item) => {
        const verdict = releaseVerdict(item);
        const lane = boardLaneForItem(item, verdict);
        if (pipelineFilter !== "all") {
          if (pipelineFilter === "pass" && lane.key !== "queue") return false;
          else if (pipelineFilter === "running" && lane.key !== "hermes" && lane.key !== "deploy") return false;
          else if (pipelineFilter === "block" && lane.key !== "attention") return false;
          else if (pipelineFilter === "needs-review" && lane.key !== "operator") return false;
          else if (!["pass", "running", "block", "needs-review"].includes(pipelineFilter) && verdict.level !== pipelineFilter) return false;
        }
        if (repoFilter !== "all" && String(item.repo || "") !== repoFilter) return false;
        if (agentFilter === "codex" && lane.key !== "codex" && nextPipelineAction(item, verdict).owner !== "Codex") return false;
        if (agentFilter === "hermes" && lane.key !== "hermes" && nextPipelineAction(item, verdict).owner !== "Hermes") return false;
        if (searchText) {
          const haystack = [
            item.repo,
            item.pullRequestNumber,
            item.correlationId,
            item.sha,
            item.intent,
            pipelineTitle(item),
            verdict.why,
          ].join(" ").toLowerCase();
          if (!haystack.includes(searchText)) return false;
        }
        return true;
      });
    }

    function boardLaneDefinitions() {
      return [
        { key: "attention", title: "Needs Attention", kicker: "urgent · operator", empty: "No blockers waiting." },
        { key: "codex", title: "Codex Needed", kicker: "agent · action needed", empty: "No Codex action needed." },
        { key: "hermes", title: "Hermes Checking", kicker: "agent · reviewing", empty: "Hermes has no active PR checks." },
        { key: "operator", title: "Operator Review", kicker: "operator · sign-off", empty: "No operator sign-off needed." },
        { key: "queue", title: "Release Queue", kicker: "cleared to merge", empty: "Nothing ready to merge." },
        { key: "deploy", title: "Deploying", kicker: "post-deploy verify", empty: "No deploy verification active." },
        { key: "done", title: "Done", kicker: "release history", empty: "No completed PRs in view." },
      ];
    }

    function commandBoardLaneCounts(entries) {
      return entries.reduce((counts, item) => {
        const key = boardLaneForItem(item, releaseVerdict(item)).key;
        counts[key] = (counts[key] || 0) + 1;
        return counts;
      }, {});
    }

    function renderBoardLane(lane, entries, options) {
      const mobile = Boolean(options && options.mobile);
      const items = entries
        .filter((item) => boardLaneForItem(item, releaseVerdict(item)).key === lane.key)
        .sort((a, b) => boardSortScore(b) - boardSortScore(a) || String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
      // On mobile, suppress empty lanes entirely — the lane header is hidden
      // by CSS but a "Nothing waiting on Codex." card would still take up space.
      if (mobile && items.length === 0) return "";
      const renderer = lane.key === "done" ? renderDoneRow : renderBoardCard;
      const cards = items.length
        ? items.slice(0, lane.key === "done" ? 12 : 8).map((item) => renderer(item, lane)).join("")
        : '<div class="lane-empty">' + escapeHtml(lane.empty) + '</div>';
      return '<section class="lane" data-lane="' + escapeAttr(lane.key) + '">' +
        '<div class="lane-head"><div class="lane-title">' + escapeHtml(lane.title) + ' <span class="pill">' + escapeHtml(String(items.length)) + '</span></div><span class="lane-subtitle">' + escapeHtml(lane.kicker) + '</span></div>' +
        '<div class="lane-body">' + cards + '</div>' +
        '</section>';
    }

    // Compact one-line entry for the Done lane when expanded.
    function renderDoneRow(item /*, lane */) {
      const verdict = releaseVerdict(item);
      const key = boardItemKey(item);
      const selected = key === selectedKey;
      const age = handoffAge(item);
      const repo = String(item.repo || "");
      const repoShort = repo.split("/")[1] || repo;
      const prNumber = item.pullRequestNumber || pullRequestNumberFromCorrelation(item.correlationId);
      const idLabel = prNumber ? "#" + prNumber : (isDeployItem(item) ? "deploy" : "handoff");
      const title = cardTitleText(pipelineTitle(item), prNumber, item);
      return '<button class="done-row" data-select-card="' + escapeAttr(key) + '" data-selected="' + escapeAttr(String(selected)) + '" data-verdict="' + escapeAttr(verdict.level) + '" type="button">' +
        '<span class="done-check">' + (verdict.level === "block" ? "!" : "✓") + '</span>' +
        '<span class="done-id"><span class="done-repo">' + escapeHtml(repoShort) + '</span><span class="done-num">' + escapeHtml(idLabel) + '</span></span>' +
        '<span class="done-title">' + escapeHtml(title) + '</span>' +
        '<span class="done-age">' + escapeHtml(age.label + " " + age.duration) + '</span>' +
        '</button>';
    }

    function renderBoardCard(item, lane) {
      const verdict = releaseVerdict(item);
      const action = nextPipelineAction(item, verdict);
      const stage = pipelineStage(item, verdict);
      const age = handoffAge(item);
      const title = pipelineTitle(item);
      const key = boardItemKey(item);
      const selected = key === selectedKey;
      const signals = (item.summary || {}).reviewSignals || {};
      const touchedAreas = Array.isArray(signals.touchedAreas) ? signals.touchedAreas : [];
      const tests = Array.isArray(signals.testSignals) ? signals.testSignals : [];
      const cardWhy = lane.key === "operator" && verdict.level === "needs-review" ? operatorDecisionShort(item, verdict) : verdict.why;
      const repo = item.repo || "unknown repo";
      const repoShort = String(repo).split("/")[1] || repo;
      const prNumber = item.pullRequestNumber || pullRequestNumberFromCorrelation(item.correlationId);
      const idLabel = prNumber ? "#" + prNumber : (isDeployItem(item) ? "deploy" : "handoff");
      const activeAgent = activeAgentForItem(item, lane, stage);
      const codexState = lane.key === "codex" ? codexWorkState(item, stage) : null;
      const locallyApproved = decisionForItem(item).status === "approved";
      const staleState = age.state || "fresh";
      return '<article class="handoff-card" data-select-card="' + escapeAttr(key) + '" data-selected="' + escapeAttr(String(selected)) + '" data-verdict="' + escapeAttr(verdict.level) + '" data-lane="' + escapeAttr(lane.key) + '">' +
        '<span class="lane-chip" data-lane="' + escapeAttr(lane.key) + '">' + escapeHtml(lane.title) + '</span>' +
        '<div class="card-head">' +
          '<div class="kc-head-l">' +
            '<span class="pill state-pill" data-level="' + escapeAttr(verdict.level) + '">' + escapeHtml(verdict.label) + '</span>' +
            (codexState ? '<span class="work-state" data-state="' + escapeAttr(codexState.state) + '">' + escapeHtml(codexState.label) + '</span>' : "") +
            (activeAgent ? '<span class="active-agent" data-agent="' + escapeAttr(activeAgent.id) + '"><span class="aa-dot"></span>' + escapeHtml(activeAgent.label) + '</span>' : "") +
          '</div>' +
          '<div class="kc-head-r">' +
            '<span class="stale-dot" data-stale="' + escapeAttr(staleState) + '" title="' + escapeAttr(staleState) + '"></span>' +
            '<span class="card-age">' + escapeHtml(age.label + " " + age.duration) + '</span>' +
          '</div>' +
        '</div>' +
        '<div class="kc-id">' +
          '<span class="kc-repo">' + escapeHtml(repoShort) + '</span>' +
          '<span class="kc-num">' + escapeHtml(idLabel) + '</span>' +
          (locallyApproved ? '<span class="kc-local" title="Locally marked operator-approved">local</span>' : "") +
        '</div>' +
        '<h3 class="card-title">' + escapeHtml(cardTitleText(title, prNumber, item)) + '</h3>' +
        renderGroupBadges(item) +
        renderMiniSteps(stage, verdict) +
        '<p class="card-why">' + escapeHtml(cardWhy) + '</p>' +
        '<div class="card-meta-row"><span class="tags">' + touchedAreas.slice(0, 3).map((value) => '<code>' + escapeHtml(String(value)) + '</code>').join("") + '</span><span class="card-subtitle">' + escapeHtml(testSummaryText(tests)) + '</span></div>' +
        '<div class="card-foot"><span class="card-next"><span class="card-next-label">next</span>' + renderActorPill(action.owner) + '</span><span class="card-actions">' + primaryActionButton(item, verdict, action, lane) + '</span></div>' +
        '</article>';
    }

    // Pretty pill for "next actor" — colored dot + arrow + actor name.
    function renderActorPill(owner) {
      const slug = actorSlug(owner);
      const label = String(owner || "—");
      return '<span class="actor-pill" data-actor="' + escapeAttr(slug) + '">' +
        '<span class="actor-dot"></span>' +
        '<span class="actor-arrow">→</span>' +
        '<span class="actor-label">' + escapeHtml(label) + '</span>' +
        '</span>';
    }

    function actorSlug(owner) {
      const v = normalize(owner);
      if (v.indexOf("codex") >= 0) return "codex";
      if (v.indexOf("hermes") >= 0) return "hermes";
      if (v.indexOf("merge") >= 0) return "merge";
      if (v.indexOf("operator") >= 0 || v.indexOf("human") >= 0) return "operator";
      if (v.indexOf("deploy") >= 0) return "deploy";
      if (v.indexOf("done") >= 0) return "done";
      if (v.indexOf("system") >= 0) return "system";
      return "other";
    }

    // Compact card title — drops repo + #PR prefix the kc-id row already shows,
    // and substitutes a readable label for deploy / group / fallback items.
    function cardTitleText(title, prNumber, item) {
      const summary = (item && item.summary) || {};
      const explicit = summary.title || summary.prTitle || summary.pullRequestTitle || item && item.title;
      if (explicit) return String(explicit);
      const raw = String(title || "").trim();
      if (item && isDeployItem(item)) return "Post-deploy verification";
      const derived = derivePrCardTitle(item, summary);
      if (derived) return derived;
      if (prNumber) {
        const stripped = raw.replace(/^[^#]*#\\d+\\s*/, "").trim();
        if (!stripped || stripped === ("#" + prNumber)) return "PR handoff";
        return humaniseIntentLabel(stripped);
      }
      return humaniseIntentLabel(raw);
    }

    // Build a human, item-distinct card title from the verdict + review reasons
    // when the upstream doesn't supply a real PR title. Falls back to null so
    // the caller can decide its own default.
    function derivePrCardTitle(item, summary) {
      if (!item || !item.pullRequestNumber) return null;
      const verdict = baseReleaseVerdict(item);
      const level = verdict.level;
      const reasons = Array.isArray(summary && summary.reviewReasons) ? summary.reviewReasons : [];
      const primary = reasons.find(Boolean);
      if (primary) {
        const message = String(primary.message || "").trim();
        if (message) return clampTitleText(message);
        const code = String(primary.code || "").trim();
        if (code) return humaniseIntentLabel(code);
      }
      const signals = (summary && summary.reviewSignals) || {};
      const touched = Array.isArray(signals.touchedAreas) ? signals.touchedAreas : [];
      if (level === "block") {
        const why = String(verdict.why || "").trim();
        if (why) return clampTitleText(why);
        return "Blocked — investigate";
      }
      if (level === "pass") {
        return touched.length ? "Ready to merge · " + touched.slice(0, 3).join(", ") : "Ready to merge";
      }
      if (level === "running") {
        return touched.length ? "Hermes reviewing · " + touched.slice(0, 3).join(", ") : "Hermes reviewing";
      }
      if (level === "needs-review") {
        return touched.length ? "Operator review · " + touched.slice(0, 3).join(", ") : "Operator review";
      }
      return null;
    }

    function clampTitleText(text) {
      const trimmed = String(text || "").trim();
      if (trimmed.length <= 90) return trimmed;
      return trimmed.slice(0, 87).trimEnd() + "…";
    }

    function humaniseIntentLabel(value) {
      const normalized = String(value || "").trim();
      if (!normalized) return "Handoff";
      return normalized.replace(/[_-]+/g, " ").replace(/\\s+/g, " ").replace(/\\b\\w/g, (c) => c.toUpperCase());
    }

    // Decide which agent is actively working on this item right now.
    // Returns { id, label } or null if no agent is active.
    function activeAgentForItem(item, lane, stage) {
      const status = normalize(item.status);
      const stageKey = (stage && stage.key) || "";
      if (isDeployItem(item) && (item.active === true || status === "running" || stageKey === "deploy")) {
        return { id: "deploy", label: "Deploy verifying" };
      }
      if (lane && lane.key === "codex") {
        const state = codexWorkState(item, stage);
        if (state.state === "active") return { id: "codex", label: "Codex active" };
        return null;
      }
      if (lane && lane.key === "hermes") return { id: "hermes", label: "Hermes reviewing" };
      if (item.activeState === "running" || item.active === true) {
        if (stageKey === "hermes" || stageKey === "review") return { id: "hermes", label: "Hermes reviewing" };
        if (stageKey === "ci" || stageKey === "pr") return { id: "codex", label: "Codex active" };
        if (stageKey === "deploy") return { id: "deploy", label: "Deploy verifying" };
        return { id: "hermes", label: "Hermes reviewing" };
      }
      return null;
    }

    function codexWorkState(item, stage) {
      const task = codexTaskForItem(item);
      if (task && !isTerminalCodexTask(task)) {
        const status = normalize(task.status);
        if (status === "proposed") {
          return {
            state: "proposed",
            label: "Codex proposed",
            detail: "Hermes prepared a Codex task. Operator approval is needed before Codex should pick it up.",
            task,
          };
        }
        if (status === "approved") {
          return {
            state: "approved",
            label: "Codex approved",
            detail: "Operator approved this Codex task. The Codex worker/app should pick it up next.",
            task,
          };
        }
        if (status === "running") {
          return {
            state: "active",
            label: "Codex active",
            detail: "Codex is currently working on the approved task.",
            task,
          };
        }
      }
      if (task && normalize(task.status) === "completed") {
        if (codexTaskCompletedAfterHermesReview(item)) {
          return {
            state: "handoff",
            label: "Codex done",
            detail: "Codex reported this task completed. Hermes should re-check the PR before it moves to operator review or merge queue.",
            task,
          };
        }
        return {
          state: "completed",
          label: "Codex done",
          detail: "Codex task runner reported this task completed and a newer Hermes/GitHub signal exists.",
          task,
        };
      }
      if (task && normalize(task.status) === "failed") {
        return {
          state: "failed",
          label: "Codex failed",
          detail: "Codex task runner reported failure. Inspect the runner output or send a smaller follow-up task.",
          task,
        };
      }
      const summary = item.summary || {};
      const reason = normalize(summary.finalReason || summary.reason || item.reason);
      const explicit = normalize(summary.codexState || summary.codexStatus || item.codexState || item.codexStatus);
      if (explicit === "active" || explicit === "running" || explicit === "writing") {
        return { state: "active", label: "Codex active", detail: "Codex is currently writing or pushing updates for this item." };
      }
      if (explicit === "ci" || explicit === "ci_after_codex" || explicit === "ci_after_update") {
        return { state: "ci", label: "CI after Codex", detail: "Codex already pushed an update; CI is rerunning before Hermes reviews again." };
      }
      if (reason === "ci_in_progress") {
        return { state: "ci", label: "CI after Codex", detail: "Codex appears to have pushed an update; wait for CI before assigning more work." };
      }
      const stageKey = (stage && stage.key) || "";
      if (stageKey === "ci" && hasRecentCodexSignal(item)) {
        return { state: "ci", label: "CI after Codex", detail: "A recent Codex signal exists and CI is the current gate." };
      }
      if (hasRecentCodexSignal(item)) {
        return { state: "active", label: "Codex active", detail: "Recent Codex activity was detected for this PR." };
      }
      return { state: "waiting", label: "Waiting for Codex", detail: "No active Codex run detected. Copy this prompt and paste it into a Codex thread/app; the Hermes console below is read-only." };
    }

    function codexTaskCompletedAfterHermesReview(item) {
      const task = codexTaskForItem(item);
      if (!task || normalize(task.status) !== "completed") return false;
      if (isDraftPullRequest(item)) return false;
      const completed = Date.parse(String(task.completedAt || task.updatedAt || ""));
      if (!Number.isFinite(completed)) return true;
      return completed > latestHermesReviewMs(item);
    }

    function codexTaskFailedForItem(item) {
      const task = codexTaskForItem(item);
      return Boolean(task && normalize(task.status) === "failed");
    }

    function latestHermesReviewMs(item) {
      return itemEvents(item).reduce((latest, entry) => {
        const summary = entry.summary || {};
        const requester = normalize(entry.requester || summary.requester);
        const intent = normalize(entry.intent);
        const source = normalize(summary.source);
        if (requester === "github_live" || requester === "github-live" || source === "github_live") return latest;
        const hermesLike = requester === "github-actions"
          || requester === "operator"
          || intent === "pr_handoff"
          || intent === "pr_code_review"
          || intent === "testbed_suite";
        if (!hermesLike) return latest;
        const time = Date.parse(String(entry.updatedAt || entry.completedAt || entry.startedAt || ""));
        return Number.isFinite(time) ? Math.max(latest, time) : latest;
      }, 0);
    }

    function hasRecentCodexSignal(item) {
      const now = Date.now();
      return itemEvents(item).some((entry) => {
        const text = [
          entry.intent,
          entry.requester,
          entry.reason,
          entry.summary && entry.summary.requester,
          entry.summary && entry.summary.actor,
          entry.summary && entry.summary.codexState,
          entry.summary && entry.summary.codexStatus,
          entry.summary && entry.summary.finalReason,
        ].map((value) => String(value || "")).join(" ").toLowerCase();
        if (!text.includes("codex")) return false;
        const t = Date.parse(String(entry.updatedAt || entry.createdAt || ""));
        if (!Number.isFinite(t)) return true;
        return now - t <= 30 * 60 * 1000;
      });
    }

    function itemEvents(item) {
      return [item].concat(Array.isArray(item.groupItems) ? item.groupItems : []);
    }

    function codexPromptForItem(item, summary, verdict, action) {
      const repo = String(item.repo || "averray-agent/agent");
      const pr = item.pullRequestNumber || pullRequestNumberFromCorrelation(item.correlationId);
      const prLabel = pr ? "PR #" + pr : "this PR";
      const title = cardTitleText(pipelineTitle(item), pr, item);
      const correlation = item.correlationId ? " Correlation: " + item.correlationId + "." : "";
      if (isDraftPullRequest(item)) {
        return "Continue " + repo + " " + prLabel + " (" + title + "). The Hermes monitor shows the PR is still DRAFT and no active Codex run is detected. Finish the draft work, run the relevant checks, push updates, and mark the PR ready for review when complete. Do not merge or deploy." + correlation;
      }
      if (verdict.level === "block" && action.owner === "Codex") {
        const request = buildFixRequest(item, summary || item.summary || {}, verdict, action);
        return "Fix " + repo + " " + prLabel + " (" + title + "). Hermes reports BLOCK: " + request.reason + ". " + request.instruction + " Run/check: " + (request.checks.length ? request.checks.join(", ") : "the relevant local checks and CI") + ". Push the smallest fix, then let CI and Hermes re-run. Do not merge or deploy." + correlation;
      }
      if (action.owner === "Codex") {
        return "Continue " + repo + " " + prLabel + " (" + title + "). Hermes says Codex owns the next action: " + action.text + ". Push the update and let CI/Hermes re-run. Do not merge or deploy." + correlation;
      }
      return "";
    }

    function renderMiniSteps(stage, verdict) {
      const steps = ["pr", "ci", "hermes", "testbed", "gate", "deploy"];
      const activeIndex = Math.max(0, steps.indexOf(stage.key));
      return '<div class="mini-steps" aria-label="Pipeline progress">' + steps.map((key, index) => {
        return '<span class="mini-step" data-state="' + escapeAttr(pipelineStepState(index, activeIndex, key, verdict.level)) + '"></span>';
      }).join("") + '</div>';
    }

    function primaryActionButton(item, verdict, action, lane) {
      if (lane.key === "codex") {
        const state = codexWorkState(item, pipelineStage(item, verdict));
        if (state.state === "proposed" && state.task) {
          return '<button class="soft-button" data-action="primary" type="button" data-codex-task-action="approve" data-codex-task-id="' + escapeAttr(state.task.id) + '">Approve task</button>';
        }
        if (state.state === "approved" && state.task) {
          return '<button class="soft-button" type="button" data-review-card="' + escapeAttr(boardItemKey(item)) + '">Approved</button>';
        }
        if (state.state === "waiting") {
          return '<button class="soft-button" data-action="primary" type="button" data-codex-task-action="propose" data-card-key="' + escapeAttr(boardItemKey(item)) + '">Propose Codex task</button>';
        }
        if (state.state === "ci") return '<button class="soft-button" type="button" data-command-suggestion="github status">Check CI</button>';
        return '<button class="soft-button" type="button" data-review-card="' + escapeAttr(boardItemKey(item)) + '">Inspect Codex state</button>';
      }
      if (verdict.level === "block") return '<button class="soft-button" data-action="primary" type="button" data-review-card="' + escapeAttr(boardItemKey(item)) + '">Fix plan -></button>';
      if (isDraftPullRequest(item)) return '<button class="soft-button" data-action="primary" type="button" data-review-card="' + escapeAttr(boardItemKey(item)) + '">Codex draft -></button>';
      if (verdict.level === "needs-review") return '<button class="soft-button" data-action="primary" type="button" data-review-card="' + escapeAttr(boardItemKey(item)) + '">Review</button>';
      if (verdict.level === "running") return '<button class="soft-button" data-action="primary" type="button" data-command-suggestion="handoff monitor details">Ask Hermes</button>';
      if (verdict.level === "pass" && lane.key === "queue") return '<button class="soft-button" data-action="primary" type="button" data-command-suggestion="merge steward details">Queue Merge</button>';
      return '<button class="soft-button" type="button" data-command-suggestion="handoff monitor details">Inspect</button>';
    }

    function boardLaneForItem(item, verdict) {
      const summary = item.summary || {};
      const status = normalize(item.status);
      const reason = normalize(summary.finalReason || summary.reason || item.reason);
      const prState = pullRequestState(item, summary);
      if (isDonePullRequestState(prState)) return { key: "done" };
      if (isDeployItem(item)) {
        if (item.active === true || item.activeState === "running" || status === "running") return { key: "deploy" };
        return verdict.level === "pass" ? { key: "done" } : { key: "attention" };
      }
      if (item.active === true || item.activeState === "running" || status === "running") return { key: "hermes" };
      const codexTask = codexTaskForItem(item);
      if (codexTaskFailedForItem(item)) return { key: "attention" };
      if (codexTask && !isTerminalCodexTask(codexTask)) return { key: "codex" };
      if (isDraftPullRequest(item)) return { key: "codex" };
      if (codexTaskCompletedAfterHermesReview(item)) return { key: "hermes" };
      if (reason === "ci_in_progress" || reason === "pr_checks_active") return { key: "codex" };
      if (verdict.level === "block") return { key: "attention" };
      if (verdict.level === "needs-review") return { key: "operator" };
      if (verdict.level === "pass") return { key: "queue" };
      return { key: "hermes" };
    }

    function isDeployItem(item) {
      const intent = normalize(item.intent);
      const correlationId = String(item.correlationId || "");
      return intent.includes("deploy") || intent === "testbed_suite" || correlationId.startsWith("github-deploy-");
    }

    function boardSortScore(item) {
      const verdict = releaseVerdict(item);
      const age = handoffAge(item);
      if (verdict.level === "block") return 900;
      if (age.state === "stale") return 700;
      if (verdict.level === "needs-review") return 600;
      if (verdict.level === "running") return 500;
      if (verdict.level === "pass") return 300;
      return 100;
    }

    function boardItemKey(item) {
      return prIdentityKey(item) + ":" + String(item.intent || "handoff");
    }

    function defaultFocusItem(entries) {
      const sorted = [...entries]
        .filter((item) => boardLaneForItem(item, releaseVerdict(item)).key !== "done")
        .sort((a, b) => boardSortScore(b) - boardSortScore(a) || String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
      return sorted[0] || null;
    }

    function selectedItem() {
      if (!selectedKey) return null;
      return latestPipelineItems.find((item) => boardItemKey(item) === selectedKey) || null;
    }

    function itemByBoardKey(key) {
      if (!key) return null;
      return latestPipelineItems.find((item) => boardItemKey(item) === key) || null;
    }

    function normalizeCodexTasks(value) {
      if (Array.isArray(value)) return value.filter(Boolean);
      if (value && Array.isArray(value.items)) return value.items.filter(Boolean);
      return [];
    }

    function codexTaskForItem(item) {
      if (!item) return null;
      const repo = String(item.repo || "");
      const pr = Number(item.pullRequestNumber || pullRequestNumberFromCorrelation(item.correlationId));
      if (!repo || !Number.isFinite(pr) || pr < 1) return null;
      const candidates = latestCodexTasks
        .filter((task) => String(task.repo || "") === repo && Number(task.pullRequestNumber) === pr)
        .sort((a, b) => Date.parse(String(b.updatedAt || b.createdAt || "")) - Date.parse(String(a.updatedAt || a.createdAt || "")));
      return candidates.find((task) => !isTerminalCodexTask(task)) || candidates[0] || null;
    }

    function isTerminalCodexTask(task) {
      const status = normalize(task && task.status);
      return status === "completed" || status === "failed" || status === "cancelled";
    }

    function renderDrawer(item) {
      const target = document.getElementById("detail-drawer");
      if (!target) return;
      if (!item) {
        target.dataset.open = "false";
        target.innerHTML = "";
        return;
      }
      const summary = item.summary || {};
      const verdict = releaseVerdict(item);
      const action = nextPipelineAction(item, verdict);
      const stage = pipelineStage(item, verdict);
      const age = handoffAge(item);
      const prUrl = item.pullRequestUrl || derivePullRequestUrl(item);
      const workflowRunUrl = deriveWorkflowRunUrl(item);
      const commitUrl = deriveCommitUrl(item);
      const title = pipelineTitle(item);
      const signals = summary.reviewSignals || {};
      const touchedAreas = Array.isArray(signals.touchedAreas) ? signals.touchedAreas : [];
      const touchedFiles = Array.isArray(signals.touchedFiles) ? signals.touchedFiles : [];
      const testSignals = Array.isArray(signals.testSignals) ? signals.testSignals : [];
      const missingTests = Array.isArray(signals.missingTestSignals) ? signals.missingTestSignals : [];
      const rollout = signals.rolloutNotesRequired === true
        ? signals.rolloutNotesPresent === true ? "present" : "missing"
        : "not required";
      const reviewWhy = reviewReasonRows(summary) || row("Why", escapeHtml(verdict.why));
      const decision = decisionForItem(item);
      const locallyApproved = decision.status === "approved";
      const links = [
        prUrl ? '<a class="pill" href="' + escapeAttr(prUrl) + '" target="_blank" rel="noreferrer">open PR</a>' : "",
        workflowRunUrl ? '<a class="pill" href="' + escapeAttr(workflowRunUrl) + '" target="_blank" rel="noreferrer">workflow run</a>' : "",
        commitUrl ? '<a class="pill" href="' + escapeAttr(commitUrl) + '" target="_blank" rel="noreferrer">commit</a>' : "",
      ].filter(Boolean).join("");
      target.dataset.open = "true";
      const drawerTitle = pipelineTitle(item);
      const drawerTitleShort = cardTitleText(drawerTitle, item.pullRequestNumber || pullRequestNumberFromCorrelation(item.correlationId), item);
      const richReviewWhy = renderReviewReasonsRich(summary) || (verdict.why ? '<div class="rw-note">' + escapeHtml(verdict.why) + '</div>' : "");
      target.innerHTML = '<div class="drawer-handle" aria-label="Drag to close"></div>' +
        '<div class="drawer-head">' +
        '<div class="drawer-topline">' +
          '<span class="pill state-pill" data-level="' + escapeAttr(verdict.level) + '">' + escapeHtml(verdict.label) + '</span>' +
          (locallyApproved ? '<span class="kc-local" title="Locally marked operator-approved">local</span>' : "") +
          '<span class="dr-spacer"></span>' +
          (links ? '<span class="drawer-head-links">' + links + '</span>' : "") +
          '<span class="pill dr-age">' + escapeHtml(age.label + " " + age.duration) + '</span>' +
          '<button class="soft-button dr-close" type="button" data-close-drawer aria-label="Close drawer">✕</button>' +
        '</div>' +
        '<h2 class="drawer-title"><span class="drawer-title-id">' + escapeHtml(drawerTitle) + '</span><span class="drawer-title-text">' + escapeHtml(drawerTitleShort) + '</span></h2>' +
        '</div>' +
        '<div class="drawer-body">' +
        (verdict.level === "block" ? '<section class="drawer-section">' + renderFailureCallout(verdict, summary) + '</section>' : "") +
        '<section class="drawer-section"><h3>Hermes verdict</h3>' + renderHermesVerdictBox(verdict, age) + (richReviewWhy ? '<div class="review-why">' + richReviewWhy + '</div>' : "") + '</section>' +
        '<section class="drawer-section">' + renderHandoffOwnerContract(item, verdict, action) + '</section>' +
        '<section class="drawer-section">' + renderActionRecipe(item, summary, verdict, action) + '</section>' +
        renderCodexTaskPrompt(item, summary, verdict, action) +
        (verdict.level === "block" ? renderBlockResolutionPanel(item, summary, verdict, action) : "") +
        (verdict.level === "needs-review" && !isDraftPullRequest(item) ? '<section class="drawer-section">' + renderOperatorChecklistPanel(item, verdict, action) + '</section>' : "") +
        '<section class="drawer-section"><h3>Agent pre-check</h3>' + renderAgentPrecheckList(item, summary, verdict, stage) + '</section>' +
        '<section class="drawer-section"><h3>Checks</h3>' + renderCheckMatrix(summary, testSignals) + '</section>' +
        ((touchedFiles.length || touchedAreas.length) ? '<section class="drawer-section"><h3>Touched files</h3>' + renderTouchedFiles(touchedFiles, touchedAreas) + '</section>' : "") +
        '<section class="drawer-section"><h3>Timeline</h3>' + renderTimelineList(stage, verdict, item) + '</section>' +
        '<section class="drawer-section"><h3>References</h3>' + renderReferencesKv(item, prUrl, workflowRunUrl, commitUrl, rollout, action) + '</section>' +
        renderPhaseHistorySection(item) +
        renderOperatorDecisionNote(item) +
        '</div>' +
        '<div class="drawer-footer">' +
        '<div class="card-actions">' +
        (prUrl ? '<a class="pill" href="' + escapeAttr(prUrl) + '" target="_blank" rel="noreferrer">Open PR</a>' : "") +
        (workflowRunUrl ? '<a class="pill" href="' + escapeAttr(workflowRunUrl) + '" target="_blank" rel="noreferrer">Workflow Run</a>' : "") +
        '<button class="soft-button" type="button" data-command-suggestion="handoff monitor details">Ask Hermes</button>' +
        renderCodexFooterAction(item, summary, verdict, action) +
        '<button class="soft-button" type="button" data-copy-text="' + escapeAttr(item.correlationId || "") + '">copy correlation</button>' +
        (verdict.level === "needs-review" && !isDraftPullRequest(item) && !locallyApproved ? '<button class="soft-button" data-action="primary" type="button" data-monitor-decision="approve" data-decision-key="' + escapeAttr(decisionKeyForItem(item)) + '">' + escapeHtml(isReleaseReviewVerdict(verdict) ? "Mark reviewed" : "Approve locally") + '</button>' : "") +
        '</div></div>';
    }

    function renderFailureCallout(verdict, summary) {
      const text = String(verdict.why || (summary && summary.finalReason) || "Build is blocked.").trim();
      return '<div class="failure-callout"><span class="fc-icon">!</span><span class="fc-text">' + escapeHtml(text) + '</span></div>';
    }

    function renderHermesVerdictBox(verdict, age) {
      return '<div class="verdict-box" data-level="' + escapeAttr(verdict.level) + '">' +
        '<div class="vb-head"><span>' + escapeHtml(verdict.label) + '</span><span class="vb-age">' + escapeHtml(age.label + " " + age.duration) + '</span></div>' +
        '<div class="vb-text">' + escapeHtml(shortenVerdictWhy(verdict.why)) + '</div>' +
        '</div>';
    }

    function renderHandoffOwnerContract(item, verdict, action) {
      const contract = ownerContractForItem(item, verdict, action);
      return '<h3>Handoff owner</h3><div class="owner-contract">' +
        '<div class="oc-current"><span class="oc-owner">Current owner: ' + escapeHtml(contract.owner) + '</span><span class="oc-action">' + escapeHtml(contract.action) + '</span></div>' +
        '<div class="oc-roles">' +
          '<div class="oc-role"><strong>Codex</strong><span>builds code, fixes blockers, resolves draft readiness, and pushes PR updates.</span></div>' +
          '<div class="oc-role"><strong>Hermes</strong><span>runs read-only PR checks, code-risk review, testbed verification, and publishes the verdict.</span></div>' +
          '<div class="oc-role"><strong>Operator</strong><span>decides project intent, architecture, rollout, and business risk after agent pre-check evidence exists.</span></div>' +
          '<div class="oc-role"><strong>Queue</strong><span>merges only after branch protection, Hermes verdict, and any operator sign-off are clean.</span></div>' +
        '</div>' +
      '</div>';
    }

    function ownerContractForItem(item, verdict, action) {
      if (isDraftPullRequest(item)) {
        return {
          owner: "Codex",
          action: "Finish the draft or mark it ready for review. Hermes and Operator should wait until the draft state clears.",
        };
      }
      if (verdict.level === "block") {
        return {
          owner: action.owner,
          action: action.text,
        };
      }
      if (verdict.level === "needs-review") {
        return {
          owner: "Operator",
          action: "Review the project-level decision request only. Code-level analysis should already be attached by Hermes/Codex.",
        };
      }
      return {
        owner: action.owner,
        action: action.text,
      };
    }

    function renderActionRecipe(item, summary, verdict, action) {
      const recipe = actionRecipeForItem(item, summary, verdict, action);
      return '<h3>Action recipe</h3><div class="action-recipe">' +
        '<dl class="recipe-grid">' +
          row("Owner", escapeHtml(recipe.owner)) +
          row("Why here", escapeHtml(recipe.why)) +
          row("Ask", escapeHtml(recipe.ask)) +
          row("Clears when", escapeHtml(recipe.clearsWhen)) +
          row("Proof", recipe.proof.length ? '<span class="recipe-proof">' + recipe.proof.map((value) => '<code>' + escapeHtml(value) + '</code>').join("") + '</span>' : escapeHtml("No proof recorded yet")) +
        '</dl>' +
      '</div>';
    }

    function renderCodexTaskPrompt(item, summary, verdict, action) {
      const prompt = codexPromptForItem(item, summary, verdict, action);
      if (!prompt) return "";
      const state = codexWorkState(item, pipelineStage(item, verdict));
      const task = state.task || codexTaskForItem(item);
      return '<section class="drawer-section codex-task-prompt"><h3>Codex task prompt</h3>' +
        '<p class="codex-state-note">' + escapeHtml(state.detail) + '</p>' +
        renderCodexQueueBox(task) +
        '<pre class="prompt-box">' + escapeHtml(prompt) + '</pre>' +
        '<div class="card-actions">' +
          renderCodexTaskControlButtons(item, task, prompt) +
          renderCodexFallbackCopyButton(task, prompt) +
        '</div>' +
        '</section>';
    }

    function renderCodexQueueBox(task) {
      if (!task) {
        return '<div class="codex-queue-box" data-status="none">' +
          '<div class="codex-queue-head"><span>Codex task queue</span><span>not proposed</span></div>' +
          '<div class="codex-queue-body">This is still a proposal. Use "Propose Codex task" to record it, then approve it when you want Codex to work.</div>' +
        '</div>';
      }
      const status = normalize(task.status) || "unknown";
      return '<div class="codex-queue-box" data-status="' + escapeAttr(status) + '">' +
        '<div class="codex-queue-head"><span>Codex task queue</span><span>' + escapeHtml(status) + '</span></div>' +
        '<div class="codex-queue-body">' + escapeHtml(codexTaskStatusText(task)) + '</div>' +
        renderCodexTaskProgress(task) +
        renderCodexTaskEvents(task) +
        '<div class="codex-queue-id">' + escapeHtml(task.id || "unknown task") + '</div>' +
      '</div>';
    }

    function renderCodexTaskProgress(task) {
      const message = String(task.progressMessage || "").trim();
      const tail = lastCodexTaskTail(task);
      if (!message && !tail) return "";
      return '<div class="codex-queue-progress">' +
        (message ? '<span>' + escapeHtml(message) + '</span>' : "") +
        (tail ? '<code>' + escapeHtml(tail) + '</code>' : "") +
      '</div>';
    }

    function renderCodexTaskEvents(task) {
      const events = Array.isArray(task.events) ? task.events.slice(-5).reverse() : [];
      if (!events.length) return "";
      return '<ul class="codex-task-events">' + events.map((event) => {
        const at = event && event.at ? shortTime(event.at) : "--";
        const message = event && event.message ? String(event.message) : "";
        return '<li><time>' + escapeHtml(at) + '</time><span>' + escapeHtml(message) + '</span></li>';
      }).join("") + '</ul>';
    }

    function lastCodexTaskTail(task) {
      const stderr = String(task.stderrTail || "").trim().split(/\\r?\\n/).filter(Boolean).slice(-1)[0] || "";
      const stdout = String(task.stdoutTail || "").trim().split(/\\r?\\n/).filter(Boolean).slice(-1)[0] || "";
      return stderr || stdout;
    }

    function renderCodexFooterAction(item, summary, verdict, action) {
      const prompt = codexPromptForItem(item, summary, verdict, action);
      if (!prompt) return "";
      const task = codexTaskForItem(item);
      return renderCodexTaskControlButtons(item, task, prompt);
    }

    function renderCodexTaskControlButtons(item, task, prompt) {
      if (task && !isTerminalCodexTask(task)) {
        const status = normalize(task.status);
        if (status === "proposed") {
          return '<button class="soft-button" data-action="primary" type="button" data-codex-task-action="approve" data-codex-task-id="' + escapeAttr(task.id) + '">Approve Codex task</button>' +
            '<button class="soft-button" type="button" data-codex-task-action="cancel" data-codex-task-id="' + escapeAttr(task.id) + '">Cancel task</button>';
        }
        if (status === "approved") {
          return '<button class="soft-button" data-action="primary" type="button" data-copy-label="' + escapeAttr(codexCopyLabel()) + '" data-copy-text="' + escapeAttr(task.prompt || prompt) + '">Copy prompt fallback</button>' +
            '<button class="soft-button" type="button" data-codex-task-action="cancel" data-codex-task-id="' + escapeAttr(task.id) + '">Cancel task</button>';
        }
        return '<button class="soft-button" type="button" data-copy-label="' + escapeAttr(codexCopyLabel()) + '" data-copy-text="' + escapeAttr(task.prompt || prompt) + '">Copy Codex prompt</button>';
      }
      if (task && normalize(task.status) === "completed" && codexTaskCompletedAfterHermesReview(item)) {
        return '<button class="soft-button" data-action="primary" type="button" data-hermes-recheck="true" data-card-key="' + escapeAttr(boardItemKey(item)) + '">Ask Hermes to re-check</button>';
      }
      if (task && normalize(task.status) === "failed") {
        return '<button class="soft-button" data-action="primary" type="button" data-codex-task-action="propose" data-card-key="' + escapeAttr(boardItemKey(item)) + '">Propose retry</button>';
      }
      return '<button class="soft-button" data-action="primary" type="button" data-codex-task-action="propose" data-card-key="' + escapeAttr(boardItemKey(item)) + '">Propose Codex task</button>';
    }

    function renderCodexFallbackCopyButton(task, prompt) {
      const status = normalize(task && task.status);
      if (status === "approved" || status === "running") return "";
      return '<button class="soft-button" type="button" data-copy-label="' + escapeAttr(codexCopyLabel()) + '" data-copy-text="' + escapeAttr(prompt) + '">Copy for Codex app</button>';
    }

    function codexTaskStatusText(task) {
      const status = normalize(task && task.status);
      if (status === "proposed") return "Hermes proposed this task. It is waiting for operator approval before Codex should work on it.";
      if (status === "approved") return "Operator approved this task. The Codex task runner may claim it next; use copy only as a fallback if no runner is configured.";
      if (status === "running") return "Codex task runner is actively working on this task.";
      if (status === "completed") return "Codex task runner reported this task completed. Hermes should re-check if this completion is newer than the last handoff verdict.";
      if (status === "failed") return "Codex task runner reported this task failed; send a smaller retry task or inspect the runner output.";
      if (status === "cancelled") return "This Codex task was cancelled.";
      return "No Codex task status recorded.";
    }

    function codexCopyLabel() {
      return "Codex prompt copied — paste it into a Codex thread/app, not the Hermes console";
    }

    function actionRecipeForItem(item, summary, verdict, action) {
      if (isDraftPullRequest(item)) {
        const state = codexWorkState(item, pipelineStage(item, verdict));
        return {
          owner: "Codex",
          why: "The PR is still a draft, so it is not ready for Hermes/operator release judgment.",
          ask: state.state === "waiting" ? "Start or continue Codex with the task prompt. Finish the draft work or mark the PR ready for review." : "Wait for Codex/CI to finish before assigning more work.",
          clearsWhen: "GitHub reports draft=false and CI/Hermes run on the ready PR.",
          proof: ["draft=false", "CI green", "Hermes verdict"],
        };
      }
      if (verdict.level === "block") {
        const plan = blockResolutionPlan(item, summary, verdict, action);
        return {
          owner: plan.owner,
          why: plan.reason,
          ask: plan.steps[0] || action.text,
          clearsWhen: plan.clearsWhen,
          proof: plan.evidence.length ? plan.evidence : ["new commit", "CI/Hermes re-run"],
        };
      }
      if (verdict.level === "needs-review") {
        return {
          owner: "Operator",
          why: "Hermes/Codex completed the code-level pre-check, but project intent, architecture, or rollout risk needs sign-off.",
          ask: "Read the operator checklist, approve locally only if the project-level risk is acceptable, otherwise send it back to Codex.",
          clearsWhen: "Operator approves locally or Codex updates the PR so Hermes no longer asks for sign-off.",
          proof: ["agent pre-check", "operator checklist", "rollout decision"],
        };
      }
      if (verdict.level === "running") {
        return {
          owner: "Hermes",
          why: "A handoff or deploy verification is still in flight.",
          ask: "Wait for Hermes to finish checks and publish a final verdict.",
          clearsWhen: "The live handoff emits PASS, BLOCK, or OPERATOR REVIEW.",
          proof: ["live event", "final verdict"],
        };
      }
      if (verdict.level === "pass") {
        return {
          owner: action.owner,
          why: "No blocking release signal is recorded for this item.",
          ask: action.text,
          clearsWhen: "The PR is merged or the deploy verification is recorded as healthy.",
          proof: ["branch protection green", "Hermes PASS"],
        };
      }
      return {
        owner: action.owner,
        why: "The monitor has not received enough metadata to assign a stronger action.",
        ask: action.text,
        clearsWhen: "CI and Hermes metadata arrive.",
        proof: ["CI metadata", "Hermes metadata"],
      };
    }

    // Drop verbose prefixes Hermes adds to roll-up verdicts so the box reads as a clear summary.
    function shortenVerdictWhy(why) {
      const text = String(why || "").trim();
      if (!text) return "";
      const m = text.match(/^Strictest result across [^:]+:\\s*(.*)$/i);
      if (m && m[1]) return m[1].trim();
      return text;
    }

    // Render reviewReasons[] as severity-chip + message rows.
    function renderReviewReasonsRich(summary) {
      const reasons = Array.isArray(summary && summary.reviewReasons) ? summary.reviewReasons : [];
      if (!reasons.length) return "";
      return '<div class="rw-list">' + reasons.slice(0, 4).map((reason) => {
        const severity = normalize(reason && reason.severity);
        const sevClass = severity === "high" || severity === "blocker" ? "bad"
          : severity === "medium" || severity === "warn" ? "warn"
          : "info";
        const code = String((reason && reason.code) || "review");
        const message = String((reason && reason.message) || "Operator review recommended.");
        return '<div class="rw-row" data-severity="' + escapeAttr(sevClass) + '">' +
          '<span class="rw-sev" data-severity="' + escapeAttr(sevClass) + '">' + escapeHtml(severity || "info") + '</span>' +
          '<span class="rw-body"><span class="rw-code">' + escapeHtml(code) + '</span><span class="rw-msg">' + escapeHtml(message) + '</span></span>' +
        '</div>';
      }).join("") + '</div>';
    }

    function renderOperatorChecklistPanel(item, verdict, action) {
      const decision = decisionForItem(item);
      const items = operatorChecklistItems(item, verdict, action);
      const ticked = (decision.checklist || {});
      const tickCount = items.filter((entry) => ticked[entry.id] === true).length;
      const head = '<div class="operator-checklist-head"><span>Operator checklist</span><span>' + tickCount + ' / ' + items.length + '</span></div>';
      const rows = items.map((entry) => {
        const checked = ticked[entry.id] === true;
        return '<label class="hc-item" data-checked="' + (checked ? "true" : "false") + '">' +
          '<input type="checkbox" data-checklist-id="' + escapeAttr(entry.id) + '" data-decision-key="' + escapeAttr(decisionKeyForItem(item)) + '"' + (checked ? " checked" : "") + ">" +
          '<span>' + escapeHtml(entry.label) + '</span>' +
          '</label>';
      }).join("");
      return '<div class="operator-checklist">' + head + rows + '</div>';
    }

    function operatorChecklistItems(item, verdict, action) {
      const summary = item.summary || {};
      const signals = summary.reviewSignals || {};
      const touchedAreas = Array.isArray(signals.touchedAreas) ? signals.touchedAreas : [];
      const items = [];
      items.push({ id: "intent", label: "Project intent and architecture are right for this change." });
      items.push({ id: "scope", label: "Rollout scope and feature-flag plan are recorded." });
      const rolloutNeeded = signals.rolloutNotesRequired === true && signals.rolloutNotesPresent !== true;
      items.push({ id: "rollout", label: rolloutNeeded ? "Rollout notes attached or risk is acceptable without them." : "Rollout notes match the change risk." });
      if (touchedAreas.some((a) => /contract|solidity/i.test(String(a)))) {
        items.push({ id: "abi", label: "ABI / on-chain compat verified for downstream consumers." });
      } else if (touchedAreas.some((a) => /indexer/i.test(String(a)))) {
        items.push({ id: "indexer", label: "Indexer schema/migration impact reviewed." });
      } else {
        items.push({ id: "blast", label: "Blast radius for affected surfaces is bounded." });
      }
      return items;
    }

    function renderAgentPrecheckList(item, summary, verdict, stage) {
      const signals = summary.reviewSignals || {};
      const stageKey = (stage && stage.key) || "";
      const tests = Array.isArray(signals.testSignals) ? signals.testSignals : [];
      const missing = Array.isArray(signals.missingTestSignals) ? signals.missingTestSignals : [];
      const ciState = verdict.level === "block" ? "bad" : (stageKey === "ci" ? "warn" : "ok");
      const reviewState = stageKey === "hermes" ? "warn" : (verdict.level === "needs-review" ? "warn" : "ok");
      const abiState = signals.abiCompatible === false ? "bad" : (signals.abiCompatChecked === true ? "ok" : "warn");
      const staticState = signals.staticAnalysisHigh > 0 ? "bad" : (Number(signals.staticAnalysisHigh || 0) > 0 ? "warn" : "ok");
      const rolloutState = signals.rolloutNotesRequired === true
        ? (signals.rolloutNotesPresent === true ? "ok" : "warn")
        : "ok";
      const rows = [
        { state: ciState, label: "CI green (forge, node, typecheck, lint)", note: ciState === "ok" ? "all required jobs green" : (ciState === "warn" ? "ci running" : "ci has failures") },
        { state: reviewState, label: "Hermes code review", note: reviewState === "ok" ? "no blocking signals" : "review in progress" },
        { state: abiState, label: "ABI / contract compat scan", note: abiState === "ok" ? "no breaking ABI changes" : (abiState === "warn" ? "scan pending" : "breaking change detected") },
        { state: staticState, label: "Static analysis (slither / lint)", note: signals.staticAnalysisHigh > 0 ? Number(signals.staticAnalysisHigh) + " high" : "0 high · " + Number(signals.staticAnalysisInfo || 0) + " informational" },
        { state: missing.length ? "warn" : "ok", label: "Tests cover changed areas", note: tests.length ? tests.length + " signals" : (missing.length ? missing.length + " missing" : "no tests recorded") },
        { state: rolloutState, label: "Rollout notes", note: signals.rolloutNotesRequired === true ? (signals.rolloutNotesPresent ? "present" : "missing") : "not required" },
      ];
      return '<div class="precheck-list">' + rows.map((r) => (
        '<div class="pc-item">' +
          '<span class="pc-tick" data-state="' + escapeAttr(r.state) + '"></span>' +
          '<span class="pc-label">' + escapeHtml(r.label) + '</span>' +
          '<span class="pc-note">' + escapeHtml(r.note) + '</span>' +
        '</div>'
      )).join("") + '</div>';
    }

    function renderCheckMatrix(summary, testSignals) {
      const checks = collectCheckMatrix(summary, testSignals);
      if (!checks.length) return '<div class="empty">No checks reported.</div>';
      const pass = checks.filter((c) => c.state === "pass").length;
      const fail = checks.filter((c) => c.state === "fail").length;
      const pending = checks.length - pass - fail;
      return '<div class="check-matrix">' +
        checks.map((c) => '<div class="cm-row" data-state="' + escapeAttr(c.state) + '">' +
          '<span class="cm-dot"></span>' +
          '<span class="cm-name">' + escapeHtml(c.name) + '</span>' +
          '<span class="cm-state-pill">' + escapeHtml(c.state) + '</span>' +
        '</div>').join("") +
        '</div>' +
        '<div class="cm-summary">' +
          '<span class="cm-sum-pass">' + pass + '<span class="cm-sum-label">pass</span></span>' +
          '<span class="cm-sum-fail">' + fail + '<span class="cm-sum-label">fail</span></span>' +
          '<span class="cm-sum-pending">' + pending + '<span class="cm-sum-label">pending</span></span>' +
        '</div>';
    }

    function collectCheckMatrix(summary, testSignals) {
      const explicit = Array.isArray(summary && summary.checks) ? summary.checks : [];
      if (explicit.length) {
        return explicit.map((c) => ({
          name: prettyCheckName(c.name || c.id || "check"),
          state: normalizeCheckState(c.state || c.conclusion || c.status),
        }));
      }
      const signals = Array.isArray(testSignals) ? testSignals : [];
      return signals.slice(0, 8).map((value) => {
        const text = String(value || "");
        const state = /fail/i.test(text) ? "fail" : (/pend|wait|run/i.test(text) ? "pending" : "pass");
        return { name: prettyCheckName(text), state };
      });
    }

    function prettyCheckName(value) {
      return String(value || "").replace(/^check:\\s*/i, "").trim() || "check";
    }

    function normalizeCheckState(value) {
      const v = normalize(value);
      if (["success", "pass", "passed", "ok", "green"].indexOf(v) >= 0) return "pass";
      if (["failure", "failed", "fail", "blocked", "red", "error"].indexOf(v) >= 0) return "fail";
      return "pending";
    }

    function renderTouchedFiles(files, areas) {
      const groups = groupTouchedFilesByArea(files, areas);
      if (!groups.length) return '<div class="empty">No file paths recorded.</div>';
      const withPaths = groups.filter((g) => g.paths.length > 0);
      // No file paths in any area — show a single compact line of touched-area chips instead of N empty groups.
      if (withPaths.length === 0) {
        const chipsHtml = groups.map((g) => '<span class="tf-chip">' + escapeHtml(g.area) + '</span>').join("");
        return '<div class="touched-files-compact">' + chipsHtml + '<span class="tf-note">file paths not surfaced</span></div>';
      }
      return '<div class="touched-files">' + withPaths.map((g) => (
        '<div class="tf-group">' +
          '<div class="tf-group-head"><span class="tf-area">' + escapeHtml(g.area) + '</span><span class="tf-count">' + g.paths.length + '</span></div>' +
          g.paths.slice(0, 6).map((p) => '<div class="tf-path">' + escapeHtml(p) + '</div>').join("") + (g.paths.length > 6 ? '<div class="tf-path">+' + (g.paths.length - 6) + " more</div>" : "") +
        '</div>'
      )).join("") + '</div>';
    }

    function groupTouchedFilesByArea(files, areas) {
      const byArea = {};
      const order = [];
      const seed = Array.isArray(areas) ? areas : [];
      seed.forEach((a) => { if (!byArea[a]) { byArea[a] = []; order.push(a); } });
      const list = Array.isArray(files) ? files : [];
      list.forEach((f) => {
        const path = typeof f === "string" ? f : (f && f.path) || "";
        if (!path) return;
        const area = (typeof f === "object" && f && f.area) ? f.area : inferAreaFromPath(path);
        if (!byArea[area]) { byArea[area] = []; order.push(area); }
        byArea[area].push(path);
      });
      return order.map((area) => ({ area, paths: byArea[area] || [] }));
    }

    function inferAreaFromPath(path) {
      const p = String(path || "").toLowerCase();
      if (p.startsWith("contracts/") || p.endsWith(".sol")) return "solidity";
      if (p.startsWith("indexer/")) return "indexer";
      if (p.startsWith("mcp-server/") || p.startsWith("backend/") || p.startsWith("services/")) return "backend";
      if (p.startsWith("app/") || p.startsWith("frontend/") || p.endsWith(".tsx")) return "frontend";
      if (p.startsWith("scripts/") || p.startsWith("ops/")) return "ops";
      if (p.startsWith("docs/") || p.endsWith(".md")) return "docs";
      if (p.startsWith("test/") || p.startsWith("tests/")) return "tests";
      return "other";
    }

    function renderTimelineList(stage, verdict, item) {
      const phases = [
        { key: "pr", label: "PR opened" },
        { key: "ci", label: "CI" },
        { key: "codex", label: "Codex" },
        { key: "hermes", label: "Hermes" },
        { key: "gate", label: "Operator / Gate" },
        { key: "deploy", label: "Deploy" },
      ];
      const activeIndex = Math.max(0, phases.findIndex((p) => p.key === stage.key));
      const rows = phases.map((p, i) => {
        let rowState = "pending";
        let rowLabel = "—";
        if (i < activeIndex) { rowState = "pass"; rowLabel = "PASS"; }
        else if (i === activeIndex) {
          if (verdict.level === "block") { rowState = "fail"; rowLabel = "FAIL"; }
          else if (verdict.level === "needs-review") { rowState = "review"; rowLabel = "REVIEW"; }
          else if (verdict.level === "running") { rowState = "running"; rowLabel = "RUNNING"; }
          else { rowState = "pass"; rowLabel = "PASS"; }
        }
        if (p.key === "deploy" && isDeployItem(item) && (item.active === true || item.activeState === "running")) {
          rowState = "running";
          rowLabel = "RUNNING";
        }
        return '<div class="tl-row" data-state="' + escapeAttr(rowState) + '">' +
          '<span class="tl-dot"></span>' +
          '<span class="tl-label">' + escapeHtml(p.label) + '</span>' +
          '<span class="tl-state">' + escapeHtml(rowLabel) + '</span>' +
        '</div>';
      }).join("");
      return '<div class="timeline-list">' + rows + '</div>';
    }

    function renderReferencesKv(item, prUrl, workflowRunUrl, commitUrl, rollout, action) {
      const sha = item.sha ? compactSha(item.sha) : "n/a";
      const branch = item.branch || (item.summary && item.summary.branch) || (item.summary && item.summary.ref) || "";
      const requester = item.requester || (item.summary && item.summary.requester) || (item.summary && item.summary.actor) || "";
      const correlation = item.correlationId || "";
      return '<dl class="ref-kv">' +
        '<dt>commit</dt><dd>' + (commitUrl ? '<a class="pill" href="' + escapeAttr(commitUrl) + '" target="_blank" rel="noreferrer">' + escapeHtml(sha) + '</a>' : escapeHtml(sha)) + '</dd>' +
        (branch ? '<dt>branch</dt><dd>' + escapeHtml(String(branch)) + '</dd>' : "") +
        (requester ? '<dt>requester</dt><dd>' + escapeHtml(String(requester)) + '</dd>' : "") +
        '<dt>workflow</dt><dd>' + (workflowRunUrl ? '<a class="pill" href="' + escapeAttr(workflowRunUrl) + '" target="_blank" rel="noreferrer">open run</a>' : "n/a") + '</dd>' +
        '<dt>rollout</dt><dd>' + escapeHtml(String(rollout)) + '</dd>' +
        '<dt>correlation</dt><dd><code>' + escapeHtml(correlation || "unknown") + '</code></dd>' +
        '<dt>next action</dt><dd>' + escapeHtml(action.text) + '</dd>' +
        (prUrl ? '<dt>github</dt><dd><a class="pill" href="' + escapeAttr(prUrl) + '" target="_blank" rel="noreferrer">open PR</a></dd>' : "") +
        '</dl>';
    }

    function renderPhaseHistorySection(item) {
      const entries = collectPhaseHistory(item);
      if (!entries.length) return "";
      const rows = entries.map((e) => (
        '<div class="ph-row" data-state="' + escapeAttr(e.state) + '">' +
          '<span class="ph-time">' + escapeHtml(e.time) + '</span>' +
          '<span class="ph-dot"></span>' +
          '<span>' + escapeHtml(e.label) + '</span>' +
        '</div>'
      )).join("");
      return '<section class="drawer-section"><h3>Phase history</h3><div class="phase-history">' + rows + '</div></section>';
    }

    function collectPhaseHistory(item) {
      const entries = [];
      const now = Date.now();
      if (Array.isArray(item.groupItems)) {
        item.groupItems.forEach((entry) => {
          const t = entry.updatedAt || entry.createdAt;
          if (!t) return;
          const verdict = baseReleaseVerdict(entry);
          entries.push({
            time: relativeTimeShort(now - Date.parse(t)),
            state: stateForLevel(verdict.level),
            label: handoffKindLabel(entry.intent) + " · " + String(verdict.label).toLowerCase(),
          });
        });
      } else if (item.updatedAt) {
        const verdict = baseReleaseVerdict(item);
        entries.push({
          time: relativeTimeShort(now - Date.parse(item.updatedAt)),
          state: stateForLevel(verdict.level),
          label: handoffKindLabel(item.intent) + " · " + String(verdict.label).toLowerCase(),
        });
      }
      return entries.slice(-6);
    }

    function relativeTimeShort(ms) {
      const n = Number(ms);
      if (!Number.isFinite(n) || n < 0) return "just now";
      const sec = Math.floor(n / 1000);
      if (sec < 60) return sec + "s ago";
      const min = Math.floor(sec / 60);
      if (min < 60) return min + "m ago";
      const hr = Math.floor(min / 60);
      if (hr < 24) return hr + "h ago";
      const day = Math.floor(hr / 24);
      return day + "d ago";
    }

    function shortTime(value) {
      const ms = Date.parse(String(value || ""));
      if (!Number.isFinite(ms)) return "--";
      return relativeTimeShort(Date.now() - ms);
    }

    function stateForLevel(level) {
      if (level === "block") return "fail";
      if (level === "needs-review") return "review";
      if (level === "running") return "running";
      return "pass";
    }

    function operatorChecklistSection(item, verdict, action) {
      if (verdict.level !== "needs-review") return "";
      const brief = operatorDecisionBrief(item, verdict, action);
      return '<section class="drawer-section operator-decision"><h3>Operator decision</h3>' +
        '<div class="operator-brief">' +
        '<p class="operator-brief-line">' + escapeHtml(brief.summary) + '</p>' +
        '<div class="operator-evidence">' + brief.evidence.map((entry) => {
          return '<div class="operator-evidence-item"><span class="operator-evidence-label">' + escapeHtml(entry.label) + '</span><span class="operator-evidence-value">' + entry.value + '</span></div>';
        }).join("") + '</div>' +
        '<div><h3>Approve only if</h3><ul class="operator-checklist">' + brief.approveIf.map((value) => '<li>' + escapeHtml(value) + '</li>').join("") + '</ul></div>' +
        '<div><h3>Send back to Codex if</h3><ul class="operator-checklist">' + brief.sendBackIf.map((value) => '<li>' + escapeHtml(value) + '</li>').join("") + '</ul></div>' +
        '</div></section>';
    }

    function operatorDecisionShort(item, verdict) {
      return operatorDecisionBrief(item, verdict, nextPipelineAction(item, verdict)).summary;
    }

    function operatorDecisionBrief(item, verdict, action) {
      const summary = item.summary || {};
      const signals = summary.reviewSignals || {};
      const request = buildFixRequest(item, summary, verdict, action);
      const reviewReasons = Array.isArray(summary.reviewReasons) ? summary.reviewReasons : [];
      const touchedAreas = Array.isArray(signals.touchedAreas) ? signals.touchedAreas.map(String).filter(Boolean) : [];
      const surfaces = request.surfaces.length ? request.surfaces : touchedAreas;
      const testSignals = Array.isArray(signals.testSignals) ? signals.testSignals.map(String).filter(Boolean) : [];
      const missingTests = Array.isArray(signals.missingTestSignals) ? signals.missingTestSignals.map(String).filter(Boolean) : [];
      const rollout = signals.rolloutNotesRequired === true
        ? signals.rolloutNotesPresent === true ? "present" : "missing"
        : "not required";
      const reasonCodes = isReleaseReviewVerdict(verdict)
        ? ["ready_for_operator_release_review"]
        : reviewReasons.map((reason) => String((reason && reason.code) || "")).filter(Boolean);
      return {
        summary: operatorDecisionSummary(request, surfaces, reasonCodes),
        evidence: [
          { label: "Hermes checked", value: escapeHtml("CI, PR state, touched areas, test signals, rollout notes") },
          { label: "Review gate", value: escapeHtml(request.reason) },
          { label: "Touched", value: surfaces.length ? chips(surfaces.slice(0, 8)) : escapeHtml("n/a") },
          { label: "Tests", value: escapeHtml(operatorTestEvidence(testSignals, missingTests)) },
          { label: "Rollout notes", value: escapeHtml(rollout) },
          { label: "Correlation", value: '<code>' + escapeHtml(item.correlationId || "unknown") + '</code>' },
        ],
        approveIf: operatorApproveChecklist(surfaces, reasonCodes, missingTests),
        sendBackIf: operatorSendBackChecklist(surfaces, reasonCodes, missingTests, rollout),
      };
    }

    function operatorDecisionSummary(request, surfaces, reasonCodes) {
      const surfaceText = surfaces.length ? surfaces.join(", ") : "the gated surface";
      if (request.reason === "ready_for_operator_release_review") {
        return "Hermes PASS is recorded. Operator decision: do a quick release-packet review before this PR moves into the merge queue.";
      }
      if (hasSurfaceSignal(surfaces, reasonCodes, ["blockchain", "xcm", "settlement", "escrow", "claim", "submit"])) {
        return "Hermes has already done the code-level pre-check. Operator decision: confirm the blockchain/XCM settlement intent, metadata semantics, and rollout risk for " + surfaceText + ".";
      }
      if (hasSurfaceSignal(surfaces, reasonCodes, ["contract", "solidity", "router", "migration"])) {
        return "Hermes has already done the code-level pre-check. Operator decision: confirm the contract or schema architecture is intentional and acceptable for release.";
      }
      if (hasSurfaceSignal(surfaces, reasonCodes, ["secret", "deploy", "ops", "workflow", "infra"])) {
        return "Hermes has already done the code-level pre-check. Operator decision: confirm the operational change, secret boundary, and rollback story are acceptable.";
      }
      if (hasSurfaceSignal(surfaces, reasonCodes, ["lockfile", "dependency", "deps"])) {
        return "Hermes has already done the code-level pre-check. Operator decision: confirm this dependency or lockfile change is expected and low-risk.";
      }
      return "Hermes has already done the code-level pre-check. Operator decision: confirm project intent, architecture direction, and release risk; do not re-review the implementation line by line.";
    }

    function operatorApproveChecklist(surfaces, reasonCodes, missingTests) {
      if (reasonCodes.includes("ready_for_operator_release_review")) {
        return [
          "The change intent matches what you want shipped.",
          "Hermes PASS, CI, and touched-surface evidence are enough for this release.",
          "Rollout/rollback notes are acceptable for the affected surface.",
        ];
      }
      const items = [
        "The PR intent matches the project direction and no architecture question remains open.",
        "Hermes and CI evidence are enough for this risk level; you are not being asked for line-by-line code review.",
      ];
      if (hasSurfaceSignal(surfaces, reasonCodes, ["blockchain", "xcm", "settlement", "escrow", "claim", "submit"])) {
        items.push("Request metadata preservation, claim/submit routing, settlement IDs, and proof semantics match the intended platform contract.");
        items.push("Rollback or retry notes are acceptable for stuck settlement, chain/indexer mismatch, or failed submit paths.");
      } else if (hasSurfaceSignal(surfaces, reasonCodes, ["contract", "solidity", "router", "migration"])) {
        items.push("The contract/schema change is intentionally part of the release, with compatible callers and migration expectations.");
      } else if (hasSurfaceSignal(surfaces, reasonCodes, ["secret", "deploy", "ops", "workflow", "infra"])) {
        items.push("The operational boundary is right: no plaintext secrets, no accidental mutation path, and rollback/deploy notes are clear.");
      } else if (hasSurfaceSignal(surfaces, reasonCodes, ["lockfile", "dependency", "deps"])) {
        items.push("The dependency bump is expected, scoped, and compatible with the touched package area.");
      }
      if (missingTests.length) {
        items.push("Missing test signals are acceptable for this PR, or the PR explains why the existing coverage is enough.");
      } else {
        items.push("Recorded tests cover the touched surface well enough for merge.");
      }
      return items;
    }

    function operatorSendBackChecklist(surfaces, reasonCodes, missingTests, rollout) {
      if (reasonCodes.includes("ready_for_operator_release_review")) {
        return [
          "The intended product behavior or architecture is not what you want shipped.",
          "The release packet does not explain enough about tests, rollout, or blast radius.",
          "The PR should be split, clarified, or sent back to Codex before merge.",
        ];
      }
      const items = [
        "The intended product behavior or architecture is unclear, surprising, or not what you want shipped.",
        "Hermes evidence is missing, stale, contradictory, or does not match the PR risk.",
      ];
      if (hasSurfaceSignal(surfaces, reasonCodes, ["blockchain", "xcm", "settlement", "escrow", "claim", "submit"])) {
        items.push("Codex did not clearly preserve request metadata, settlement IDs, claim/submit routing, or failure semantics.");
      }
      if (rollout === "missing") {
        items.push("Rollout or rollback notes are required but missing.");
      }
      if (missingTests.length) {
        items.push("Missing tests should be added or explicitly justified before you sign off.");
      }
      return items;
    }

    function operatorTestEvidence(testSignals, missingTests) {
      const seen = testSignals.length ? testSignals.length + " recorded" : "none recorded";
      const missing = missingTests.length ? ", " + missingTests.length + " missing" : ", none missing";
      return seen + missing;
    }

    function hasSurfaceSignal(surfaces, reasonCodes, needles) {
      const haystack = surfaces.concat(reasonCodes).join(" ").toLowerCase();
      return needles.some((needle) => haystack.includes(needle));
    }

    function renderCommandContext() {
      const target = document.getElementById("console-context");
      if (!target) return;
      const item = selectedItem();
      if (!item) {
        target.textContent = "global monitor context";
        return;
      }
      target.textContent = pipelineTitle(item) + " · " + (item.correlationId || "no correlation");
    }

    function renderAutoCollaborationThread() {
      [document.getElementById("command-output"), document.getElementById("ask-output")].forEach((output) => {
        if (!output || output.dataset.auto === "false") return;
        output.dataset.auto = "true";
        output.dataset.mode = "thread";
        output.innerHTML = renderCollaborationThread({ kind: "all" });
      });
    }

    async function submitMonitorCommand(text) {
      const output = document.getElementById("command-output");
      const submit = document.getElementById("command-submit");
      const input = document.getElementById("command-input");
      await submitMonitorCommandInner(text, output, submit, input);
    }

    // Same as submitMonitorCommand but writes to the mobile ask-sheet
    // surface (separate output/submit/input elements). Kept as a thin
    // wrapper so the mobile sheet doesn't compete with the desktop console
    // for DOM ids.
    async function submitMonitorCommandFrom(text, output) {
      const submit = document.getElementById("ask-submit");
      const input = document.getElementById("ask-input");
      await submitMonitorCommandInner(text, output, submit, input);
    }

    async function submitMonitorCommandInner(text, output, submit, input) {
      if (!output) return;
      output.dataset.auto = "false";
      const item = selectedItem();
      if (isCodexTaskPromptText(text)) {
        output.dataset.mode = "text";
        output.textContent = "That is a Codex task prompt, not a Hermes monitor command. Paste it into a Codex thread/app so Codex can edit the PR. Hermes will observe the next commit and CI run here.";
        return;
      }
      if (isMonitorInsightCommand(text)) {
        output.dataset.mode = "thread";
        output.innerHTML = renderMonitorConsoleInsight(text, item);
        if (input) input.value = "";
        return;
      }
      output.dataset.mode = "text";
      output.textContent = "Hermes is checking: " + text;
      if (submit) submit.disabled = true;
      try {
        const response = await fetch(commandUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            text,
            correlationId: item?.correlationId,
            repo: item?.repo,
            pullRequestNumber: item?.pullRequestNumber,
          }),
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.message || payload.error || "HTTP " + response.status);
        output.dataset.mode = "text";
        output.textContent = payload.text || "Hermes command completed.";
        if (input) input.value = "";
      } catch (error) {
        output.dataset.mode = "text";
        output.textContent = "Command refused or failed: " + String(error.message || error);
      } finally {
        if (submit) submit.disabled = false;
      }
    }

    function isMonitorInsightCommand(text) {
      const normalized = normalizeConsoleCommandText(text);
      return Boolean(
        /^(now|status|what is happening now|what is going on|what's going on|what is live|current status|right now)$/.test(normalized)
        || /^(agent status|agents status|what are agents doing|what are the agents doing|what are agents thinking|what are the agents thinking)$/.test(normalized)
        || /^what is (codex|hermes) doing( right now)?$/.test(normalized)
        || /^(codex|hermes|operator|my action|my actions|what needs my action|what needs operator action|blocked|blockers|selected|selected card)$/.test(normalized)
        || /^why (is )?(this )?(pr|card|item)( here)?$/.test(normalized)
      );
    }

    function normalizeConsoleCommandText(text) {
      return String(text || "").trim().toLowerCase().replace(/[.!?]+$/g, "").replace(/\s+/g, " ");
    }

    function renderMonitorConsoleInsight(text, item) {
      const kind = monitorInsightKind(text);
      if (kind === "selected") return renderSelectedCollaborationThread(item);
      return renderCollaborationThread({ kind });
    }

    function monitorInsightKind(text) {
      const normalized = normalizeConsoleCommandText(text);
      if (normalized.includes("codex")) return "codex";
      if (normalized.includes("hermes")) return "hermes";
      if (normalized.includes("operator") || normalized.includes("my action")) return "operator";
      if (normalized.includes("block")) return "blocked";
      if (normalized.includes("selected") || normalized.includes("why")) return "selected";
      return "now";
    }

    function renderSelectedCollaborationThread(item) {
      if (!item) {
        return renderCollaborationShell("Selected card", [
          collabMessage("Hermes", "Click a PR card first, then ask why it is here or what should happen next.", "no selection", Date.now()),
        ]);
      }
      const verdict = releaseVerdict(item);
      const action = nextPipelineAction(item, verdict);
      const task = codexTaskForItem(item);
      const lane = boardLaneForItem(item, verdict);
      const messages = [
        collabMessage("Hermes", pipelineTitle(item) + " is here because " + shortenVerdictWhy(verdict.why || "the handoff needs a release decision."), verdict.label, itemUpdatedMs(item)),
        collabMessage("Hermes", collaborationAskForItem(item, verdict, action, lane), pipelineStage(item, verdict).label, itemUpdatedMs(item) + 1),
      ];
      if (task) messages.push(...collaborationMessagesForTask(task));
      return renderCollaborationShell(cardTitleText(pipelineTitle(item), item.pullRequestNumber || pullRequestNumberFromCorrelation(item.correlationId), item), messages);
    }

    function renderCollaborationThread(options) {
      const kind = options && options.kind ? options.kind : "all";
      const messages = buildCollaborationMessages(kind);
      const title = kind === "codex" ? "Codex handoff"
        : kind === "hermes" ? "Hermes review"
          : kind === "operator" ? "Operator asks"
            : kind === "blocked" ? "Needs attention"
              : "Collaboration";
      return renderCollaborationShell(title, messages);
    }

    function renderCollaborationShell(title, messages) {
      const rows = (messages && messages.length ? messages : [
        collabMessage("System", "No active handoff right now. Codex and Hermes will speak up here when there's work to coordinate.", "idle", Date.now()),
      ])
        .sort((a, b) => a.ts - b.ts)
        .slice(-24);
      const lastIndex = rows.length - 1;
      return '<div class="collab-thread">' +
        '<div class="collab-head"><strong>' + escapeHtml(title) + '</strong><span>' + escapeHtml(currentStreamLabel()) + '</span></div>' +
        rows.map((m, i) => renderCollabMessage(m, {
          prev: i > 0 ? rows[i - 1] : null,
          isNewest: i === lastIndex,
        })).join("") +
        '</div>';
    }

    // Two consecutive messages count as "the same speaker continuing"
    // when they share a speaker AND land within this many ms of each
    // other. 4 minutes catches typical reply bursts (a Codex push and
    // its follow-up status line) without collapsing distinct sessions.
    const COLLAB_GROUP_WINDOW_MS = 4 * 60 * 1000;

    function relativeFollowUpLabel(prev, current) {
      if (!prev) return "";
      const delta = current.ts - prev.ts;
      if (!Number.isFinite(delta) || delta < 0) return "";
      if (delta < 30 * 1000) return "just after";
      if (delta < 60 * 1000) return "a moment later";
      const minutes = Math.round(delta / 60000);
      if (minutes < 60) return minutes + "m later";
      const hours = Math.round(delta / 3_600_000);
      return hours + "h later";
    }

    // Render one row in the collaboration thread. Two flavors of message
    // can land here:
    //   - synthesized: built client-side from board state (verdicts, codex
    //     tasks) — these are inferences, not posts.
    //   - posted: real messages recorded via POST /monitor/collaboration —
    //     marked with data-posted so the user can tell what is real chat
    //     vs what is Hermes' inferred narrative.
    // Render one row in the collaboration thread. Two flavors:
    //   - synthesized: built client-side from board state (verdicts,
    //     codex tasks). Subtler bubble, no "posted" tag.
    //   - posted: real messages recorded via POST /monitor/collaboration.
    //     Wider left-rail + a "posted" tag so real posts read as more
    //     load-bearing than synthesized status.
    // System/idle messages render as a centered dashed note — see the
    // CSS for [data-speaker="system"] — so they don't masquerade as agent chat.
    //
    // The DOM is intentionally flat (no avatar, no nested bubble wrapper)
    // to match the ops-console aesthetic of the rest of the page:
    // 3px left-rail + uppercase tracked speaker label, just like the
    // drawer section headers.
    function renderCollabMessage(message, context) {
      const ctx = context || {};
      const prev = ctx.prev || null;
      const isNewest = ctx.isNewest === true;
      const speaker = message.speaker || "Hermes";
      const slug = actorSlug(speaker);
      const posted = message.posted ? "true" : "false";
      const kindAttr = message.kind ? message.kind : "";
      const addressedAttr = message.addressedTo && message.addressedTo !== "everyone" ? message.addressedTo : "";
      const meta = message.meta || "";
      // Group consecutive same-speaker messages so the thread reads as a
      // conversation, not a status log. Grouped rows hide the speaker
      // label, share the left-rail visually (via CSS), and use a
      // relative "1m later" connector instead of repeating an absolute
      // time. Never group system rows — those are dashed-border notes.
      const sameSpeaker = !!prev && prev.speaker === message.speaker;
      const closeInTime = !!prev && Math.abs(message.ts - prev.ts) <= COLLAB_GROUP_WINDOW_MS;
      const grouped = sameSpeaker && closeInTime && slug !== "system";
      const followLabel = grouped ? relativeFollowUpLabel(prev, message) : "";
      const kindBadge = message.kind === "proposal" ? '<span class="collab-tag" data-tag="proposal">proposal</span>'
        : message.kind === "request_help" ? '<span class="collab-tag" data-tag="help">needs help</span>'
          : message.kind === "status" ? '<span class="collab-tag" data-tag="status">status</span>'
            : "";
      const addressedBadge = addressedAttr
        ? '<span class="collab-addressed">→ @' + escapeHtml(addressedAttr) + '</span>'
        : "";
      const postedBadge = message.posted ? '<span class="collab-tag" data-tag="posted">posted</span>' : "";
      // Inside a grouped run the byline collapses to a faint connector
      // (e.g. "↳ 1m later") plus any badge changes. On the first message
      // in a run we render the full uppercase tracked speaker label.
      const byline = grouped
        ? (followLabel || kindBadge || postedBadge || addressedBadge
          ? '<div class="collab-byline" data-grouped="true">' +
              (followLabel ? '<span class="collab-follow">↳ ' + escapeHtml(followLabel) + '</span>' : "") +
              addressedBadge + kindBadge + postedBadge +
              (meta ? '<span class="collab-meta">' + escapeHtml(meta) + '</span>' : "") +
            '</div>'
          : "")
        : '<div class="collab-byline">' +
            '<span class="collab-speaker">' + escapeHtml(speaker) + '</span>' +
            addressedBadge + kindBadge + postedBadge +
            (meta ? '<span class="collab-meta">' + escapeHtml(meta) + '</span>' : "") +
          '</div>';
      return '<article class="collab-message"' +
        ' data-speaker="' + escapeAttr(slug) + '"' +
        ' data-posted="' + posted + '"' +
        ' data-kind="' + escapeAttr(kindAttr) + '"' +
        ' data-addressed="' + escapeAttr(addressedAttr) + '"' +
        ' data-grouped="' + (grouped ? "true" : "false") + '"' +
        (isNewest ? ' data-newest="true"' : "") +
        '>' +
        byline +
        '<div class="collab-text">' + escapeHtml(message.text || "") + '</div>' +
      '</article>';
    }

    function collabMessage(speaker, text, meta, ts) {
      return { speaker, text, meta: meta || "", ts: Number.isFinite(ts) ? ts : Date.now() };
    }

    // Normalize the wire payload from POST /monitor/collaboration and the
    // monitor snapshot's collaborationMessages field into the same shape
    // the in-DOM render expects. Anything malformed is dropped silently
    // rather than crashing the thread render.
    function normalizeCollabMessages(value) {
      if (!Array.isArray(value)) return [];
      const out = [];
      for (const entry of value) {
        if (!entry || typeof entry !== "object") continue;
        const author = typeof entry.author === "string" ? entry.author : "";
        const text = typeof entry.text === "string" ? entry.text : "";
        const ts = Number(entry.ts);
        if (!author || !text || !Number.isFinite(ts)) continue;
        out.push({
          id: typeof entry.id === "string" ? entry.id : "",
          author,
          text,
          ts,
          kind: typeof entry.kind === "string" ? entry.kind : "chat",
          addressedTo: typeof entry.addressedTo === "string" ? entry.addressedTo : "everyone",
          relatedPr: entry.relatedPr && typeof entry.relatedPr === "object" ? entry.relatedPr : null,
          relatedCorrelationId: typeof entry.relatedCorrelationId === "string" ? entry.relatedCorrelationId : "",
        });
      }
      return out;
    }

    // Convert a normalized posted message into the shape buildCollaborationMessages
    // produces — same speaker/text/meta/ts contract, plus the posted/kind/addressedTo
    // attributes so renderCollabMessage can decorate it correctly.
    function postedToCollabRow(message) {
      const speaker = message.author === "codex" ? "Codex"
        : message.author === "hermes" ? "Hermes"
          : message.author === "operator" ? "Operator"
            : "System";
      const metaParts = [];
      if (message.relatedPr && message.relatedPr.repo && message.relatedPr.number) {
        metaParts.push(message.relatedPr.repo + "#" + message.relatedPr.number);
      }
      metaParts.push(shortTime(new Date(message.ts).toISOString()));
      return {
        speaker,
        text: message.text,
        meta: metaParts.join(" · "),
        ts: message.ts,
        posted: true,
        kind: message.kind || "chat",
        addressedTo: message.addressedTo || "everyone",
      };
    }

    function postedMessageMatchesKind(message, kind) {
      if (!kind || kind === "all") return true;
      if (kind === "codex") return message.author === "codex" || message.addressedTo === "codex";
      if (kind === "hermes") return message.author === "hermes" || message.addressedTo === "hermes";
      if (kind === "operator") return message.author === "operator" || message.addressedTo === "operator";
      if (kind === "blocked") return message.kind === "request_help" || message.kind === "proposal";
      return true;
    }

    function buildCollaborationMessages(kind) {
      const messages = [];
      // Real posted messages take precedence visually — they are the
      // human/agent voice on the channel and shouldn't be drowned by
      // synthesized status lines.
      latestCollabMessages
        .filter((m) => postedMessageMatchesKind(m, kind))
        .forEach((m) => messages.push(postedToCollabRow(m)));
      latestCodexTasks
        .filter((task) => !isTerminalCodexTask(task))
        .sort((a, b) => taskUpdatedMs(b) - taskUpdatedMs(a))
        .slice(0, 8)
        .forEach((task) => messages.push(...collaborationMessagesForTask(task)));
      (latestPipelineItems || []).forEach((item) => {
        const verdict = releaseVerdict(item);
        const lane = boardLaneForItem(item, verdict);
        if (lane.key === "done") return;
        const action = nextPipelineAction(item, verdict);
        if (kind === "codex" && action.owner !== "Codex" && lane.key !== "codex") return;
        if (kind === "hermes" && action.owner !== "Hermes" && lane.key !== "hermes") return;
        if (kind === "operator" && action.owner !== "Operator" && lane.key !== "operator") return;
        if (kind === "blocked" && lane.key !== "attention" && verdict.level !== "block") return;
        messages.push(collabMessage("Hermes", collaborationAskForItem(item, verdict, action, lane), collaborationMetaForItem(item, verdict), itemUpdatedMs(item)));
      });
      if (!messages.length && kind === "codex") {
        messages.push(collabMessage("System", "Codex has no active PR handoff right now.", "idle", Date.now()));
      } else if (!messages.length && kind === "hermes") {
        messages.push(collabMessage("System", "Hermes has nothing to re-check or verify right now.", "idle", Date.now()));
      } else if (!messages.length && kind === "operator") {
        messages.push(collabMessage("System", "Nothing needs your decision right now.", "idle", Date.now()));
      } else if (!messages.length) {
        messages.push(collabMessage("System", "Codex and Hermes are quiet. Post a message to start the conversation.", "idle", Date.now()));
      }
      return messages;
    }

    function collaborationAskForItem(item, verdict, action, lane) {
      const title = cardTitleText(pipelineTitle(item), item.pullRequestNumber || pullRequestNumberFromCorrelation(item.correlationId), item);
      if (action.owner === "Codex" || lane.key === "codex") return "Codex, please pick up " + title + ". " + action.text;
      if (action.owner === "Operator" || lane.key === "operator" || lane.key === "attention") return "Pascal, I need your decision on " + title + ". " + action.text;
      if (action.owner === "Hermes" || lane.key === "hermes") return "I am checking " + title + " and will report the verdict here.";
      if (lane.key === "queue") return title + " looks ready. I am keeping it in the release queue until merge/deploy ownership is clear.";
      if (lane.key === "deploy") return "I am watching deploy verification for " + title + " and will report if it needs action.";
      return action.owner + ", " + action.text + " for " + title + ".";
    }

    function collaborationMetaForItem(item, verdict) {
      const age = handoffAge(item);
      return verdict.label + " · " + age.label + " " + age.duration;
    }

    function collaborationMessagesForTask(task) {
      if (!task) return [];
      const status = normalize(task.status) || "unknown";
      const title = codexTaskTitle(task);
      const ts = taskUpdatedMs(task);
      const messages = [];
      if (status === "proposed") {
        messages.push(collabMessage("Hermes", "Codex, I have a proposed task for you: " + title + ".", "task proposed", ts));
        messages.push(collabMessage("Hermes", "Pascal, approve this task when you want Codex to start.", "approval needed", ts + 1));
      } else if (status === "approved") {
        messages.push(collabMessage("Hermes", "Codex, this task is approved: " + title + ".", "approved", ts));
        messages.push(collabMessage("Codex", "I am queued for pickup. Waiting for the Codex runner to claim it.", "waiting runner", ts + 1));
      } else if (status === "running") {
        messages.push(collabMessage("Codex", "I am working on " + title + ". " + (task.progressMessage || "I will report back here when the branch is updated."), "running", ts));
      } else if (status === "completed") {
        messages.push(collabMessage("Codex", "I finished " + title + ". Hermes should re-check the PR or CI result now.", "completed", ts));
      } else if (status === "failed") {
        messages.push(collabMessage("Codex", "I could not finish " + title + ". " + (lastCodexTaskTail(task) || "Please inspect the runner output or send a smaller follow-up task."), "failed", ts));
      } else if (status === "cancelled") {
        messages.push(collabMessage("Operator", "Cancelled Codex task: " + title + ".", "cancelled", ts));
      }
      const events = Array.isArray(task.events) ? task.events.slice(-3) : [];
      events.forEach((event, index) => {
        const message = event && event.message ? String(event.message) : "";
        if (!message) return;
        messages.push(collabMessage(actorForTaskEvent(message), message, event.at ? shortTime(event.at) : "task event", (Date.parse(String(event.at || "")) || ts) + index + 2));
      });
      return messages;
    }

    function actorForTaskEvent(message) {
      const text = normalize(message);
      if (text.includes("approve") || text.includes("cancel")) return "Operator";
      if (text.includes("runner") || text.includes("claim") || text.includes("start") || text.includes("complete") || text.includes("fail")) return "Codex";
      return "Hermes";
    }

    function topConsoleItems(items, limit) {
      return [...items]
        .filter(Boolean)
        .sort((a, b) => boardSortScore(b) - boardSortScore(a) || String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")))
        .slice(0, limit);
    }

    function currentStreamLabel() {
      const state = document.getElementById("live-status-state")?.textContent || "unknown";
      const sub = document.getElementById("live-status-sub")?.textContent || "";
      return [state, sub].filter(Boolean).join(" · ");
    }

    async function handleCodexTaskAction(button) {
      const action = String(button.getAttribute("data-codex-task-action") || "");
      const taskId = String(button.getAttribute("data-codex-task-id") || "");
      const key = String(button.getAttribute("data-card-key") || selectedKey || "");
      const item = itemByBoardKey(key) || selectedItem();
      const output = document.getElementById("command-output");
      if (output) output.dataset.auto = "false";
      button.disabled = true;
      try {
        if (action === "propose") {
          if (!item) throw new Error("No PR selected for Codex task proposal.");
          const summary = item.summary || {};
          const verdict = releaseVerdict(item);
          const next = nextPipelineAction(item, verdict);
          const prompt = codexPromptForItem(item, summary, verdict, next);
          const pr = Number(item.pullRequestNumber || pullRequestNumberFromCorrelation(item.correlationId));
          if (!prompt || !Number.isFinite(pr) || pr < 1) throw new Error("This card does not have enough PR metadata for a Codex task.");
          await postCodexTask({
            action: "propose",
            repo: String(item.repo || "averray-agent/agent"),
            pullRequestNumber: pr,
            correlationId: item.correlationId,
            title: cardTitleText(pipelineTitle(item), pr, item),
            reason: next.text,
            requester: "monitor",
            prompt,
          });
          if (output) output.textContent = "Codex task proposed. Approve it when you want Codex to pick it up.";
          return;
        }
        if (action === "approve") {
          if (!taskId) throw new Error("Missing Codex task id.");
          await postCodexTask({ action: "approve", id: taskId });
          if (output) output.textContent = "Codex task approved. Codex worker pickup is now allowed.";
          return;
        }
        if (action === "cancel") {
          if (!taskId) throw new Error("Missing Codex task id.");
          await postCodexTask({ action: "cancel", id: taskId });
          if (output) output.textContent = "Codex task cancelled.";
          return;
        }
        throw new Error("Unsupported Codex task action: " + action);
      } catch (error) {
        if (output) output.textContent = "Codex task action failed: " + String(error.message || error);
      } finally {
        button.disabled = false;
      }
    }

    async function postCodexTask(payload) {
      const response = await fetch(codexTasksUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.message || result.error || "HTTP " + response.status);
      if (result.queue) {
        latestCodexTasks = normalizeCodexTasks(result.queue);
        latestCodexRunner = normalizeCodexRunner(result.queue && result.queue.runner);
        if (latestPayload) {
          latestPayload = Object.assign({}, latestPayload, { codexTasks: result.queue });
          render(latestPayload);
        }
      }
      return result;
    }

    async function handleHermesRecheckAction(button) {
      const key = String(button.getAttribute("data-card-key") || selectedKey || "");
      const item = itemByBoardKey(key) || selectedItem();
      const output = document.getElementById("command-output");
      if (output) output.dataset.auto = "false";
      button.disabled = true;
      try {
        if (!item) throw new Error("No PR selected for Hermes re-check.");
        const pr = Number(item.pullRequestNumber || pullRequestNumberFromCorrelation(item.correlationId));
        const repo = String(item.repo || "averray-agent/agent");
        if (!repo || !Number.isFinite(pr) || pr < 1) throw new Error("This card does not have enough PR metadata for Hermes re-check.");
        if (output) output.textContent = "Asking Hermes to re-check " + repo + "#" + pr + "…";
        const result = await postHermesRecheck({
          repo,
          pullRequestNumber: pr,
          correlationId: item.correlationId,
          reason: "monitor requested Hermes re-check after Codex handoff",
        });
        if (output) output.textContent = result.text || ("Hermes re-check completed for " + repo + "#" + pr + ".");
      } catch (error) {
        if (output) output.textContent = "Hermes re-check failed: " + String(error.message || error);
      } finally {
        button.disabled = false;
      }
    }

    async function postHermesRecheck(payload) {
      const response = await fetch(recheckUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.message || result.error || "HTTP " + response.status);
      if (result.monitor) {
        render(result.monitor);
      } else {
        await load();
      }
      return result;
    }

    function isCodexTaskPromptText(text) {
      const value = String(text || "").trim().toLowerCase();
      if (!value) return false;
      return (value.startsWith("continue ") || value.startsWith("fix ")) &&
        value.includes("codex") &&
        (value.includes("do not merge or deploy") || value.includes("hermes monitor shows") || value.includes("hermes reports"));
    }

    function contextualCommand(command) {
      const item = selectedItem();
      if (!item) return command;
      if (command === "handoff monitor details") return "handoff monitor details";
      if (command === "merge steward details") return "merge steward details";
      return command;
    }

    function updateToggleGroup(selector, value) {
      const attr = selector.startsWith("[") && selector.endsWith("]") ? selector.slice(1, -1) : selector;
      document.querySelectorAll(selector).forEach((button) => {
        button.setAttribute("aria-pressed", String(button.getAttribute(attr) === value));
      });
    }

    function testSummaryText(values) {
      const tests = Array.isArray(values) ? values.filter(Boolean) : [];
      if (!tests.length) return "no test signal";
      if (tests.length === 1) return "1 check";
      return String(tests.length) + " checks";
    }

    function renderPipelineBoard(entries) {
      const counts = commandBoardLaneCounts(entries);
      setText("board-all", String(entries.length - (counts.done || 0)));
      setText("board-block", String(counts.attention || 0));
      setText("board-review", String(counts.operator || 0));
      setText("board-ready", String(counts.queue || 0));
      setText("board-running", String((counts.hermes || 0) + (counts.deploy || 0)));
      setText("done-count", String(counts.done || 0));
      renderOwnerSummary(entries);
      renderStalenessSummary(entries);
      updatePipelineFilterButtons();
    }

    function renderStalenessSummary(entries) {
      const ages = entries.map(handoffAge);
      setText("age-fresh", String(ages.filter((age) => age.state === "fresh").length));
      setText("age-waiting", String(ages.filter((age) => age.state === "waiting").length));
      setText("age-stale", String(ages.filter((age) => age.state === "stale").length));
    }

    function renderOwnerSummary(entries) {
      const owners = entries.map((item) => nextPipelineAction(item, releaseVerdict(item)).owner);
      setText("owner-codex", String(owners.filter((owner) => owner === "Codex").length));
      setText("owner-operator", String(owners.filter((owner) => owner === "Operator").length));
      setText("owner-merge", String(owners.filter((owner) => owner === "Merge queue").length));
      setText("owner-hermes", String(owners.filter((owner) => owner === "Hermes").length));
    }

    function renderOwnerLanes(entries) {
      const target = document.getElementById("owner-lanes");
      const filtered = filterPipelineItems(entries);
      if (!filtered.length) {
        target.innerHTML = '<div class="empty">No PR handoffs in the monitor window.</div>';
        return;
      }
      target.innerHTML = ownerLaneDefinitions().map((lane) => renderOwnerLane(lane, filtered)).join("");
    }

    function ownerLaneDefinitions() {
      return [
        { key: "codex", title: "Codex", owner: "Codex", empty: "Nothing waiting on Codex." },
        { key: "hermes", title: "Hermes", owner: "Hermes", empty: "Hermes has no active PR checks." },
        { key: "operator", title: "Operator Review", owner: "Operator", empty: "No operator sign-off needed." },
        { key: "merge", title: "Merge Queue", owner: "Merge queue", empty: "Nothing ready to merge." },
        { key: "done", title: "Done", owner: "Done", empty: "No completed PRs in view." },
      ];
    }

    function renderOwnerLane(lane, entries) {
      const items = entries
        .filter((item) => nextPipelineAction(item, releaseVerdict(item)).owner === lane.owner)
        .sort((a, b) => ownerLaneSortScore(b) - ownerLaneSortScore(a) || String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
      const cards = items.length
        ? items.slice(0, 6).map(renderOwnerLaneCard).join("")
        : '<div class="owner-lane-empty">' + escapeHtml(lane.empty) + '</div>';
      return '<section class="owner-lane" data-owner="' + escapeAttr(lane.key) + '">' +
        '<div class="owner-lane-head"><div class="owner-lane-title">' + escapeHtml(lane.title) + '</div><span class="pill">' + escapeHtml(String(items.length)) + '</span></div>' +
        '<div class="owner-lane-items">' + cards + '</div>' +
        '</section>';
    }

    function renderOwnerLaneCard(item) {
      const summary = item.summary || {};
      const verdict = releaseVerdict(item);
      const action = nextPipelineAction(item, verdict);
      const age = handoffAge(item);
      const title = pipelineTitle(item);
      const prUrl = item.pullRequestUrl || derivePullRequestUrl(item);
      const titleMarkup = prUrl
        ? '<a href="' + escapeAttr(prUrl) + '" target="_blank" rel="noreferrer">' + escapeHtml(title) + '</a>'
        : escapeHtml(title);
      return '<article class="lane-card" data-verdict="' + escapeAttr(verdict.level) + '">' +
        '<div class="lane-card-title">' + titleMarkup + '</div>' +
        renderGroupBadges(item) +
        '<div class="lane-card-meta">' + escapeHtml(verdict.label + " - " + age.label + " " + age.duration) + '</div>' +
        '<div class="lane-card-action">' + escapeHtml(action.text) + '</div>' +
        '<div class="lane-card-meta">' + escapeHtml(verdict.why) + '</div>' +
        '</article>';
    }

    function ownerLaneSortScore(item) {
      const verdict = releaseVerdict(item);
      const age = handoffAge(item);
      const prState = pullRequestState(item, item.summary || {});
      if (isDonePullRequestState(prState)) return 10;
      if (verdict.level === "block") return 500;
      if (age.state === "stale") return 400;
      if (verdict.level === "needs-review") return 300;
      if (verdict.level === "running") return 200;
      if (verdict.level === "pass") return 100;
      return 0;
    }

    function updatePipelineFilterButtons() {
      document.querySelectorAll("[data-pipeline-filter]").forEach((button) => {
        button.setAttribute("aria-pressed", String(button.getAttribute("data-pipeline-filter") === pipelineFilter));
      });
    }

    function renderPipeline(entries) {
      const target = document.getElementById("pipeline");
      const filtered = filterPipelineItems(entries);
      if (!filtered.length) {
        target.innerHTML = '<div class="empty">No PR handoffs in the monitor window.</div>';
        return;
      }
      target.innerHTML = renderRepoGroups(filtered);
    }

    function filterPipelineItems(entries) {
      if (pipelineFilter === "all") return entries;
      return entries.filter((item) => releaseVerdict(item).level === pipelineFilter);
    }

    function renderRepoGroups(entries) {
      const groups = new Map();
      entries.forEach((item) => {
        const repo = item.repo || "unknown repo";
        const current = groups.get(repo) || [];
        current.push(item);
        groups.set(repo, current);
      });
      return Array.from(groups.entries())
        .sort((a, b) => repoSortScore(b[1]) - repoSortScore(a[1]) || String(a[0]).localeCompare(String(b[0])))
        .map(([repo, items]) => renderRepoGroup(repo, items))
        .join("");
    }

    function renderRepoGroup(repo, items) {
      const current = items.filter(isCurrentPipelineItem);
      const history = items.filter((item) => !isCurrentPipelineItem(item));
      const currentMarkup = current.length
        ? current.map(renderPipelineItem).join("")
        : '<div class="repo-empty">No current work for this repo.</div>';
      const historyMarkup = history.length
        ? '<div class="repo-history-label">Recent history</div>' + history.slice(0, 4).map(renderPipelineItem).join("")
        : "";
      return '<section class="repo-group" data-repo="' + escapeAttr(repo) + '">' +
        '<div class="repo-head"><div class="repo-title">' + escapeHtml(repo) + '</div><div class="repo-summary">' + repoSummaryChips(items, current) + '</div></div>' +
        currentMarkup +
        historyMarkup +
        '</section>';
    }

    function repoSummaryChips(items, current) {
      const verdicts = items.map(releaseVerdict);
      const stale = items.map(handoffAge).filter((age) => age.state === "stale").length;
      const done = items.map((item) => pullRequestState(item, item.summary || {})).filter(isDonePullRequestState).length;
      const chips = [
        { label: "Current", value: current.length },
        { label: "Blocked", value: verdicts.filter((verdict) => verdict.level === "block").length },
        { label: "Review", value: verdicts.filter((verdict) => verdict.level === "needs-review").length },
        { label: "Ready", value: verdicts.filter((verdict) => verdict.level === "pass").length },
        { label: "Stale", value: stale },
        { label: "Done", value: done },
      ];
      return chips.map((chip) => '<span class="pill">' + escapeHtml(chip.label + " " + chip.value) + '</span>').join("");
    }

    function repoSortScore(items) {
      return items.reduce((score, item) => {
        const verdict = releaseVerdict(item);
        const age = handoffAge(item);
        if (verdict.level === "block") return score + 1000;
        if (age.state === "stale") return score + 400;
        if (verdict.level === "needs-review") return score + 300;
        if (verdict.level === "running") return score + 200;
        if (verdict.level === "pass") return score + 100;
        return score + 10;
      }, 0);
    }

    function isCurrentPipelineItem(item) {
      const verdict = releaseVerdict(item);
      const age = handoffAge(item);
      const status = normalize(item.status);
      const prState = pullRequestState(item, item.summary || {});
      if (isDonePullRequestState(prState)) return false;
      return Boolean(
        item.active === true
        || item.activeState === "running"
        || status === "running"
        || verdict.level === "block"
        || verdict.level === "needs-review"
        || age.state !== "fresh"
      );
    }

    function renderPipelineItem(item) {
      const summary = item.summary || {};
      const verdict = releaseVerdict(item);
      const stage = pipelineStage(item, verdict);
      const action = nextPipelineAction(item, verdict);
      const age = handoffAge(item);
      const prUrl = item.pullRequestUrl || derivePullRequestUrl(item);
      const commitUrl = deriveCommitUrl(item);
      const workflowRunUrl = deriveWorkflowRunUrl(item);
      const title = pipelineTitle(item);
      const links = [
        prUrl ? '<a class="pill" href="' + escapeAttr(prUrl) + '" target="_blank" rel="noreferrer">open PR</a>' : "",
        workflowRunUrl ? '<a class="pill" href="' + escapeAttr(workflowRunUrl) + '" target="_blank" rel="noreferrer">open run</a>' : "",
        commitUrl ? '<a class="pill" href="' + escapeAttr(commitUrl) + '" target="_blank" rel="noreferrer">open commit</a>' : "",
      ].filter(Boolean).join("");
      return '<article class="pipeline-card" data-verdict="' + escapeAttr(verdict.level) + '" data-age="' + escapeAttr(age.state) + '">' +
        '<div class="pipeline-head"><div class="pipeline-title">' + escapeHtml(title) + '</div><span class="pill state-pill" data-level="' + escapeAttr(verdict.level) + '">' + escapeHtml(verdict.label) + '</span></div>' +
        renderGroupBadges(item) +
        '<p class="pipeline-why">' + escapeHtml(verdict.why) + '</p>' +
        '<p class="age-line" data-age="' + escapeAttr(age.state) + '">' + escapeHtml(age.label + " - " + action.owner + " for " + age.duration) + '</p>' +
        '<div class="next-action"><strong>Next action:</strong> ' + escapeHtml(action.owner + " - " + action.text) + '</div>' +
        renderOperatorDecisionNote(item) +
        renderFixRequest(item, summary, verdict, action) +
        renderPipelineSteps(stage, verdict) +
        renderPrTimeline(item, stage, verdict, action) +
        '<dl class="pipeline-meta">' +
        row("Stage", escapeHtml(stage.label)) +
        row("Next actor", escapeHtml(action.owner)) +
        row("Updated", escapeHtml(item.updatedAt ? new Date(item.updatedAt).toLocaleString() : "unknown")) +
        row("Correlation", "<code>" + escapeHtml(item.correlationId || "unknown") + "</code>") +
        '</dl>' +
        renderPipelineDetails(item, summary, verdict, action) +
        (links ? '<div class="pipeline-links">' + links + '</div>' : "") +
        '</article>';
    }

    function renderPipelineDetails(item, summary, verdict, action) {
      const signals = summary.reviewSignals || {};
      const prState = pullRequestState(item, summary);
      const touchedAreas = Array.isArray(signals.touchedAreas) ? signals.touchedAreas : [];
      const missingTests = Array.isArray(signals.missingTestSignals) ? signals.missingTestSignals : [];
      const testSignals = Array.isArray(signals.testSignals) ? signals.testSignals : [];
      const rollout = signals.rolloutNotesRequired === true
        ? signals.rolloutNotesPresent === true ? "present" : "missing"
        : "not required";
      const rows = [
        row("Verdict", escapeHtml(verdict.label)),
        row("Merge", escapeHtml(summary.mergeRecommendation || summary.finalVerdict || summary.status || "n/a")),
        row("PR state", escapeHtml(pullRequestStateLabel(prState) || [item.status, item.phase, liveStateLabel(item.activeState)].filter(Boolean).join(" / ") || "n/a")),
        row("Suggested owner", escapeHtml(action.owner)),
        row("Changed areas", touchedAreas.length ? chips(touchedAreas) : "n/a"),
        row("Test coverage", testSignals.length ? chips(testSignals.slice(0, 5)) : "n/a"),
        row("Missing tests", missingTests.length ? chips(missingTests) : "none recorded"),
        row("Rollout notes", escapeHtml(rollout)),
      ];
      const reviewRows = reviewReasonRows(summary);
      return '<div class="pipeline-detail-title">PR detail</div><dl class="pipeline-detail">' +
        rows.join("") +
        reviewRows +
        row("Why", escapeHtml(verdict.why)) +
        '</dl>';
    }

    function renderFixRequest(item, summary, verdict, action) {
      if (verdict.level !== "block" && verdict.level !== "needs-review") return "";
      const request = buildFixRequest(item, summary, verdict, action);
      const actions = verdict.level === "needs-review" && !isDraftPullRequest(item) ? renderDecisionActions(item) : "";
      return '<section class="fix-request" data-level="' + escapeAttr(verdict.level) + '" aria-label="Fix request">' +
        '<p class="fix-request-title">' + escapeHtml(request.title) + '</p>' +
        '<p class="fix-request-copy">' + escapeHtml(request.instruction) + '</p>' +
        '<dl class="fix-request-meta">' +
        row("Owner", escapeHtml(request.owner)) +
        row("Reason", escapeHtml(request.reason)) +
        row("Surfaces", request.surfaces.length ? chips(request.surfaces) : "n/a") +
        row("Checks", request.checks.length ? chips(request.checks) : escapeHtml("run relevant local checks and wait for CI")) +
        row("Re-run", escapeHtml(request.rerun)) +
        '</dl>' +
        actions +
        '</section>';
    }

    function renderBlockResolutionPanel(item, summary, verdict, action) {
      const plan = blockResolutionPlan(item, summary, verdict, action);
      const evidenceRows = [
        row("Owner", escapeHtml(plan.owner)),
        row("Blocked by", escapeHtml(plan.reason)),
        row("Evidence", plan.evidence.length ? chips(plan.evidence) : escapeHtml("Hermes verdict only")),
        row("Clears when", escapeHtml(plan.clearsWhen)),
      ].join("");
      return '<section class="drawer-section block-resolution"><h3>Fix this block</h3>' +
        '<p class="resolution-summary">' + escapeHtml(plan.summary) + '</p>' +
        '<dl class="resolution-grid">' + evidenceRows + '</dl>' +
        '<ol class="resolution-steps">' + plan.steps.map((step) => '<li>' + escapeHtml(step) + '</li>').join("") + '</ol>' +
        '<div class="resolution-actions">' +
          '<button class="soft-button" type="button" data-command-suggestion="' + escapeAttr(plan.askCommand) + '">Ask Hermes for details</button>' +
          '<button class="soft-button" type="button" data-command-suggestion="ops health">Run ops health</button>' +
        '</div>' +
        '</section>';
    }

    function renderDecisionActions(item) {
      const key = decisionKeyForItem(item);
      return '<div class="decision-actions">' +
        '<button class="decision-button" type="button" data-monitor-decision="approve" data-decision-key="' + escapeAttr(key) + '">Operator approved</button>' +
        '</div>';
    }

    function renderOperatorDecisionNote(item) {
      const decision = decisionForItem(item);
      if (decision.status !== "approved") return "";
      const key = decisionKeyForItem(item);
      const at = decision.at ? " at " + new Date(decision.at).toLocaleString() : "";
      return '<section class="decision-note" aria-label="Operator decision">' +
        '<strong>Operator approved</strong>' + escapeHtml(at) + '. This is a private monitor decision only; GitHub was not mutated. ' +
        '<button class="decision-button" type="button" data-monitor-decision="reset" data-decision-key="' + escapeAttr(key) + '">Reset approval</button>' +
        '</section>';
    }

    function blockResolutionPlan(item, summary, verdict, action) {
      const reason = normalize(summary.finalReason || summary.reason || item.reason);
      const request = buildFixRequest(item, summary, verdict, action);
      const evidence = blockResolutionEvidence(summary, request);
      const base = {
        owner: request.owner || action.owner,
        reason: request.reason || verdict.why,
        evidence,
        askCommand: "what should we do next",
      };
      if (isDeployItem(item) && reason === "hosted_health_failed") {
        return {
          ...base,
          summary: "Production deploy finished, but the hosted app health check is failing. Treat this as a follow-up fix or rollback decision, not a merge approval.",
          clearsWhen: "hosted health is ok and the post-deploy suite returns PASS",
          steps: [
            "Open the workflow run and inspect the hosted-health or post-deploy verification step.",
            "Run ops health from this monitor to confirm whether the backend, frontend, and command-center are currently healthy.",
            "Have Codex open a small fix PR for the broken app/config path, or prepare a rollback proposal if production is affected.",
            "After the fix deploys, wait for Hermes post-deploy verification to record hosted ok and zero failing workflows.",
          ],
        };
      }
      if (isDeployItem(item) && reason === "github_workflow_failed") {
        return {
          ...base,
          summary: "The deployed commit has a failed GitHub workflow. The release is blocked until the red run is understood and fixed.",
          clearsWhen: "the failed workflow is green on a new commit or a follow-up deploy",
          steps: [
            "Open the failed workflow run from References.",
            "Identify the failing job and affected component.",
            "Have Codex fix the failing check in a follow-up PR, then let CI and Hermes post-deploy verification re-run.",
          ],
        };
      }
      if (isDeployItem(item) && reason === "testbed_cases_failed") {
        return {
          ...base,
          summary: "The read-only post-deploy testbed suite failed. The release is blocked until the failing case is explained or fixed.",
          clearsWhen: "all requested post-deploy testbed cases pass or the failed case is explicitly waived by an operator",
          steps: [
            "Ask Hermes for handoff details to get the failed testbed case IDs.",
            "Have Codex fix the platform behavior or test fixture that caused the failure.",
            "Re-run post-deploy verification and confirm the suite has zero failures.",
          ],
        };
      }
      if (reason === "ci_failed") {
        return {
          ...base,
          summary: "CI is red. Codex owns this until the failing job is fixed on the PR branch.",
          clearsWhen: "all branch protection checks are green and Hermes re-checks the PR",
          steps: [
            "Open the workflow run and identify the failing job.",
            "Have Codex patch the PR branch with the smallest fix.",
            "Wait for CI and Hermes PR handoff to re-run on the new commit.",
          ],
        };
      }
      if (reason === "deploy_failure" || reason === "deploy_failed") {
        return {
          ...base,
          summary: "The production deploy workflow failed. Do not continue release work until the failing deploy step is fixed or rolled back.",
          clearsWhen: "deploy workflow succeeds and post-deploy verification is green",
          steps: [
            "Open the deploy workflow run and find the exact failing command.",
            "Have Codex fix the deploy script/config issue, or prepare a rollback proposal if the broken deploy reached production.",
            "Re-run through the normal PR/deploy path and wait for Hermes verification.",
          ],
        };
      }
      return {
        ...base,
        summary: request.instruction || "The release gate is blocked. Codex should fix the blocking signal before this item moves forward.",
        clearsWhen: "the blocking reason disappears and Hermes records PASS",
        steps: [
          "Open the linked PR or workflow run and inspect the red signal named above.",
          "Have Codex make the smallest targeted fix and push a new commit.",
          "Wait for CI, Hermes handoff, and any requested testbed checks to re-run cleanly.",
        ],
      };
    }

    function blockResolutionEvidence(summary, request) {
      const health = summary.deploymentHealth && typeof summary.deploymentHealth === "object" ? summary.deploymentHealth : {};
      const bits = [];
      if (Array.isArray(health.hostedFailedUrls) && health.hostedFailedUrls.length) bits.push("hosted health URL failed");
      if (typeof health.githubFailingWorkflowRuns === "number" && health.githubFailingWorkflowRuns > 0) bits.push(String(health.githubFailingWorkflowRuns) + " failed workflow run(s)");
      if (typeof health.suiteFailed === "number" && health.suiteFailed > 0) bits.push(String(health.suiteFailed) + " failed testbed case(s)");
      if (request.checks.length) bits.push.apply(bits, request.checks.slice(0, 4));
      if (request.surfaces.length) bits.push.apply(bits, request.surfaces.slice(0, 4));
      return Array.from(new Set(bits.filter(Boolean)));
    }

    function buildFixRequest(item, summary, verdict, action) {
      const signals = summary.reviewSignals || {};
      const fixRequest = summary.fixRequest && typeof summary.fixRequest === "object" ? summary.fixRequest : {};
      const reviewReasons = Array.isArray(summary.reviewReasons) ? summary.reviewReasons : [];
      const touchedAreas = Array.isArray(signals.touchedAreas) ? signals.touchedAreas.map(String).filter(Boolean) : [];
      const missingTests = Array.isArray(signals.missingTestSignals) ? signals.missingTestSignals.map(String).filter(Boolean) : [];
      const testSignals = Array.isArray(signals.testSignals) ? signals.testSignals.map(String).filter(Boolean) : [];
      const reason = isReleaseReviewVerdict(verdict) ? "ready_for_operator_release_review" : firstReviewReason(reviewReasons) || releaseReason(summary, item, verdict.level);
      const checks = Array.isArray(fixRequest.checks)
        ? fixRequest.checks.map(String).filter(Boolean)
        : missingTests.length ? missingTests : defaultFixChecks(item, summary, testSignals);
      const isDraft = isDraftPullRequest(item);
      return {
        title: fixRequest.title || (isDraft ? "Draft readiness request for Codex" : verdict.level === "block" ? "Fix request for Codex" : "Operator decision request"),
        owner: fixRequest.owner || action.owner,
        instruction: fixRequest.instruction || fixRequestInstruction(item, summary, verdict, action),
        reason,
        surfaces: Array.isArray(fixRequest.surfaces) ? fixRequest.surfaces.map(String).filter(Boolean) : defaultFixSurfaces(item, summary, touchedAreas),
        checks,
        rerun: fixRequest.rerun || defaultFixRerun(item, summary),
      };
    }

    function fixRequestInstruction(item, summary, verdict, action) {
      const reason = normalize(summary.finalReason || summary.reason || item.reason);
      if (isDraftPullRequest(item)) {
        return "Codex should finish the draft work, mark the PR ready for review, and let CI plus Hermes run on the ready PR.";
      }
      if (verdict.level === "block") {
        if (isDeployItem(item) && reason === "hosted_health_failed") {
          return "Codex should fix the hosted app/config health failure in a follow-up PR, or prepare a rollback proposal if production is affected.";
        }
        if (isDeployItem(item)) {
          return "Codex should fix the failed deploy or post-deploy signal in a follow-up PR, then let the production verification run again.";
        }
        return "Codex should fix the blocking signal, push the PR branch, and wait for CI plus Hermes to re-run.";
      }
      if (isReleaseReviewVerdict(verdict)) {
        return "Hermes/Codex should provide the code-level pre-check evidence. Operator should skim the release packet before this green PR enters the merge queue.";
      }
      if (verdict.level === "needs-review") {
        return "Hermes/Codex should provide the code-level pre-check evidence. Operator should decide whether the project intent, architecture, and rollout risk are acceptable.";
      }
      return action.text;
    }

    function defaultFixSurfaces(item, summary, touchedAreas) {
      const reason = normalize(summary.finalReason || summary.reason || item.reason);
      if (isDeployItem(item)) {
        if (reason === "hosted_health_failed") return ["post-deploy", "hosted health"];
        if (reason === "github_workflow_failed") return ["post-deploy", "github workflow"];
        if (reason === "testbed_cases_failed") return ["post-deploy", "testbed suite"];
        return ["post-deploy"];
      }
      return touchedAreas;
    }

    function defaultFixChecks(item, summary, testSignals) {
      const reason = normalize(summary.finalReason || summary.reason || item.reason);
      if (isDeployItem(item)) {
        if (reason === "hosted_health_failed") return ["ops health", "hosted health", "post-deploy suite"];
        if (reason === "github_workflow_failed") return ["failed workflow run", "post-deploy suite"];
        if (reason === "testbed_cases_failed") return ["failed testbed case", "post-deploy suite"];
        return ["deploy workflow", "post-deploy suite"];
      }
      return testSignals.slice(0, 5);
    }

    function defaultFixRerun(item, summary) {
      if (isDeployItem(item)) {
        return "merge a fix or rollback path, then let production deploy and Hermes post-deploy verification run again";
      }
      return "push an update, then let CI and Hermes handoff run again";
    }

    function firstReviewReason(reviewReasons) {
      const first = reviewReasons.find(Boolean);
      if (!first) return "";
      const code = first.code ? String(first.code) : "review";
      const message = first.message ? String(first.message) : "Operator review recommended.";
      return code + ": " + message;
    }

    function collectPipelineItems(payload) {
      const seen = new Set();
      const entries = []
        .concat(payload.active || [])
        .concat(payload.recent || [])
        .filter(isPrPipelineItem)
        .filter((item) => {
          const key = String(item.correlationId || item.repo + "#" + item.pullRequestNumber);
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
      return keepCurrentDeployItems(entries)
        .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
    }

    function keepCurrentDeployItems(entries) {
      const latestByRepo = new Map();
      entries.forEach((item) => {
        if (!isDeployItem(item)) return;
        const key = deployRepoKey(item);
        const current = latestByRepo.get(key);
        if (!current || itemUpdatedMs(item) > itemUpdatedMs(current)) latestByRepo.set(key, item);
      });
      return entries.filter((item) => {
        if (!isDeployItem(item)) return true;
        if (item.active === true || item.activeState === "running" || normalize(item.status) === "running") return true;
        return latestByRepo.get(deployRepoKey(item)) === item;
      });
    }

    function deployRepoKey(item) {
      return String(item.repo || "unknown-deploy-repo");
    }

    function itemUpdatedMs(item) {
      const parsed = Date.parse(String(item.updatedAt || ""));
      return Number.isFinite(parsed) ? parsed : 0;
    }

    function groupPrPipelineItems(entries) {
      const groups = new Map();
      entries.forEach((item) => {
        const key = prIdentityKey(item);
        const current = groups.get(key) || [];
        current.push(item);
        groups.set(key, current);
      });
      return Array.from(groups.values())
        .map(finalizePrGroup)
        .sort((a, b) => ownerLaneSortScore(b) - ownerLaneSortScore(a) || String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
    }

    function finalizePrGroup(items) {
      const sorted = items.slice().sort((a, b) => verdictSortScore(baseReleaseVerdict(b)) - verdictSortScore(baseReleaseVerdict(a)) || String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
      const lead = sorted[0] || {};
      const groupItems = items.slice().sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
      const testCaseIds = uniqueStrings(groupItems.flatMap((item) => Array.isArray(item.testCaseIds) ? item.testCaseIds : []));
      return {
        ...lead,
        intent: "pr_group",
        groupItems,
        groupIntents: uniqueStrings(groupItems.map((item) => item.intent || "pr_handoff")),
        pullRequestNumber: lead.pullRequestNumber || pullRequestNumberFromCorrelation(lead.correlationId),
        updatedAt: groupItems[0]?.updatedAt || lead.updatedAt,
        testCaseIds,
      };
    }

    function verdictSortScore(verdict) {
      if (verdict.level === "block") return 500;
      if (verdict.level === "needs-review") return 400;
      if (verdict.level === "running") return 300;
      if (verdict.level === "pass") return 100;
      return 0;
    }

    function uniqueStrings(values) {
      return Array.from(new Set(values.map((value) => String(value || "").trim()).filter(Boolean)));
    }

    function isPrPipelineItem(item) {
      const intent = normalize(item.intent);
      const correlationId = String(item.correlationId || "");
      return Boolean(
        item.pullRequestNumber
        || intent === "pr_handoff"
        || intent === "pr_code_review"
        || intent === "testbed_suite"
        || intent.includes("deploy")
        || correlationId.startsWith("github-pr-")
        || correlationId.startsWith("github-deploy-")
      );
    }

    function pipelineTitle(item) {
      const repo = item.repo || "unknown repo";
      const prNumber = item.pullRequestNumber || pullRequestNumberFromCorrelation(item.correlationId);
      if (isDeployItem(item)) return [repo, "post-deploy"].filter(Boolean).join(" ");
      if (Array.isArray(item.groupItems)) return [repo, prNumber ? "#" + prNumber : ""].filter(Boolean).join(" ");
      const intent = item.intent || "pr_handoff";
      return [repo, prNumber ? "#" + prNumber : "", intent].filter(Boolean).join(" ");
    }

    function renderGroupBadges(item) {
      const labels = groupPhaseBadges(item);
      if (!labels.length) return "";
      return '<div class="phase-badges">' + labels.map((label) => '<span class="pill">' + escapeHtml(label) + '</span>').join("") + '</div>';
    }

    function groupPhaseBadges(item) {
      if (!Array.isArray(item.groupItems)) return [];
      return uniqueStrings(item.groupItems.map((entry) => {
        const verdict = baseReleaseVerdict(entry);
        return handoffKindLabel(entry.intent) + " " + verdict.label.toLowerCase();
      }));
    }

    function groupPhaseLabels(item) {
      if (!Array.isArray(item.groupItems)) return [];
      const labels = uniqueStrings(item.groupItems.map((entry) => handoffKindLabel(entry.intent)));
      return labels.length > 1 ? labels : [];
    }

    function handoffKindLabel(intent) {
      const kind = normalize(intent);
      if (kind === "pr_code_review") return "code review";
      if (kind === "pr_handoff") return "handoff";
      return String(intent || "handoff").replace(/_/g, " ");
    }

    function pipelineStage(item, verdict) {
      const status = normalize(item.status);
      const prState = pullRequestState(item, item.summary || {});
      if (isDonePullRequestState(prState)) return { key: "deploy", label: pullRequestStateLabel(prState) };
      if (item.active === true || item.activeState === "running" || status === "running") {
        return { key: "hermes", label: "Hermes reviewing" };
      }
      if (isDraftPullRequest(item)) return { key: "pr", label: "Draft PR" };
      if (codexTaskCompletedAfterHermesReview(item)) return { key: "hermes", label: "Hermes re-check" };
      if (verdict.level === "block") return { key: "gate", label: "Blocked at gate" };
      if (verdict.level === "needs-review") return { key: "gate", label: "Operator review" };
      if (verdict.level === "pass") return { key: "gate", label: "Ready for merge" };
      return { key: "ci", label: "CI / handoff" };
    }

    function nextPipelineActor(item, verdict) {
      const status = normalize(item.status);
      if (item.active === true || item.activeState === "running" || status === "running") return "Hermes";
      if (isDraftPullRequest(item)) return "Codex";
      if (codexTaskCompletedAfterHermesReview(item)) return "Hermes";
      if (verdict.level === "block") return "Codex";
      if (verdict.level === "needs-review") return "Operator";
      if (verdict.level === "pass") return "Merge queue";
      return "GitHub Actions";
    }

    function nextPipelineAction(item, verdict) {
      const status = normalize(item.status);
      const summary = item.summary || {};
      const reason = normalize(summary.finalReason || summary.reason || item.reason);
      const prState = pullRequestState(item, item.summary || {});
      if (isDonePullRequestState(prState)) {
        return { owner: "Done", text: "PR is no longer open in GitHub; keep this handoff as release history" };
      }
      if (item.active === true || item.activeState === "running" || status === "running") {
        return { owner: "Hermes", text: "finish the current handoff checks and publish a verdict" };
      }
      if (codexTaskFailedForItem(item)) {
        return { owner: "Codex", text: "review the failed Codex task output, push a smaller fix, or propose a retry task" };
      }
      if (isDraftPullRequest(item)) {
        return { owner: "Codex", text: "finish the draft or mark it ready for review, then let CI and Hermes re-run" };
      }
      if (codexTaskCompletedAfterHermesReview(item)) {
        return { owner: "Hermes", text: "re-run the PR handoff/code-review checks now that Codex reported completion" };
      }
      if (reason === "pr_checks_active" || reason === "ci_in_progress") {
        return { owner: "Codex", text: "wait for CI to finish on the current commit; if it fails, push the smallest fix and let Hermes re-run" };
      }
      if (verdict.level === "block") {
        if (isDeployItem(item)) {
          return { owner: "Codex", text: "open a follow-up fix PR or rollback proposal, then verify hosted health and post-deploy checks" };
        }
        return { owner: "Codex", text: "fix the blocking signal, push the PR branch, and wait for CI/Hermes to re-run" };
      }
      if (verdict.level === "needs-review") {
        return { owner: "Operator", text: "use the agent pre-check evidence to decide project intent, architecture, and rollout risk" };
      }
      if (verdict.level === "pass") {
        return { owner: "Merge queue", text: "merge when branch protection and queue checks are green" };
      }
      return { owner: "GitHub Actions", text: "finish CI before Hermes can make a release-gate recommendation" };
    }

    function handoffAge(item) {
      const updated = Date.parse(String(item.updatedAt || ""));
      if (!Number.isFinite(updated)) return { state: "waiting", label: "Waiting", duration: "unknown age" };
      const minutes = Math.max(0, Math.floor((Date.now() - updated) / 60000));
      const state = minutes >= 120 ? "stale" : minutes >= 30 ? "waiting" : "fresh";
      const label = state === "stale" ? "Stale" : state === "waiting" ? "Waiting" : "Fresh";
      return { state, label, duration: formatDuration(minutes) };
    }

    function formatDuration(minutes) {
      if (minutes < 1) return "under 1m";
      if (minutes < 60) return minutes + "m";
      const hours = Math.floor(minutes / 60);
      const rest = minutes % 60;
      return rest ? hours + "h " + rest + "m" : hours + "h";
    }

    function renderPipelineSteps(stage, verdict) {
      const steps = [
        { key: "pr", label: "PR" },
        { key: "ci", label: "CI" },
        { key: "hermes", label: "Hermes" },
        { key: "testbed", label: "Testbed" },
        { key: "gate", label: "Gate" },
        { key: "deploy", label: "Deploy" },
      ];
      const activeIndex = Math.max(0, steps.findIndex((step) => step.key === stage.key));
      return '<div class="pipeline-steps" aria-label="PR pipeline stages">' + steps.map((step, index) => {
        const state = pipelineStepState(index, activeIndex, step.key, verdict.level);
        return '<span class="pipeline-step" data-state="' + escapeAttr(state) + '">' + escapeHtml(step.label) + '</span>';
      }).join("") + '</div>';
    }

    function pipelineStepState(index, activeIndex, key, level) {
      if (index < activeIndex) return "done";
      if (index > activeIndex) return "waiting";
      if (key === "gate" && level === "block") return "blocked";
      if (key === "gate" && level === "needs-review") return "review";
      if (key === "gate" && level === "pass") return "done";
      return "active";
    }

    function renderPrTimeline(item, stage, verdict, action) {
      const summary = item.summary || {};
      const prState = pullRequestState(item, summary);
      return '<div class="pr-timeline" aria-label="PR timeline">' +
        prTimelineItems(item, stage, verdict, action, prState).map(renderPrTimelineItem).join("") +
        '</div>';
    }

    function prTimelineItems(item, stage, verdict, action, prState) {
      const summary = item.summary || {};
      const status = normalize(item.status);
      const reason = normalize(summary.finalReason || summary.reason || item.reason);
      const tests = Array.isArray(item.testCaseIds) ? item.testCaseIds : [];
      const prNumber = item.pullRequestNumber || pullRequestNumberFromCorrelation(item.correlationId);
      const workflowRunUrl = deriveWorkflowRunUrl(item);
      const hermesRunning = item.active === true || item.activeState === "running" || status === "running";
      const ciActive = stage.key === "ci" || reason === "ci_in_progress";
      const ciBlocked = verdict.level === "block" && includesAny(reason, ["ci_failed", "github_workflow_failed"]);
      return [
        {
          key: "pr",
          label: "PR",
          state: prNumber || prState ? "done" : "active",
          meta: prNumber ? "#" + prNumber : pullRequestStateLabel(prState) || "detected",
        },
        {
          key: "ci",
          label: "CI",
          state: ciBlocked ? "blocked" : ciActive ? "active" : "done",
          meta: workflowRunUrl ? "run linked" : ciActive ? "waiting for CI" : "signal recorded",
        },
        {
          key: "hermes",
          label: "Hermes",
          state: hermesRunning ? "active" : item.updatedAt ? "done" : "waiting",
          meta: hermesRunning ? "reviewing now" : "verdict recorded",
        },
        {
          key: "testbed",
          label: "Testbed",
          state: tests.length ? "done" : stage.key === "testbed" ? "active" : "waiting",
          meta: tests.length ? compactTestList(tests) : "not requested",
        },
        {
          key: "gate",
          label: "Gate",
          state: prTimelineStateForGate(verdict),
          meta: verdict.label,
        },
        {
          key: "done",
          label: "Done",
          state: isDonePullRequestState(prState) ? "done" : verdict.level === "pass" ? "active" : "waiting",
          meta: isDonePullRequestState(prState) ? pullRequestStateLabel(prState) : action.owner,
        },
      ];
    }

    function renderPrTimelineItem(item) {
      return '<div class="pr-timeline-item" data-state="' + escapeAttr(item.state) + '">' +
        '<span class="pr-timeline-label">' + escapeHtml(item.label) + '</span>' +
        '<span class="pr-timeline-meta">' + escapeHtml(item.meta) + '</span>' +
        '</div>';
    }

    function prTimelineStateForGate(verdict) {
      if (verdict.level === "block") return "blocked";
      if (verdict.level === "needs-review") return "review";
      if (verdict.level === "pass") return "done";
      if (verdict.level === "running") return "active";
      return "waiting";
    }

    function compactTestList(values) {
      const ids = values.map((value) => String(value)).filter(Boolean);
      if (ids.length <= 3) return ids.join(", ");
      return ids.slice(0, 3).join(", ") + " +" + String(ids.length - 3);
    }

    function renderHandoff(item) {
      const summary = item.summary || {};
      const title = Array.isArray(item.groupItems)
        ? pipelineTitle(item)
        : [item.repo, item.pullRequestNumber ? "#" + item.pullRequestNumber : "", item.intent].filter(Boolean).join(" ");
      const verdict = releaseVerdict(item);
      const prUrl = item.pullRequestUrl || derivePullRequestUrl(item);
      const prLabel = item.pullRequestNumber ? "#" + escapeHtml(String(item.pullRequestNumber)) : "open PR";
      const pr = prUrl ? '<a href="' + escapeAttr(prUrl) + '" target="_blank" rel="noreferrer">' + prLabel + '</a>' : "n/a";
      const commit = deriveCommitUrl(item);
      const workflowRun = deriveWorkflowRunUrl(item);
      const tests = Array.isArray(item.testCaseIds) && item.testCaseIds.length ? item.testCaseIds.map((id) => "<code>" + escapeHtml(id) + "</code>").join(" ") : "n/a";
      return '<article class="handoff" data-status="' + escapeAttr(item.status || "unknown") + '" data-verdict="' + escapeAttr(verdict.level) + '">' +
        '<div class="handoff-head"><div class="handoff-title">' + escapeHtml(title || item.correlationId || "handoff") + '</div><span class="pill state-pill" data-level="' + escapeAttr(verdict.level) + '">' + escapeHtml(verdict.label) + '</span></div>' +
        '<p class="handoff-why">' + escapeHtml(verdict.why) + '</p>' +
        '<dl>' +
        row("Correlation", "<code>" + escapeHtml(item.correlationId || "unknown") + "</code>") +
        row("Requester", escapeHtml(item.requester || "n/a")) +
        row("Phase", escapeHtml(item.phase || "unknown")) +
        row("Live state", escapeHtml(liveStateLabel(item.activeState))) +
        row("Reason", escapeHtml(item.reason || "n/a")) +
        row("Tests", tests) +
        row("PR", pr) +
        row("Commit", commit ? '<a href="' + escapeAttr(commit) + '" target="_blank" rel="noreferrer">' + escapeHtml(compactSha(item.sha)) + '</a>' : "n/a") +
        row("Workflow run", workflowRun ? '<a href="' + escapeAttr(workflowRun) + '" target="_blank" rel="noreferrer">open run</a>' : "n/a") +
        row("Verdict", escapeHtml(summary.finalVerdict || summary.status || "n/a")) +
        row("Merge", escapeHtml(summary.mergeRecommendation || "n/a")) +
        deploymentHealthRows(summary) +
        reviewSignalRows(summary) +
        reviewReasonRows(summary) +
        row("Updated", escapeHtml(item.updatedAt ? new Date(item.updatedAt).toLocaleString() : "unknown")) +
        '</dl></article>';
    }

    function buildMonitorUrl(path) {
      const separator = path.includes("?") ? "&" : "?";
      const params = new URLSearchParams({
        limit: "50",
        activeWindowMinutes: "240"
      });
      if (token) params.set("token", token);
      return path + separator + params.toString();
    }

    function buildCommandUrl(path) {
      if (!token) return path;
      const separator = path.includes("?") ? "&" : "?";
      return path + separator + "token=" + encodeURIComponent(token);
    }

    function setText(id, value) {
      const target = document.getElementById(id);
      if (target) target.textContent = String(value);
    }

    function needsAttention(item) {
      const level = releaseVerdict(item).level;
      return level === "block" || level === "needs-review";
    }

    function releaseVerdict(item) {
      const verdict = Array.isArray(item.groupItems) ? groupedReleaseVerdict(item) : baseReleaseVerdict(item);
      const decision = decisionForItem(item);
      if (verdict.level === "needs-review" && decision.status === "approved") {
        return {
          level: "pass",
          label: "APPROVED",
          why: "Operator approved this review gate in the private monitor; merge only if GitHub branch protection is green.",
        };
      }
      if (requiresReleaseReviewBeforeQueue(item, verdict)) {
        if (decision.status === "approved") {
          return {
            level: "pass",
            label: "REVIEWED",
            why: "Operator reviewed the green release packet in the private monitor; merge only if GitHub branch protection is green.",
          };
        }
        return {
          level: "needs-review",
          label: "READY REVIEW",
          why: "Hermes PASS is recorded. Operator should skim the release packet before this PR enters the merge queue.",
        };
      }
      return verdict;
    }

    function requiresReleaseReviewBeforeQueue(item, verdict) {
      if (!item || !verdict || verdict.level !== "pass") return false;
      if (isDeployItem(item)) return false;
      const prState = pullRequestState(item, item.summary || {});
      if (isDonePullRequestState(prState)) return false;
      const prNumber = item.pullRequestNumber || pullRequestNumberFromCorrelation(item.correlationId);
      return Boolean(prNumber);
    }

    function isReleaseReviewVerdict(verdict) {
      return verdict && verdict.label === "READY REVIEW";
    }

    function groupedReleaseVerdict(item) {
      const verdicts = item.groupItems.map(baseReleaseVerdict);
      const winner = verdicts.sort((a, b) => verdictSortScore(b) - verdictSortScore(a))[0] || baseReleaseVerdict(item);
      const labels = groupPhaseLabels(item);
      if (labels.length <= 1) return winner;
      return {
        ...winner,
        why: "Strictest result across " + labels.join(" + ") + ": " + winner.why,
      };
    }

    function baseReleaseVerdict(item) {
      const summary = item.summary || {};
      const status = normalize(item.status);
      const prState = pullRequestState(item, summary);
      const finalVerdict = normalize(summary.finalVerdict || summary.status);
      const mergeRecommendation = normalize(summary.mergeRecommendation);
      const reason = normalize(summary.finalReason || summary.reason || item.reason);
      const reviewReasons = Array.isArray(summary.reviewReasons) ? summary.reviewReasons : [];

      if (status === "running") {
        return { level: "running", label: "RUNNING", why: releaseReason(summary, item, "running") };
      }
      if (prState && prState.merged === true) {
        return { level: "pass", label: "MERGED", why: "GitHub reports this PR is merged; this handoff is history." };
      }
      if (prState && normalize(prState.state) === "closed") {
        return { level: "pass", label: "CLOSED", why: "GitHub reports this PR is closed; this handoff is history." };
      }
      if (prState && prState.draft === true) {
        return { level: "needs-review", label: "DRAFT", why: "GitHub reports this PR is still a draft; Codex owns finishing it or marking it ready before Hermes/operator review." };
      }
      if (prState && normalize(prState.mergeableState) === "dirty") {
        return { level: "block", label: "CONFLICT", why: "GitHub reports this PR has merge conflicts." };
      }
      if (reason === "pr_checks_active" || reason === "ci_in_progress") {
        return { level: "running", label: "CI RUNNING", why: releaseReason(summary, item, "running") };
      }
      const terminal = classifyReleaseGate(status, finalVerdict, mergeRecommendation, reason, reviewReasons);
      if (codexTaskFailedForItem(item)) {
        return { level: "block", label: "CODEX FAILED", why: "Codex task runner failed; inspect the task output or propose a smaller retry task before Hermes can continue." };
      }
      if (terminal.level !== "block" && codexTaskCompletedAfterHermesReview(item)) {
        return { level: "running", label: "HERMES RECHECK", why: "Codex reported completion after the last Hermes verdict; Hermes should re-run PR checks before release-gate movement." };
      }
      if (item.activeState === "just_finished") {
        return {
          level: terminal.level,
          label: "JUST FINISHED - " + terminal.label,
          why: releaseReason(summary, item, terminal.level),
        };
      }
      return {
        level: terminal.level,
        label: terminal.label,
        why: releaseReason(summary, item, terminal.level),
      };
    }

    function loadMonitorDecisions() {
      try {
        return JSON.parse(localStorage.getItem(decisionStorageKey) || "{}") || {};
      } catch {
        return {};
      }
    }

    function setMonitorDecision(key, value) {
      if (value) monitorDecisions[key] = value;
      else delete monitorDecisions[key];
      try {
        localStorage.setItem(decisionStorageKey, JSON.stringify(monitorDecisions));
      } catch {
        // Ignore private browser storage failures; monitor data remains read-only.
      }
    }

    function decisionForItem(item) {
      return monitorDecisions[decisionKeyForItem(item)] || (item.correlationId ? monitorDecisions[String(item.correlationId)] : {}) || {};
    }

    function decisionKeyForItem(item) {
      return prIdentityKey(item);
    }

    function prIdentityKey(item) {
      const repo = String(item.repo || "");
      const prNumber = item.pullRequestNumber || pullRequestNumberFromCorrelation(item.correlationId);
      if (repo && prNumber) return repo + "#" + prNumber;
      return String(item.correlationId || "unknown");
    }

    function classifyReleaseGate(status, finalVerdict, mergeRecommendation, reason, reviewReasons) {
      if (
        status === "failed"
        || status === "blocked"
        || includesAny(finalVerdict, ["block", "blocked", "failed", "failure", "hold"])
        || includesAny(mergeRecommendation, ["block", "blocked", "failed", "failure", "hold", "do_not_merge"])
        || includesAny(reason, ["deploy_failure", "deploy_failed", "ci_failed"])
      ) {
        return { level: "block", label: "BLOCK" };
      }
      if (
        status === "needs_review"
        || includesAny(finalVerdict, ["review", "needs_review"])
        || includesAny(mergeRecommendation, ["review", "wait", "needs_review"])
        || includesAny(reason, ["github_needs_review", "pr_review_hold", "needs_review"])
        || reviewReasons.length > 0
      ) {
        return { level: "needs-review", label: "OPERATOR REVIEW" };
      }
      return { level: "pass", label: "PASS" };
    }

    function releaseReason(summary, item, level) {
      const reviewReasons = Array.isArray(summary.reviewReasons) ? summary.reviewReasons : [];
      const first = reviewReasons.find(Boolean);
      if (first) {
        const code = String(first.code || "review");
        const message = String(first.message || "Operator review recommended.");
        return code + ": " + message;
      }
      const reason = normalize(summary.finalReason || summary.reason || item.reason);
      if (reason === "github_needs_review") return "Operator review recommended by the GitHub risk gate; agent pre-check evidence should be attached.";
      if (reason === "pr_review_hold") return "PR risk gate held this for operator review.";
      if (reason === "deploy_failure" || reason === "deploy_failed") return "Deploy failed; investigate before release.";
      if (reason === "post_deploy_healthy") return "Post-deploy suite, GitHub workflows, and configured health checks are clean.";
      if (reason === "hosted_health_failed") return "Hosted health check failed after deploy.";
      if (reason === "testbed_cases_failed") return "One or more read-only post-deploy checks failed.";
      if (reason === "github_workflow_failed") return "GitHub has a failed workflow after deploy.";
      if (reason === "ci_failed") return "CI failed; fix before merge.";
      if (reason === "pr_checks_failed") return "One or more PR checks failed; Codex should fix the failing signal before merge.";
      if (reason === "pr_checks_active") return "PR checks are still running on the head commit.";
      if (reason === "pr_checks_missing") return "GitHub has not surfaced PR check runs for this head commit yet.";
      if (reason === "pr_is_draft") return "PR is still marked as draft; Codex owns finishing it or marking it ready.";
      if (reason === "ci_in_progress") return "CI is still running; wait for the result.";
      if (level === "pass") return "No blocking release signals recorded.";
      return String(summary.finalReason || summary.reason || item.reason || item.phase || "No reason recorded.");
    }

    function pullRequestState(item, summary) {
      if (summary && typeof summary.currentPullRequest === "object" && summary.currentPullRequest !== null) return summary.currentPullRequest;
      if (summary && typeof summary.pullRequest === "object" && summary.pullRequest !== null) return summary.pullRequest;
      if (item && Array.isArray(item.groupItems)) {
        for (const entry of item.groupItems) {
          const nested = pullRequestState(entry, entry.summary || {});
          if (nested) return nested;
        }
      }
      return null;
    }

    function isDraftPullRequest(item) {
      const prState = pullRequestState(item, item.summary || {});
      return Boolean(prState && prState.draft === true && !isDonePullRequestState(prState));
    }

    function isDonePullRequestState(prState) {
      return Boolean(prState && (prState.merged === true || normalize(prState.state) === "closed"));
    }

    function pullRequestStateLabel(prState) {
      if (!prState) return "";
      const parts = [];
      if (prState.merged === true) parts.push("merged");
      else if (prState.state) parts.push(String(prState.state));
      if (prState.draft === true) parts.push("draft");
      if (prState.mergeableState) parts.push("mergeable:" + String(prState.mergeableState));
      if (prState.source === "github_live") parts.push("live");
      else if (prState.source) parts.push(String(prState.source));
      return parts.join(" / ");
    }

    function deploymentHealthRows(summary) {
      const health = summary.deploymentHealth || {};
      if (!health.finalVerdict && !health.hostedStatus && !health.githubHealth) return "";
      const rows = [];
      const suite = [
        health.suitePassed !== undefined ? "pass " + health.suitePassed : "",
        health.suiteFailed !== undefined ? "fail " + health.suiteFailed : "",
        health.suiteSkipped !== undefined ? "skip " + health.suiteSkipped : "",
      ].filter(Boolean).join(" / ");
      if (suite) rows.push(row("Deploy suite", escapeHtml(suite)));
      if (health.hostedStatus) {
        const checks = health.hostedChecks !== undefined ? " (" + health.hostedChecks + " checks)" : "";
        rows.push(row("Hosted health", escapeHtml(String(health.hostedStatus) + checks)));
      }
      if (Array.isArray(health.hostedFailedUrls) && health.hostedFailedUrls.length) {
        rows.push(row("Health failures", links(health.hostedFailedUrls)));
      }
      if (health.githubHealth) {
        const workflowBits = [
          health.githubFailingWorkflowRuns !== undefined ? "failed " + health.githubFailingWorkflowRuns : "",
          health.githubActiveWorkflowRuns !== undefined ? "active " + health.githubActiveWorkflowRuns : "",
        ].filter(Boolean).join(" / ");
        rows.push(row("GitHub workflows", escapeHtml(String(health.githubHealth) + (workflowBits ? " - " + workflowBits : ""))));
      }
      if (Array.isArray(health.githubFailingWorkflowRunUrls) && health.githubFailingWorkflowRunUrls.length) {
        rows.push(row("Failed runs", links(health.githubFailingWorkflowRunUrls)));
      }
      if (Array.isArray(health.githubActiveWorkflowRunUrls) && health.githubActiveWorkflowRunUrls.length) {
        rows.push(row("Active runs", links(health.githubActiveWorkflowRunUrls)));
      }
      if (health.opsStatus) {
        const recentErrors = health.opsRecentErrors !== undefined ? " - recent errors " + health.opsRecentErrors : "";
        rows.push(row("Ops signal", escapeHtml(String(health.opsStatus) + recentErrors)));
      }
      return rows.join("");
    }

    function reviewReasonRows(summary) {
      const reviewReasons = Array.isArray(summary.reviewReasons) ? summary.reviewReasons : [];
      if (!reviewReasons.length) return "";
      return reviewReasons.slice(0, 3).map((reason, index) => {
        const code = reason && reason.code ? String(reason.code) : "review";
        const severity = reason && reason.severity ? String(reason.severity) : "unknown";
        const message = reason && reason.message ? String(reason.message) : "Operator review recommended.";
        return row(index === 0 ? "Review why" : "", escapeHtml(severity + " / " + code + " - " + message));
      }).join("");
    }

    function reviewSignalRows(summary) {
      const signals = summary.reviewSignals || {};
      const rows = [];
      const touchedAreas = Array.isArray(signals.touchedAreas) ? signals.touchedAreas : [];
      const missingTests = Array.isArray(signals.missingTestSignals) ? signals.missingTestSignals : [];
      const testSignals = Array.isArray(signals.testSignals) ? signals.testSignals : [];
      if (touchedAreas.length) rows.push(row("Touched", chips(touchedAreas)));
      if (missingTests.length) rows.push(row("Missing tests", chips(missingTests)));
      if (testSignals.length) rows.push(row("Test signal", chips(testSignals.slice(0, 4))));
      if (signals.rolloutNotesRequired === true) {
        rows.push(row("Rollout notes", escapeHtml(signals.rolloutNotesPresent === true ? "present" : "missing")));
      }
      return rows.join("");
    }

    function chips(values) {
      return '<span class="tags">' + values.map((value) => '<code>' + escapeHtml(String(value)) + '</code>').join("") + '</span>';
    }

    function links(values) {
      return '<span class="tags">' + values.map((value, index) => '<a class="pill" href="' + escapeAttr(String(value)) + '" target="_blank" rel="noreferrer">open ' + String(index + 1) + '</a>').join("") + '</span>';
    }

    function normalize(value) {
      return String(value || "").trim().toLowerCase().replace(/[\\s-]+/g, "_");
    }

    function includesAny(value, needles) {
      return needles.some((needle) => value.includes(needle));
    }

    function liveStateLabel(value) {
      const state = normalize(value);
      if (state === "running") return "running";
      if (state === "just_finished") return "just finished";
      return "inactive";
    }

    function derivePullRequestUrl(item) {
      const repo = String(item.repo || "");
      const prNumber = Number(item.pullRequestNumber);
      if (!/^[A-Za-z0-9_.-]+\\/[A-Za-z0-9_.-]+$/.test(repo)) return "";
      if (!Number.isInteger(prNumber) || prNumber < 1) return "";
      return "https://github.com/" + repo + "/pull/" + prNumber;
    }

    function deriveCommitUrl(item) {
      const repo = String(item.repo || "");
      const sha = String(item.sha || "");
      if (!/^[A-Za-z0-9_.-]+\\/[A-Za-z0-9_.-]+$/.test(repo)) return "";
      if (!/^[a-f0-9]{7,40}$/i.test(sha)) return "";
      return "https://github.com/" + repo + "/commit/" + sha;
    }

    function deriveWorkflowRunUrl(item) {
      const repo = String(item.repo || "");
      const correlationId = String(item.correlationId || "");
      if (!/^[A-Za-z0-9_.-]+\\/[A-Za-z0-9_.-]+$/.test(repo)) return "";
      const match = correlationId.match(/github-(?:pr|deploy)-(\\d+)/);
      return match ? "https://github.com/" + repo + "/actions/runs/" + match[1] : "";
    }

    function pullRequestNumberFromCorrelation(value) {
      const match = String(value || "").match(/github-pr-(\\d+)/);
      return match ? match[1] : "";
    }

    function compactSha(value) {
      const sha = String(value || "");
      return sha ? sha.slice(0, 12) : "commit";
    }

    function row(label, value) {
      return "<dt>" + escapeHtml(label) + "</dt><dd>" + value + "</dd>";
    }

    function escapeHtml(value) {
      return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
    }

    function escapeAttr(value) {
      return escapeHtml(value).replace(new RegExp(String.fromCharCode(96), "g"), "&#96;");
    }
  </script>
</body>
</html>`;
}

function nonEmpty(value: string | undefined): string | undefined {
  return value && value.length > 0 ? value : undefined;
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[char] ?? char);
}
