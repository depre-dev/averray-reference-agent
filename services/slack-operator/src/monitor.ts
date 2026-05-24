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
    || /^(testbed agent mission|agent testbed mission|agent browser mission|browser mission|fresh agent mission|fresh agent page test|out of box agent test|out-of-box agent test|normal agent page test|can hermes test the page|test page as fresh agent)(\b.*)?$/.test(text)
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
      --z-drawer-scrim: 30;
      --z-selected-card: 31;
      --z-detail-drawer: 40;
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
    .draft-delegation {
      border-left: 4px solid var(--violet);
    }
    .merge-steward-packet {
      border-left: 4px solid var(--ok);
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
    .decision-button[data-codex-task-action="send-back"],
    .soft-button[data-codex-task-action="send-back"] {
      border-color: var(--violet);
      background: rgba(135, 132, 255, 0.12);
      color: var(--violet);
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
    /* Counter chip — number on top, small uppercase label below.
       Matches the kanban-card "pill" vocabulary instead of the
       generic outlined-pill look. Non-zero chips light up in their
       tone color; zero chips fade so the eye lands on what's actually
       live. Toggled via data-empty by JS after each render. */
    .counter-chip {
      display: inline-flex;
      flex-direction: column;
      align-items: flex-start;
      justify-content: center;
      gap: 3px;
      min-width: 70px;
      padding: 6px 12px;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: rgba(2, 9, 8, 0.3);
      white-space: nowrap;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      line-height: 1;
      transition: opacity 140ms ease, border-color 140ms ease, background 140ms ease;
    }
    .counter-chip[data-empty="true"] {
      opacity: 0.42;
      background: transparent;
      border-color: var(--line-soft);
    }
    .counter-chip[data-tone="warn"]:not([data-empty="true"]) {
      border-color: color-mix(in srgb, var(--warn) 50%, var(--line));
      background: color-mix(in srgb, var(--warn) 10%, rgba(2, 9, 8, 0.3));
    }
    .counter-chip[data-tone="warn"]:not([data-empty="true"]) .counter-number { color: var(--warn); }
    .counter-chip[data-tone="waiting"]:not([data-empty="true"]) {
      border-color: color-mix(in srgb, var(--cyan) 42%, var(--line));
      background: color-mix(in srgb, var(--cyan) 8%, rgba(2, 9, 8, 0.3));
    }
    .counter-chip[data-tone="waiting"]:not([data-empty="true"]) .counter-number { color: var(--cyan); }
    .counter-chip[data-tone="bad"]:not([data-empty="true"]) {
      border-color: color-mix(in srgb, var(--bad) 55%, var(--line));
      background: color-mix(in srgb, var(--bad) 10%, rgba(2, 9, 8, 0.3));
    }
    .counter-chip[data-tone="bad"]:not([data-empty="true"]) .counter-number { color: var(--bad); }
    .counter-chip[data-tone="ok"]:not([data-empty="true"]) {
      border-color: color-mix(in srgb, var(--ok) 50%, var(--line));
      background: color-mix(in srgb, var(--ok) 10%, rgba(2, 9, 8, 0.3));
    }
    .counter-chip[data-tone="ok"]:not([data-empty="true"]) .counter-number { color: var(--ok); }
    .counter-number {
      display: inline-flex;
      align-items: center;
      color: var(--text);
      font-weight: 800;
      font-size: 1.05rem;
      letter-spacing: 0.01em;
      line-height: 1;
    }
    .counter-label {
      display: inline-flex;
      align-items: center;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.1em;
      font-size: 0.58rem;
      line-height: 1;
    }
    /* Right-side cluster — compact: live indicator, pause toggle, last-
       refresh timestamp, refresh button. Inline rather than stacked,
       smaller padding, so the whole topbar feels coordinated instead
       of three separate widgets jammed together. */
    .refresh-cluster {
      display: flex;
      align-items: center;
      gap: 6px;
      justify-content: flex-end;
    }
    .refresh-meta {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.66rem;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.08em;
      padding: 0 8px;
      white-space: nowrap;
    }
    .refresh-meta-label { color: color-mix(in srgb, var(--muted) 70%, var(--line)); }
    .refresh-meta #generated { color: var(--text); font-weight: 600; }
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
      transition: opacity 140ms ease, border-color 140ms ease;
    }
    .toggle-pill[aria-pressed="true"] {
      border-color: var(--accent);
      background: var(--accent-bg);
    }
    /* Mirror the top-strip counter-chip dim treatment (#157): filter
       pills with count=0 fade so the eye lands on the ones that
       actually have work. Only applies when the pill ISN'T the
       currently selected filter — losing visual weight on a pressed
       pill would hide the active state. */
    .toggle-pill[data-empty="true"]:not([aria-pressed="true"]) {
      opacity: 0.42;
    }
    .board-shell {
      min-height: 0;
      min-width: 0;
      display: grid;
      grid-template-rows: auto auto minmax(0, 1fr);
      gap: 12px;
      /* Reserve room at the bottom so content scrolled to the bottom
         of the board never hides behind the fixed-position
         collaboration dock. */
      padding: 12px 14px 266px;
      overflow: hidden;
    }
    .board-now {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      align-items: center;
      gap: 12px;
      min-height: 50px;
      border: 1px solid var(--line-soft);
      border-left: 3px solid var(--muted);
      border-radius: 8px;
      background: rgba(7, 18, 15, 0.72);
      padding: 10px 12px;
      box-shadow: 0 12px 38px rgba(0, 0, 0, 0.18);
    }
    .board-now[data-tone="attention"] { border-left-color: var(--bad); background: color-mix(in srgb, var(--bad) 8%, rgba(7, 18, 15, 0.72)); }
    .board-now[data-tone="operator"] { border-left-color: var(--warn); background: color-mix(in srgb, var(--warn) 8%, rgba(7, 18, 15, 0.72)); }
    .board-now[data-tone="codex"] { border-left-color: var(--violet); background: color-mix(in srgb, var(--violet) 7%, rgba(7, 18, 15, 0.72)); }
    .board-now[data-tone="running"] { border-left-color: var(--cyan); background: color-mix(in srgb, var(--cyan) 7%, rgba(7, 18, 15, 0.72)); }
    .board-now[data-tone="queue"] { border-left-color: var(--ok); background: color-mix(in srgb, var(--ok) 7%, rgba(7, 18, 15, 0.72)); }
    .board-now[data-tone="waiting"] { border-left-color: var(--cyan); background: color-mix(in srgb, var(--cyan) 5%, rgba(7, 18, 15, 0.72)); }
    .board-now-copy {
      display: grid;
      gap: 3px;
      min-width: 0;
    }
    .board-now-kicker,
    .collab-now-kicker {
      color: var(--muted);
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.58rem;
      font-weight: 800;
      letter-spacing: 0.14em;
      text-transform: uppercase;
    }
    .board-now-title {
      min-width: 0;
      color: var(--cream);
      font-size: 0.92rem;
      font-weight: 800;
      line-height: 1.25;
      overflow-wrap: anywhere;
    }
    .board-now-next {
      min-width: 0;
      color: var(--muted);
      font-size: 0.78rem;
      line-height: 1.28;
      overflow-wrap: anywhere;
    }
    .board-now-counts {
      display: flex;
      justify-content: flex-end;
      gap: 6px;
      flex-wrap: wrap;
      min-width: 140px;
    }
    .board-now-counts .pill {
      background: rgba(0, 0, 0, 0.16);
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
    /* Kanban grid template is now driven by an inline style attribute
       set by renderBoard: each lane gets either minmax(186px, 1fr)
       (full) or 60px (collapsed rail), plus a trailing 56px slot for
       the Done rail when collapsed. The CSS only declares the display
       mode + gap; per-render widths come from JS. */
    .kanban-board {
      min-height: 0;
      min-width: 0;
      display: grid;
      gap: 12px;
      overflow-x: hidden;
      overflow-y: hidden;
      align-items: stretch;
      padding-bottom: 8px;
    }
    .kanban-board[data-done-expanded="true"] {
      overflow-x: auto;
    }
    /* Collapsed active lane — narrow vertical rail in the lane color,
       same idiom as .done-rail. Click expands it for the session via
       forcedExpandedLaneKeys; clicking the head re-collapses. */
    .lane[data-collapsed="true"] {
      cursor: pointer;
      background: rgba(2, 15, 13, 0.45);
      border-style: dashed;
      transition: background 120ms ease, border-color 120ms ease;
    }
    .lane[data-collapsed="true"]:hover {
      background: color-mix(in srgb, var(--lane-accent) 7%, rgba(2, 15, 13, 0.45));
      border-color: color-mix(in srgb, var(--lane-accent) 50%, var(--line-soft));
    }
    .lane[data-collapsed="true"]:focus-visible {
      outline: 1px solid color-mix(in srgb, var(--lane-accent) 70%, var(--cyan));
      outline-offset: 2px;
    }
    .lane[data-collapsed="true"] .lane-head {
      min-height: 100%;
      height: 100%;
      justify-content: space-between;
      padding: 10px 4px;
      gap: 10px;
      border-top-width: 0;
      border-left: 2px solid var(--lane-accent);
    }
    .lane[data-collapsed="true"] .lane-head::before {
      content: "";
      width: 6px;
      height: 6px;
      border-radius: 999px;
      background: var(--lane-accent);
      opacity: 0.75;
      margin: 0 auto;
      flex-shrink: 0;
    }
    .lane[data-collapsed="true"] .lane-title {
      writing-mode: vertical-rl;
      transform: rotate(180deg);
      align-items: center;
      justify-content: center;
      gap: 10px;
      flex: 1;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.68rem;
      letter-spacing: 0.16em;
      text-transform: uppercase;
      color: var(--muted);
      overflow: visible;
    }
    .lane[data-collapsed="true"]:hover .lane-title { color: var(--cream); }
    .lane[data-collapsed="true"] .lane-title .pill {
      writing-mode: horizontal-tb;
      transform: rotate(180deg);
      padding: 2px 8px;
      border-radius: 999px;
      border: 1px solid color-mix(in srgb, var(--lane-accent) 45%, var(--line-soft));
      background: color-mix(in srgb, var(--lane-accent) 10%, rgba(2, 15, 13, 0.7));
      color: var(--cream);
      font-size: 0.74rem;
      font-weight: 800;
      min-width: 24px;
      text-align: center;
    }
    .lane[data-collapsed="true"] .lane-subtitle,
    .lane[data-collapsed="true"] .lane-body {
      display: none;
    }
    /* Empty lane the operator explicitly expanded — clicking its head
       collapses it again. Cursor + hover signal that. */
    .lane[data-force-expanded="true"] .lane-head {
      cursor: pointer;
    }
    .lane[data-force-expanded="true"] .lane-head:hover {
      background: color-mix(in srgb, var(--lane-accent) 6%, transparent);
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
    .lane[data-lane="waiting"] { --lane-accent: var(--muted); }
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
    .handoff-card:hover {
      transform: translateY(-1px);
      border-color: var(--verdict-accent, var(--lane-accent));
      box-shadow: 0 12px 30px rgba(0, 0, 0, 0.32);
    }
    /* Selected card pops a touch more than hover — thicker accent rail
       and a subtle outer glow so when the drawer is open you can still
       see which card it belongs to behind the scrim. The drawer itself
       stays above this layer so long cards never cover drawer text. */
    .handoff-card[data-selected="true"] {
      transform: translateY(-1px);
      border-color: var(--verdict-accent, var(--lane-accent));
      border-left-width: 4px;
      box-shadow:
        0 0 0 1px color-mix(in srgb, var(--verdict-accent, var(--lane-accent)) 70%, transparent),
        0 14px 36px rgba(0, 0, 0, 0.36);
      z-index: var(--z-selected-card);
      position: relative;
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
    .card-next,
    .card-flow {
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
    .card-flow {
      display: grid;
      gap: 5px;
      padding: 7px 8px;
      border: 1px solid var(--line-soft);
      border-radius: 8px;
      background: rgba(255, 255, 255, 0.026);
    }
    .card-flow[data-owner="operator"] {
      border-color: color-mix(in srgb, var(--warn) 40%, var(--line-soft));
      background: color-mix(in srgb, var(--warn) 7%, transparent);
    }
    .card-flow[data-owner="codex"] {
      border-color: color-mix(in srgb, var(--violet) 40%, var(--line-soft));
      background: color-mix(in srgb, var(--violet) 7%, transparent);
    }
    .card-flow[data-owner="merge"] {
      border-color: color-mix(in srgb, var(--ok) 34%, var(--line-soft));
      background: color-mix(in srgb, var(--ok) 6%, transparent);
    }
    .card-flow-row {
      display: flex;
      align-items: center;
      gap: 7px;
      min-width: 0;
    }
    .card-flow-label {
      flex: 0 0 auto;
      min-width: 42px;
      color: var(--faint);
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.58rem;
      font-weight: 800;
      letter-spacing: 0.1em;
      text-transform: uppercase;
    }
    .card-flow-text {
      color: var(--cream);
      min-width: 0;
      overflow-wrap: anywhere;
    }
    .card-flow-row[data-kind="after"] .card-flow-text {
      color: var(--muted);
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
      line-height: 1.15;
      text-align: center;
      white-space: normal;
    }
    .soft-button[data-action="primary"] {
      border-color: var(--lane-accent);
      color: var(--lane-accent);
      background: color-mix(in srgb, var(--lane-accent) 12%, transparent);
    }
    /* Backdrop scrim that dims the rest of the page while the detail
       drawer is open. Sits below the selected-card focus layer and
       below the drawer. Click anywhere on the scrim to close. */
    #drawer-scrim {
      position: fixed;
      inset: 0;
      z-index: var(--z-drawer-scrim);
      background: rgba(2, 9, 8, 0.55);
      backdrop-filter: blur(2px);
      opacity: 0;
      pointer-events: none;
      transition: opacity 180ms ease;
    }
    #drawer-scrim[data-open="true"] {
      opacity: 1;
      pointer-events: auto;
    }
    .drawer {
      position: fixed;
      inset: 0 0 0 auto;
      width: clamp(420px, 31vw, 640px);
      z-index: var(--z-detail-drawer);
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
    .drawer-disclosure {
      display: grid;
      gap: 10px;
    }
    .drawer-disclosure summary {
      cursor: pointer;
      color: var(--muted);
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.68rem;
      font-weight: 800;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      list-style: none;
      user-select: none;
    }
    .drawer-disclosure summary::-webkit-details-marker { display: none; }
    .drawer-disclosure summary::before {
      content: "›";
      display: inline-block;
      margin-right: 7px;
      color: var(--accent);
      transform: rotate(0deg);
      transition: transform 0.15s ease;
    }
    .drawer-disclosure[open] summary::before { transform: rotate(90deg); }
    .drawer-disclosure h3 { margin-bottom: 0; }
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
      /* Compact dock anchored at the bottom. Earlier we tried to fill
         the viewport when the board was short (#145) but that left the
         dock floating with empty room ABOVE it once the board grew. A
         small floor + a moderate ceiling keeps the dock present without
         dominating the screen. */
      min-height: 218px;
      max-height: min(32vh, 310px);
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
    /* Mid-width breakpoint: when the viewport is too narrow for the
       chat thread + 320-430px compose form to sit side-by-side and
       still leave the thread readable, stack the compose BELOW the
       thread instead. Thread takes full width; compose gets a fixed
       compact height. Below 760px we already have a different layout
       (mobile bottom-sheet via #fab-ask), so this only covers the
       1180-760px range. */
    @media (max-width: 1180px) and (min-width: 761px) {
      .command-console {
        grid-template-columns: minmax(0, 1fr);
        grid-template-rows: minmax(0, 1fr) auto;
        max-height: min(56vh, 540px);
      }
      .command-shell.has-selection .command-console {
        right: 14px;
      }
      .console-compose {
        padding-left: 0;
        padding-top: 10px;
        border-top: 1px solid var(--line-soft);
      }
    }
    .console-main {
      position: relative; /* anchor point for the unread-pill */
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
       a tighter margin-top to visually attach to the previous same-
       speaker row without running into it. Non-grouped rows get more
       breathing room since there's no panel border doing that work. */
    .collab-message + .collab-message { margin-top: 12px; }
    .collab-message[data-grouped="true"] { margin-top: 4px; }
    .collab-now {
      display: grid;
      gap: 6px;
      margin: 0 0 12px;
      border: 1px solid var(--line-soft);
      border-left: 3px solid var(--cyan);
      border-radius: 8px;
      background: rgba(7, 18, 15, 0.68);
      padding: 10px 12px;
    }
    .collab-now-title {
      color: var(--cream);
      font-weight: 800;
      line-height: 1.3;
    }
    .collab-now-next {
      color: var(--muted);
      font-size: 0.82rem;
      line-height: 1.32;
    }
    .collab-now-counts {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
    }
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
    /* Minimal chat-line style. No bordered panel, no colored left-rail
       — both of those are the kanban card idiom and made the chat
       read as another task board instead of as a conversation. Now
       each message is just: author label on one line, message text on
       the next, breathing room between. Author identity comes from
       the uppercase tracked label's color, not from a card border. */
    .collab-message {
      display: flex;
      flex-direction: column;
      gap: 2px;
      align-items: stretch;
      padding: 0;
      border: 0;
      border-radius: 0;
      background: transparent;
      min-width: 0;
    }
    .collab-message[data-speaker="codex"] { --speaker-accent: var(--violet); }
    .collab-message[data-speaker="hermes"] { --speaker-accent: var(--cyan); }
    .collab-message[data-speaker="operator"] { --speaker-accent: var(--warn); }
    .collab-message[data-speaker="system"] { --speaker-accent: var(--muted); }
    /* System / idle rows: a centered subdued italic note. Reads as a
       status line, not as either an agent message or a card. */
    .collab-message[data-speaker="system"] {
      align-items: center;
      text-align: center;
      color: var(--muted);
      font-style: italic;
      padding: 2px 0;
    }
    .collab-message[data-speaker="system"] .collab-byline { display: none; }
    .collab-message[data-speaker="system"] .collab-text {
      color: var(--muted);
      font-style: italic;
      font-size: 0.78rem;
    }
    .collab-byline {
      display: flex;
      align-items: baseline;
      gap: 10px;
      min-width: 0;
      flex-wrap: wrap;
    }
    /* Speaker label inherits the page's uppercase-tracked-monospace
       voice — same family as the drawer section headers — but now in
       the agent's color so identity reads at a glance without a card
       border doing the work. */
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
      /* Cap so a long meta ("board changed · Operator Review ·
         OPERATOR REVIEW") can't push past the chat column and bleed
         into the compose area. Ellipsis when it would otherwise
         overflow; min-width:0 lets it actually shrink in the flex
         row instead of forcing horizontal overflow. */
      max-width: min(60%, 320px);
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      margin-left: auto;
    }
    .collab-text {
      color: var(--text);
      font-size: 0.9rem;
      line-height: 1.5;
      overflow-wrap: anywhere;
    }
    /* "more ↓" / "less ↑" toggle for long synthesized messages. Sits
       inline at the end of the truncated text so it reads as an
       extension of the sentence, not a separate UI block. */
    .collab-more {
      display: inline-flex;
      align-items: center;
      margin-left: 6px;
      padding: 0;
      border: 0;
      background: transparent;
      color: color-mix(in srgb, var(--cyan) 80%, var(--text));
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.72rem;
      letter-spacing: 0.02em;
      cursor: pointer;
      vertical-align: baseline;
    }
    .collab-more:hover { color: var(--cyan); text-decoration: underline; }
    /* When fully expanded the "less ↑" sits on its own line beneath the
       text — looks neater than glued to the end of a paragraph. */
    .collab-message[data-expanded="true"] .collab-more {
      display: inline-block;
      margin-left: 0;
      margin-top: 6px;
    }
    /* Posted messages: the inline POSTED pill in the byline already
       signals "real chat". Brighten the body text so it reads as the
       load-bearing line in the thread. No background tint, no rail. */
    .collab-message[data-posted="true"] .collab-text { color: var(--cream); }
    /* request_help: a small warn-colored dot before the speaker label
       calls attention to the row without imposing a panel background. */
    .collab-message[data-kind="request_help"] .collab-byline::before {
      content: "●";
      color: var(--warn);
      font-size: 0.6em;
      line-height: 1;
      margin-right: -4px;
      flex-shrink: 0;
    }
    /* Grouped messages: a second+ message in a same-speaker run. The
       previous CSS used the bordered panel to thread them visually.
       Without panels, grouping just collapses the gap and hides the
       repeated speaker label (the render code drops it server-side
       too). The "↳ 1m later" follow-pill in the byline carries the
       continuation cue. */
    .collab-message[data-grouped="true"] .collab-byline { gap: 8px; }
    .collab-follow {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.62rem;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: color-mix(in srgb, var(--speaker-accent, var(--muted)) 70%, var(--muted));
    }
    /* Freshness cue without a card: pulse the speaker label color
       through cream and back. Subtle, runs once, doesn't draw a box. */
    @keyframes collab-speaker-pulse {
      0%   { color: var(--speaker-accent); }
      50%  { color: var(--cream); }
      100% { color: var(--speaker-accent); }
    }
    .collab-message[data-newest="true"] .collab-speaker {
      animation: collab-speaker-pulse 1.4s ease-out 1;
    }
    /* Slide-in for newly-arrived messages — they fade in from below
       instead of popping into existence. data-fresh is set by JS only
       on messages whose id wasn't in the previous render's id set. */
    @keyframes collab-slide-in {
      from { opacity: 0; transform: translateY(8px); }
      to   { opacity: 1; transform: translateY(0); }
    }
    .collab-message[data-fresh="true"] {
      animation: collab-slide-in 260ms ease-out 1;
    }
    /* "Hermes is typing…" row. Same layout as a real message so the
       chat doesn't jitter when the real reply lands; just three dots
       cycling through opacity to signal activity. */
    .collab-message[data-typing="true"] .collab-typing-label {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.66rem;
      letter-spacing: 0.06em;
      text-transform: lowercase;
      color: var(--muted);
      font-style: italic;
    }
    .typing-dots {
      display: inline-flex;
      gap: 4px;
      align-items: center;
      vertical-align: middle;
    }
    .typing-dots span {
      width: 5px;
      height: 5px;
      border-radius: 999px;
      background: var(--cyan);
      opacity: 0.25;
      animation: typing-bounce 1.1s ease-in-out infinite;
    }
    .typing-dots span:nth-child(2) { animation-delay: 0.18s; }
    .typing-dots span:nth-child(3) { animation-delay: 0.36s; }
    @keyframes typing-bounce {
      0%, 60%, 100% { opacity: 0.25; transform: translateY(0); }
      30%           { opacity: 1;    transform: translateY(-3px); }
    }
    /* "N new ↓" pill — anchored to the bottom-right of the chat output
       when the operator has scrolled up and fresh messages arrived.
       Click to jump to the latest message and clear the unread count.
       The parent .console-main needs position:relative for the
       absolute anchor to work; that rule was already there. */
    .collab-unread-pill {
      position: absolute;
      right: 14px;
      bottom: 14px;
      z-index: 4;
      padding: 5px 11px;
      border-radius: 999px;
      border: 1px solid color-mix(in srgb, var(--cyan) 50%, var(--line));
      background: color-mix(in srgb, var(--cyan) 18%, rgba(2, 9, 8, 0.92));
      color: var(--cream);
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.68rem;
      letter-spacing: 0.06em;
      cursor: pointer;
      box-shadow: 0 6px 18px rgba(0, 0, 0, 0.32);
      animation: collab-slide-in 200ms ease-out 1;
    }
    .collab-unread-pill:hover {
      background: color-mix(in srgb, var(--cyan) 28%, rgba(2, 9, 8, 0.92));
    }
    /* Chat-head meta cluster + mute toggle button. Lives at the top
       right of the collaboration thread next to the live-status text. */
    .collab-head-meta {
      display: inline-flex;
      align-items: center;
      gap: 8px;
    }
    .collab-sound-toggle {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 22px;
      height: 22px;
      padding: 0;
      border: 1px solid var(--line-soft);
      border-radius: 6px;
      background: rgba(2, 9, 8, 0.4);
      color: var(--text);
      font-size: 0.78rem;
      line-height: 1;
      cursor: pointer;
      transition: border-color 120ms ease, background 120ms ease;
    }
    .collab-sound-toggle:hover {
      border-color: color-mix(in srgb, var(--cyan) 50%, var(--line));
      background: color-mix(in srgb, var(--cyan) 8%, rgba(2, 9, 8, 0.4));
    }
    .collab-sound-toggle[aria-pressed="false"] { opacity: 0.55; }
    /* Presence footer — small row at the bottom of the chat thread
       showing what each agent is doing right now. Compact, monospace,
       one tinted dot per agent matching the speaker color. Idle
       agents fade so the eye lands on who's actually busy. */
    .collab-presence {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 16px;
      margin-top: 14px;
      padding: 8px 12px;
      border-top: 1px solid rgba(184, 211, 196, 0.08);
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.66rem;
      color: var(--muted);
    }
    .collab-presence-agent {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      min-width: 0;
      max-width: 100%;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      transition: opacity 140ms ease;
    }
    .collab-presence-agent[data-active="false"] { opacity: 0.45; }
    .collab-presence-dot {
      width: 6px;
      height: 6px;
      border-radius: 999px;
      flex-shrink: 0;
      background: var(--muted);
    }
    .collab-presence-agent[data-agent="codex"] .collab-presence-dot { background: var(--violet); }
    .collab-presence-agent[data-agent="hermes"] .collab-presence-dot { background: var(--cyan); }
    .collab-presence-agent[data-agent="operator"] .collab-presence-dot { background: var(--warn); }
    .collab-presence-agent[data-active="true"] .collab-presence-dot {
      box-shadow: 0 0 0 0 currentColor;
      animation: collab-presence-pulse 2s ease-out infinite;
    }
    @keyframes collab-presence-pulse {
      0%   { box-shadow: 0 0 0 0 color-mix(in srgb, currentColor 50%, transparent); }
      70%  { box-shadow: 0 0 0 5px color-mix(in srgb, currentColor 0%, transparent); }
      100% { box-shadow: 0 0 0 0 transparent; }
    }
    .collab-presence-name {
      color: var(--cream);
      font-weight: 700;
      letter-spacing: 0.06em;
      text-transform: uppercase;
    }
    .collab-presence-agent[data-active="false"] .collab-presence-name { color: var(--muted); }
    .collab-presence-status {
      color: var(--muted);
      overflow: hidden;
      text-overflow: ellipsis;
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
      /* On the mid-width breakpoint we keep the lanes horizontally
         scrollable at a fixed minimum width. !important wins over the
         inline grid-template-columns set by JS on desktop. */
      .kanban-board,
      .kanban-board[data-done-expanded="true"] {
        grid-template-columns: repeat(8, minmax(250px, 82vw)) !important;
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
    /* Hide the sys-block when it's idle — the live-status indicator on
       the right of the topbar already conveys "system is doing fine".
       Two "idle" indicators is the placeholder vibe we're cleaning up. */
    .sys[data-state="idle"] { display: none; }
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
    /* Stale-tier escalation: a 2-hour stuck PR is yellow, a half-day
       stuck PR is orange, a day-plus stuck PR is bold red. Heavier
       font-weight on higher tiers as a color-blind-friendly fallback. */
    .stale-dot[data-stale-tier="warn"]     { background: var(--warn);      box-shadow: 0 0 0 2px rgba(217, 173, 66, 0.24); animation: none; }
    .stale-dot[data-stale-tier="high"]     { background: #f59c47;          box-shadow: 0 0 0 2px rgba(245, 156, 71, 0.30); animation: pulse 2.2s ease-out infinite; }
    .stale-dot[data-stale-tier="critical"] { background: var(--bad);       box-shadow: 0 0 0 2px rgba(238, 98, 96, 0.40); animation: pulse 1.3s ease-out infinite; }
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
    /* Stale-tier wins over the broader data-stale rules so the age
       text matches its dot. Higher tiers get a heavier weight. */
    .kc-head-r[data-stale-tier="warn"]     .card-age { color: var(--warn);  font-weight: 600; }
    .kc-head-r[data-stale-tier="high"]     .card-age { color: #f59c47;      font-weight: 700; }
    .kc-head-r[data-stale-tier="critical"] .card-age { color: var(--bad);   font-weight: 800; letter-spacing: 0.06em; }
    .handoff-card[data-lane="waiting"] .stale-dot[data-stale="waiting"] {
      background: var(--cyan);
      box-shadow: 0 0 0 2px rgba(86, 204, 228, 0.16);
      animation: none;
    }
    .handoff-card[data-lane="waiting"] .card-head .stale-dot[data-stale="waiting"] ~ .card-age {
      color: var(--muted);
      font-weight: 650;
    }
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
    .actor-pill[data-actor="external"] { --actor-accent: var(--muted); }
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
    .done-row:hover {
      transform: translateY(-1px);
      border-color: var(--ok);
      background: color-mix(in srgb, var(--ok) 6%, var(--surface-strong));
    }
    .done-row[data-verdict="block"]:hover { border-color: var(--bad); background: color-mix(in srgb, var(--bad) 6%, var(--surface-strong)); }
    /* Selected done-row pops above the scrim too, but remains below the
       drawer if a future action opens one from a Done entry. */
    .done-row[data-selected="true"] {
      transform: translateY(-1px);
      border-color: var(--ok);
      box-shadow:
        0 0 0 1px color-mix(in srgb, var(--ok) 70%, transparent),
        0 10px 26px rgba(0, 0, 0, 0.34);
      z-index: var(--z-selected-card);
      position: relative;
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
    /* Tiny chevron at the end of each done-row hints that clicking
       toggles an inline detail strip below (it flips ▾ → ▴ when open). */
    .done-row .done-caret {
      color: var(--muted);
      font-size: 0.78rem;
      line-height: 1;
      margin-left: 2px;
    }
    /* Expanded done-row attaches to the detail strip below it: collapse
       the bottom corners + soften the bottom border so the two read as
       one stacked panel. */
    .done-row[data-expanded="true"] {
      border-bottom-left-radius: 0;
      border-bottom-right-radius: 0;
      border-bottom-color: transparent;
      background: color-mix(in srgb, var(--ok) 5%, var(--surface-strong));
    }
    .done-row[data-expanded="true"][data-verdict="block"] {
      background: color-mix(in srgb, var(--bad) 5%, var(--surface-strong));
    }
    /* Inline detail strip rendered as a sibling of the .done-row when
       expanded. Compact two-row dl (Closed time + Verdict) on the left,
       Open PR link on the right. Read-only — no actions, no drawer. */
    .done-row-detail {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 12px;
      align-items: center;
      padding: 8px 12px 10px;
      border: 1px solid var(--line);
      border-top: 0;
      border-radius: 0 0 6px 6px;
      background: var(--surface-strong);
      margin-top: -2px;
      font-size: 0.78rem;
    }
    .done-row-detail dl {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr);
      gap: 4px 12px;
      margin: 0;
      min-width: 0;
    }
    .done-row-detail dt {
      color: var(--muted);
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.62rem;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      align-self: baseline;
    }
    .done-row-detail dd {
      color: var(--text);
      margin: 0;
      min-width: 0;
      overflow-wrap: anywhere;
    }
    .done-row-detail .done-detail-open {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 4px 10px;
      border-radius: 6px;
      border: 1px solid var(--line);
      background: var(--surface-soft);
      color: var(--cyan);
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.72rem;
      letter-spacing: 0.02em;
      text-decoration: none;
      white-space: nowrap;
    }
    .done-row-detail .done-detail-open:hover {
      border-color: color-mix(in srgb, var(--cyan) 55%, var(--line));
      background: color-mix(in srgb, var(--cyan) 8%, var(--surface-soft));
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
      .board-now {
        grid-template-columns: 1fr;
        align-items: start;
      }
      .board-now-counts {
        justify-content: flex-start;
        min-width: 0;
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
      /* The 640px mobile breakpoint switches the board to a single
         column flat list. JS clears the inline grid-template-columns
         on mobile (see renderBoard); the !important here is belt and
         braces in case JS hasn't run yet (initial paint). */
      .kanban-board,
      .kanban-board[data-done-expanded="true"] {
        display: flex !important;
        flex-direction: column;
        gap: 6px;
        overflow-x: hidden;
        overflow-y: auto;
        padding-bottom: 12px;
        grid-template-columns: none !important;
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
      .lane-chip[data-lane="waiting"]   { --lc-accent: var(--muted); }
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
        <span class="counter-chip" data-tone="warn" title="All open work that needs an owner now"><span id="attention-chip" class="counter-number">0</span><span class="counter-label">action needed</span></span>
        <span class="counter-chip" data-tone="bad" title="Blocked cards that need a fix or explicit decision"><span id="blocked-chip" class="counter-number">0</span><span class="counter-label">blocked fixes</span></span>
        <span class="counter-chip" data-tone="waiting" title="Draft PRs parked until the author or owning agent marks them ready"><span id="waiting-chip" class="counter-number">0</span><span class="counter-label">waiting drafts</span></span>
        <span class="counter-chip" title="Cards waiting for operator sign-off"><span id="review-chip" class="counter-number">0</span><span class="counter-label">operator review</span></span>
        <span class="counter-chip" data-tone="ok" title="Reviewed PRs waiting for merge stewardship"><span id="ready-chip" class="counter-number">0</span><span class="counter-label">merge queue</span></span>
        <span class="counter-chip" title="Hermes checks or deploy verification currently moving"><span id="running-chip" class="counter-number">0</span><span class="counter-label">checking/deploy</span></span>
        <span id="deploy-health-chip" class="counter-chip cc-health" data-state="idle"><span class="counter-number" id="deploy-health-state">IDLE</span><span class="counter-label">deploy health</span></span>
      </div>
      <div class="refresh-cluster">
        <span id="live-status" class="cmd-status cmd-status-rich" data-state="connecting" title="connecting to monitor stream">
          <span class="cmd-status-state" id="live-status-state">connecting</span>
          <span class="cmd-status-sub" id="live-status-sub">auto 5s</span>
        </span>
        <button id="pause" class="cmd-pause" type="button" aria-pressed="false" title="Pause live updates">❚❚</button>
        <span class="refresh-meta" title="time of the last monitor snapshot"><span class="refresh-meta-label">last refresh</span><span id="generated">waiting</span></span>
        <button id="refresh" type="button" title="Force a refresh now">Refresh</button>
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
      <button class="mobile-tab" type="button" data-mobile-tab="waiting" aria-pressed="false">Waiting <span class="mt-count" id="mt-waiting">0</span></button>
      <button class="mobile-tab" type="button" data-mobile-tab="codex" aria-pressed="false">Codex <span class="mt-count" id="mt-codex">0</span></button>
      <button class="mobile-tab" type="button" data-mobile-tab="hermes" aria-pressed="false">Hermes <span class="mt-count" id="mt-hermes">0</span></button>
      <button class="mobile-tab" type="button" data-mobile-tab="operator" aria-pressed="false">Review <span class="mt-count" id="mt-operator">0</span></button>
      <button class="mobile-tab" type="button" data-mobile-tab="queue" aria-pressed="false">Ready <span class="mt-count" id="mt-queue">0</span></button>
      <button class="mobile-tab" type="button" data-mobile-tab="deploy" aria-pressed="false">Deploy <span class="mt-count" id="mt-deploy">0</span></button>
      <button class="mobile-tab" type="button" data-mobile-tab="done" aria-pressed="false">Done <span class="mt-count" id="mt-done">0</span></button>
    </nav>
    <section class="board-shell">
      <div id="pull-indicator" data-state="idle" aria-hidden="true"><span class="pi-spinner"></span><span class="pi-label">Pull to refresh</span></div>
      <section id="board-now" class="board-now" data-tone="quiet" aria-live="polite">
        <div class="board-now-copy">
          <span class="board-now-kicker">Board now</span>
          <strong class="board-now-title">Loading the live board read...</strong>
          <span class="board-now-next">Hermes will summarize the next useful move here.</span>
        </div>
      </section>
      <section id="owner-lanes" class="kanban-board" aria-label="Release command board"><div class="empty">Loading command board...</div></section>
    </section>
    <div id="drawer-scrim" data-open="false" aria-hidden="true"></div>
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
    // Done-row inline expansion key. Independent from selectedKey because
    // done-rows DON'T open the full drawer — clicking one toggles a small
    // detail strip in place. Only one row expanded at a time.
    let expandedDoneKey = "";
    let autoFocusPending = true;
    let latestPipelineItems = [];
    let latestCodexTasks = [];
    let latestCodexRunner = null;
    let latestPayload = null;
    let latestCollabMessages = [];
    let latestBoardNarrations = [];
    let previousBoardNarrationState = new Map();
    let hasBoardNarrationSnapshot = false;
    const BOARD_NARRATION_LIMIT = 12;
    // Set of message IDs we've already shown — used to mark NEW messages
    // with data-fresh so they slide in instead of popping into existence.
    let knownCollabMessageIds = new Set();
    // Tracks an in-flight Hermes auto-reply. While set, a "Hermes is
    // typing…" row renders at the bottom of the thread. Cleared when the
    // reply arrives or the poll window expires.
    let hermesTypingSinceMs = 0;
    // Page title flash state for unfocused tabs.
    const baseDocumentTitle = document.title;
    let unreadPostedCount = 0;
    // Audio notification for @operator addressed posts. Persisted via
    // localStorage so the operator's mute preference survives reloads.
    const SOUND_STORAGE_KEY = "averray-monitor-collab-sound:v1";
    let collabSoundEnabled = (function () {
      try { return localStorage.getItem(SOUND_STORAGE_KEY) !== "off"; }
      catch (e) { return true; }
    })();
    let collabAudioContext = null;
    // Tracks the set of posted message IDs we've already played a sound
    // for, so the same message doesn't re-chime on every SSE snapshot.
    const playedSoundIds = new Set();
    // Snapshot of the rendered chat thread element so the scroll helpers
    // can stick to bottom when the operator is at the bottom, and show a
    // "N new ↓" affordance when they've scrolled up to read history.
    let unreadScrolledCount = 0;
    // Empty active lanes collapse to a narrow rail unless the operator
    // clicks them — clicking adds the lane key here and the next render
    // shows the lane expanded with its placeholder. Persists for the
    // session; cleared on reload. Doesn't apply to lanes that have items
    // (those are always expanded).
    const forcedExpandedLaneKeys = new Set();
    // Per-message expand state for long synthesized chat lines. Persists
    // for the session; keyed by collabRowKey(message) so synthesized
    // messages (no server id) match across re-renders. The renderer
    // shows a truncated summary + "more ↓" button by default, expands
    // to the full text when the key is in this set.
    const expandedCollabRowKeys = new Set();
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
      // Clicking a collapsed (rail) lane expands it for the session.
      // Clicking the head of an empty force-expanded lane collapses it
      // again. Lanes with items aren't affected (no toggle on those).
      const collapsedLane = event.target && event.target.closest
        ? event.target.closest('.lane[data-collapsed="true"]')
        : null;
      if (collapsedLane) {
        const key = collapsedLane.getAttribute("data-lane");
        if (key) {
          forcedExpandedLaneKeys.add(key);
          if (latestPipelineItems) renderBoard(latestPipelineItems);
        }
        return;
      }
      const forceExpandedHead = event.target && event.target.closest
        ? event.target.closest('.lane[data-force-expanded="true"] .lane-head')
        : null;
      if (forceExpandedHead) {
        const lane = forceExpandedHead.closest(".lane");
        const key = lane ? lane.getAttribute("data-lane") : null;
        if (key) {
          forcedExpandedLaneKeys.delete(key);
          if (latestPipelineItems) renderBoard(latestPipelineItems);
        }
        return;
      }
      const card = event.target && event.target.closest ? event.target.closest("[data-select-card]") : null;
      const interactive = event.target && event.target.closest ? event.target.closest("button,a,input") : null;
      // The "interactive" check exists to stop clicks on inner buttons
      // inside a kanban card from also selecting the card. But when the
      // selectable element IS itself a button (the done-row case), the
      // interactive check would skip the selection. Treat "interactive
      // === card" as "this whole element is the selectable" and let the
      // selection happen.
      if (card && (!interactive || interactive === card)) {
        // Done-rows behave differently from kanban cards. The closed-PR
        // detail is read-only; the big slide-over drawer is overkill.
        // Toggle a small inline detail strip in place instead.
        if (card.classList && card.classList.contains("done-row")) {
          const key = String(card.getAttribute("data-select-card") || "");
          expandedDoneKey = expandedDoneKey === key ? "" : key;
          renderBoard(latestPipelineItems);
          return;
        }
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
        const item = itemByBoardKey(selectedKey);
        renderBoard(latestPipelineItems);
        renderDrawer(selectedItem());
        renderCommandContext();
        if (item && codexTaskFailedForItem(item)) void postFailedTaskReviewReceipt(item);
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
        const cardKey = String(suggestion.closest("[data-select-card]")?.getAttribute("data-select-card") || selectedKey || "");
        const item = itemByBoardKey(cardKey) || selectedItem();
        const targetInput = suggestion.closest("#ask-sheet") ? document.getElementById("ask-input") : document.getElementById("command-input");
        if (targetInput) {
          targetInput.value = contextualCommand(value);
          targetInput.focus();
        }
        if (!suggestion.classList.contains("suggestion")) void postCommandSuggestionReceipt(value, item);
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
      const soundToggle = event.target && event.target.closest ? event.target.closest("#collab-sound-toggle") : null;
      if (soundToggle) {
        setCollabSoundEnabled(!collabSoundEnabled);
        // Play a confirmation chime on enable so the operator hears
        // what they just turned on (and the AudioContext gets unlocked).
        if (collabSoundEnabled) playOperatorChime();
        return;
      }
      // Toggle the expanded state for a long synthesized chat message.
      // Re-renders the collaboration thread so the row paints with
      // the full text (or back to the summary) using the same diff/
      // animation path as a normal SSE tick.
      const collabMore = event.target && event.target.closest ? event.target.closest("[data-collab-more]") : null;
      if (collabMore) {
        const key = collabMore.getAttribute("data-collab-more");
        if (key) {
          if (expandedCollabRowKeys.has(key)) expandedCollabRowKeys.delete(key);
          else expandedCollabRowKeys.add(key);
          // Force the thread to re-render even if data-auto is currently
          // false (some flows pin it off — see Ask Hermes).
          forceThreadMode();
          renderAutoCollaborationThread();
        }
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
      const item = itemByDecisionKey(key) || selectedItem();
      const verdict = item ? releaseVerdict(item) : null;
      if (decision === "approve") setMonitorDecision(key, { status: "approved", at: new Date().toISOString() });
      if (decision === "reset") setMonitorDecision(key, null);
      if (latestPayload) render(latestPayload);
      void postMonitorDecisionReceipt(item, decision, verdict);
    });

    function closeSelectedDrawer() {
      selectedKey = "";
      autoFocusPending = false;
      renderBoard(latestPipelineItems);
      renderDrawer(null);
      renderCommandContext();
    }
    // Scrim → click anywhere outside the drawer to close it. The scrim
    // sits z-index 19 below the drawer's z-index 20 so it never eats
    // clicks meant for the drawer's content.
    document.getElementById("drawer-scrim")?.addEventListener("click", () => {
      if (selectedKey) closeSelectedDrawer();
    });
    // Esc key → close the drawer. Doesn't interfere with form input
    // because the existing compose form doesn't use Esc for anything.
    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      if (!selectedKey) return;
      closeSelectedDrawer();
    });
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
    // Attach scroll listeners once at boot — they self-guard with a
    // dataset flag so re-running this is a no-op.
    ensureCollabScrollListeners();

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
    // over ~7 seconds so any Hermes reply surfaces visibly without
    // waiting for the next SSE snapshot tick (up to 5s). Hermes can
    // take 2-5s when the LLM voice path is active (Ollama Cloud call),
    // so the polling window has to span at least that. Bails out as
    // soon as a new message arrives so we don't keep polling forever.
    function pollCollaborationSince(sinceMs) {
      let attempts = 0;
      const maxAttempts = 9;
      const intervalMs = 800;
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
                // Hermes spoke — drop the typing indicator so the real
                // reply takes its place in the next render.
                hermesTypingSinceMs = 0;
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
        if (attempts < maxAttempts) {
          setTimeout(tick, intervalMs);
        } else {
          // Poll window expired without a Hermes reply. Drop the typing
          // dots so the operator isn't left staring at "Hermes is typing…"
          // forever — the reply (if any) will arrive on a later SSE tick.
          if (hermesTypingSinceMs) {
            hermesTypingSinceMs = 0;
            renderAutoCollaborationThread();
          }
        }
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
          // Show "Hermes is typing…" right away — Hermes will reply in
          // ~1–5s. The typing row sits at the bottom of the thread and
          // is removed once the real reply arrives (or the poll window
          // expires). Only show it for posts addressed to Hermes or
          // everyone — Hermes doesn't reply to ops-to-Codex.
          if (composeTarget === "hermes" || composeTarget === "everyone") {
            hermesTypingSinceMs = Date.now();
          }
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
        if (result && result.testbedMissionRun) {
          await load();
          selectedKey = String(result.testbedMissionRun.id || selectedKey || "");
          renderBoard(latestPipelineItems);
          renderDrawer(selectedItem());
          renderCommandContext();
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
      const incomingCollab = normalizeCollabMessages(payload.collaborationMessages);
      // Diff against the previous render so we know which posted
      // messages are genuinely new this tick. Drives the title flash,
      // the operator chime, and the scroll "N new ↓" affordance.
      const prevPostedIds = new Set(
        (latestCollabMessages || []).filter((m) => m && m.id).map((m) => String(m.id))
      );
      const freshlyPosted = incomingCollab.filter((m) => m && m.id && !prevPostedIds.has(String(m.id)));
      if (document && document.hidden) {
        unreadPostedCount += freshlyPosted.length;
        updateUnreadTitle();
      }
      // Chime for any @operator-addressed posts that just landed. Self-
      // posts and synthesized lines are filtered inside the helper.
      maybeChimeForOperator(freshlyPosted);
      latestCollabMessages = incomingCollab;
      latestCodexTasks = normalizeCodexTasks(payload.codexTasks);
      latestCodexRunner = normalizeCodexRunner(payload.codexTasks && payload.codexTasks.runner);
      latestPipelineItems = groupPrPipelineItems(collectPipelineItems(payload));
      const boardNarrationsAdded = captureBoardNarrations(latestPipelineItems);
      if (boardNarrationsAdded > 0 && shouldBoardNarrationOpenThread()) forceThreadMode();
      const laneCounts = commandBoardLaneCounts(latestPipelineItems);
      const blocked = laneCounts.attention || 0;
      const waiting = laneCounts.waiting || 0;
      const review = laneCounts.operator || 0;
      const ready = laneCounts.queue || 0;
      const running = (laneCounts.hermes || 0) + (laneCounts.deploy || 0);
      setCounterChip("attention-chip", blocked + review + (laneCounts.codex || 0));
      setCounterChip("blocked-chip", blocked);
      setCounterChip("waiting-chip", waiting);
      setCounterChip("review-chip", review);
      setCounterChip("ready-chip", ready);
      setCounterChip("running-chip", running);
      updateSysAgents(latestPipelineItems);
      updateDeployHealth(latestPipelineItems);
      renderPipelineBoard(latestPipelineItems);
      renderBoardNowSummary(latestPipelineItems);
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
      const counts = commandBoardLaneCounts(filtered);
      // anyActiveItems = at least one non-done lane has cards. When the
      // board is fully idle we leave every lane fully expanded so the
      // operator sees the workflow shape and the empty placeholders.
      // When work appears, empty lanes collapse to a narrow vertical
      // rail (same idiom as the Done rail) to make room for the lanes
      // that actually have something to show.
      const anyActiveItems = lanes.some((lane) => lane.key !== "done" && (counts[lane.key] || 0) > 0);
      // Mobile-tab filter narrows the set to a single lane (or all). The
      // mobile board renders lanes in order, with empty lanes suppressed
      // — empty placeholders are visual noise on a phone.
      const mobile = isMobileViewport();
      const visibleLanes = lanes.filter((lane) => {
        if (mobile) {
          if (mobileLaneTab !== "all" && lane.key !== mobileLaneTab) return false;
          // Hide the Done lane unless the operator explicitly picked it.
          if (lane.key === "done" && mobileLaneTab !== "done") return false;
          return true;
        }
        if (lane.key === "done") return showDone;
        // Desktop: keep every active lane in the DOM — empty ones just
        // render as a narrow rail. forcedExpandedLaneKeys lets the
        // operator click a rail to expand it for a session.
        return true;
      });
      // Decide which lanes are in rail mode for this render. Only on
      // desktop (mobile uses a flat list) and only when there's any
      // active work — otherwise everything stays fully expanded.
      const collapsedKeys = new Set();
      if (!mobile && anyActiveItems) {
        for (const lane of visibleLanes) {
          if (lane.key === "done") continue;
          if ((counts[lane.key] || 0) > 0) continue;
          if (forcedExpandedLaneKeys.has(lane.key)) continue;
          collapsedKeys.add(lane.key);
        }
      }
      // Build the grid-template-columns inline so each rail stays at a
      // fixed narrow width and each expanded lane gets a fair share of
      // the remaining space. Trailing 56px slot is the Done rail (when
      // collapsed). Mobile clears the inline style so the flex column
      // layout in the responsive CSS wins.
      if (mobile) {
        target.style.removeProperty("grid-template-columns");
      } else {
        const cols = visibleLanes.map((lane) => {
          if (lane.key === "done") return "minmax(220px, 1fr)";
          // 210px min (was 186px) so card content has room before it
          // wraps — "Stale 35h 38m", action buttons, and the "Inspect
          // draft" pill were getting squished at the old min.
          return collapsedKeys.has(lane.key) ? "66px" : "minmax(210px, 1fr)";
        });
        if (!showDone) cols.push("56px");
        target.style.gridTemplateColumns = cols.join(" ");
      }
      target.innerHTML = visibleLanes
        .map((lane) => renderBoardLane(lane, filtered, {
          mobile,
          collapsed: collapsedKeys.has(lane.key),
          forceExpanded: forcedExpandedLaneKeys.has(lane.key) && (counts[lane.key] || 0) === 0,
        }))
        .join("") + (!mobile && !showDone ? renderDoneStub(filtered) : "");
      updateMobileTabCounts(filtered);
    }

    function shouldBoardNarrationOpenThread() {
      if (selectedKey) return false;
      return [document.getElementById("command-output"), document.getElementById("ask-output")]
        .some((output) => output && output.dataset.auto !== "false");
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
      const counts = { all: 0, attention: 0, waiting: 0, codex: 0, hermes: 0, operator: 0, queue: 0, deploy: 0, done: 0 };
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
        { key: "attention", title: "Needs Attention", kicker: "blocked · decide/fix", empty: "No blockers waiting." },
        { key: "waiting", title: "Waiting / Drafts", kicker: "author finishes", empty: "No external drafts waiting." },
        { key: "codex", title: "Codex Needed", kicker: "create/approve task", empty: "No Codex action needed." },
        { key: "hermes", title: "Hermes Checking", kicker: "wait for verdict", empty: "Hermes has no active PR checks." },
        { key: "operator", title: "Operator Review", kicker: "risk decision", empty: "No operator sign-off needed." },
        { key: "queue", title: "Release Queue", kicker: "merge steward", empty: "Nothing ready to merge." },
        { key: "deploy", title: "Deploying", kicker: "verify production", empty: "No deploy verification active." },
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
      const collapsed = Boolean(options && options.collapsed);
      const forceExpanded = Boolean(options && options.forceExpanded);
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
      // data-collapsed turns the lane into a vertical rail (CSS).
      // data-force-expanded marks an empty lane that the operator manually
      // expanded via clicking the rail; clicking the lane head re-collapses
      // it. Lanes with items are always fully expanded — the toggle only
      // applies to lanes with zero items.
      const collapsedAttr = collapsed ? ' data-collapsed="true" role="button" tabindex="0" aria-label="Expand ' + escapeAttr(lane.title) + ' lane"' : "";
      const forceExpandedAttr = forceExpanded ? ' data-force-expanded="true"' : "";
      return '<section class="lane" data-lane="' + escapeAttr(lane.key) + '"' + collapsedAttr + forceExpandedAttr + '>' +
        '<div class="lane-head"><div class="lane-title">' + escapeHtml(lane.title) + ' <span class="pill">' + escapeHtml(String(items.length)) + '</span></div><span class="lane-subtitle">' + escapeHtml(lane.kicker) + '</span></div>' +
        '<div class="lane-body">' + cards + '</div>' +
        '</section>';
    }

    // Compact one-line entry for the Done lane when expanded. Clicking
    // the row toggles a small inline detail strip below it (see
    // renderDoneRowDetail) — not the full slide-over drawer, which is
    // overkill for read-only closed PRs.
    function renderDoneRow(item /*, lane */) {
      const verdict = releaseVerdict(item);
      const key = boardItemKey(item);
      const expanded = key === expandedDoneKey;
      const age = handoffAge(item);
      const repo = String(item.repo || "");
      const repoShort = repo.split("/")[1] || repo;
      const prNumber = item.pullRequestNumber || pullRequestNumberFromCorrelation(item.correlationId);
      const idLabel = prNumber ? "#" + prNumber : (isDeployItem(item) ? "deploy" : "handoff");
      const title = cardTitleText(pipelineTitle(item), prNumber, item);
      const row = '<button class="done-row" data-select-card="' + escapeAttr(key) + '" data-expanded="' + (expanded ? "true" : "false") + '" data-verdict="' + escapeAttr(verdict.level) + '" type="button" aria-expanded="' + (expanded ? "true" : "false") + '">' +
        '<span class="done-check">' + (verdict.level === "block" ? "!" : "✓") + '</span>' +
        '<span class="done-id"><span class="done-repo">' + escapeHtml(repoShort) + '</span><span class="done-num">' + escapeHtml(idLabel) + '</span></span>' +
        '<span class="done-title">' + escapeHtml(title) + '</span>' +
        '<span class="done-age">' + escapeHtml(age.label + " " + age.duration) + '</span>' +
        '<span class="done-caret" aria-hidden="true">' + (expanded ? "▴" : "▾") + '</span>' +
        '</button>';
      return row + (expanded ? renderDoneRowDetail(item, verdict) : "");
    }

    // Inline detail strip rendered beneath a clicked done-row. Read-only
    // summary — what was the verdict, when did it finish, where can the
    // operator go to look at it on GitHub.
    function renderDoneRowDetail(item, verdict) {
      const prUrl = item.pullRequestUrl || derivePullRequestUrl(item);
      const updatedIso = String(item.updatedAt || "");
      const closedLabel = updatedIso
        ? new Date(updatedIso).toLocaleString()
        : "unknown";
      const verdictLabel = (verdict && verdict.label) ? verdict.label : "completed";
      const why = (verdict && verdict.why) ? shortenVerdictWhy(verdict.why) : "";
      const openPr = prUrl
        ? '<a class="done-detail-open" href="' + escapeAttr(prUrl) + '" target="_blank" rel="noreferrer">Open PR ↗</a>'
        : '';
      return '<div class="done-row-detail" data-key="' + escapeAttr(boardItemKey(item)) + '">' +
        '<dl>' +
          '<dt>Closed</dt><dd>' + escapeHtml(closedLabel) + '</dd>' +
          '<dt>Verdict</dt><dd>' + escapeHtml(verdictLabel) + (why ? ' · ' + escapeHtml(why) : '') + '</dd>' +
        '</dl>' +
        openPr +
      '</div>';
    }

    function renderBoardCard(item, lane) {
      const verdict = releaseVerdict(item);
      const action = nextPipelineAction(item, verdict);
      const stage = pipelineStage(item, verdict);
      const age = boardCardAge(item, lane);
      const title = pipelineTitle(item);
      const key = boardItemKey(item);
      const selected = key === selectedKey;
      const signals = (item.summary || {}).reviewSignals || {};
      const touchedAreas = Array.isArray(signals.touchedAreas) ? signals.touchedAreas : [];
      const tests = Array.isArray(signals.testSignals) ? signals.testSignals : [];
      const cardWhy = lane.key === "operator" && verdict.level === "needs-review" ? operatorDecisionShort(item, verdict) : verdict.why;
      const missionItem = isTestbedMissionItem(item);
      const mission = missionItem ? (testbedMissionRun(item) || {}) : {};
      const repo = missionItem ? "testbed/mission" : (item.repo || "unknown repo");
      const repoShort = String(repo).split("/")[1] || repo;
      const prNumber = item.pullRequestNumber || pullRequestNumberFromCorrelation(item.correlationId);
      const idLabel = missionItem
        ? missionShortLabel(mission.id || item.correlationId)
        : (prNumber ? "#" + prNumber : (isDeployItem(item) ? "deploy" : "handoff"));
      const activeAgent = activeAgentForItem(item, lane, stage);
      const codexState = lane.key === "codex" ? codexWorkState(item, stage) : null;
      const locallyApproved = decisionForItem(item).status === "approved";
      const staleState = age.state || "fresh";
      const flow = cardFlowCopy(item, verdict, action, lane, codexState);
      return '<article class="handoff-card" data-select-card="' + escapeAttr(key) + '" data-selected="' + escapeAttr(String(selected)) + '" data-verdict="' + escapeAttr(verdict.level) + '" data-lane="' + escapeAttr(lane.key) + '">' +
        '<span class="lane-chip" data-lane="' + escapeAttr(lane.key) + '">' + escapeHtml(lane.title) + '</span>' +
        '<div class="card-head">' +
          '<div class="kc-head-l">' +
            '<span class="pill state-pill" data-level="' + escapeAttr(verdict.level) + '">' + escapeHtml(verdict.label) + '</span>' +
            (codexState ? '<span class="work-state" data-state="' + escapeAttr(codexState.state) + '">' + escapeHtml(codexState.label) + '</span>' : "") +
            (activeAgent ? '<span class="active-agent" data-agent="' + escapeAttr(activeAgent.id) + '"><span class="aa-dot"></span>' + escapeHtml(activeAgent.label) + '</span>' : "") +
          '</div>' +
          '<div class="kc-head-r" data-stale-tier="' + escapeAttr(age.staleTier || "") + '">' +
            '<span class="stale-dot" data-stale="' + escapeAttr(staleState) + '" data-stale-tier="' + escapeAttr(age.staleTier || "") + '" title="' + escapeAttr(staleState + (age.staleTier ? " · " + age.staleTier : "")) + '"></span>' +
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
        renderCardFlow(action, flow) +
        '<div class="card-foot"><span class="card-next"><span class="card-next-label">waiting on</span>' + renderActorPill(action.owner) + '</span><span class="card-actions">' + primaryActionButton(item, verdict, action, lane) + '</span></div>' +
        '</article>';
    }

    function boardCardAge(item, lane) {
      const age = handoffAge(item);
      if (lane && lane.key === "waiting") {
        return {
          state: age.state === "fresh" ? "fresh" : "waiting",
          label: age.state === "fresh" ? "Fresh" : "Parked",
          duration: age.duration,
          staleTier: "",
        };
      }
      return age;
    }

    function missionShortLabel(value) {
      const raw = String(value || "mission");
      const parts = raw.replace(/^testbed-mission-/, "").split("-");
      return "mission " + (parts.length > 1 ? parts.slice(-2).join("-") : parts[0]);
    }

    function renderCardFlow(action, flow) {
      return '<div class="card-flow" data-owner="' + escapeAttr(actorSlug(action.owner)) + '">' +
        '<div class="card-flow-row" data-kind="button"><span class="card-flow-label">Button</span><span class="card-flow-text">' + escapeHtml(flow.button) + '</span></div>' +
        '<div class="card-flow-row" data-kind="after"><span class="card-flow-label">After</span><span class="card-flow-text">' + escapeHtml(flow.after) + '</span></div>' +
        '</div>';
    }

    function cardFlowCopy(item, verdict, action, lane, codexState) {
      if (isTestbedMissionItem(item)) {
        return {
          button: "Opens the mission packet, prompt, rubric, and report schema.",
          after: "Run a clean browser-capable agent and paste the structured report back into this room.",
        };
      }
      if (lane.key === "codex") {
        const state = codexState || codexWorkState(item, pipelineStage(item, verdict));
        if (state.state === "proposed") {
          return { button: "Approves the queued task for Codex.", after: "Codex runner may claim it; cancel if the prompt is wrong." };
        }
        if (state.state === "approved") {
          return { button: "Opens the approved task details.", after: "Wait for the runner; copy the prompt only as fallback." };
        }
        if (state.state === "waiting") {
          return { button: "Creates a proposed Codex task; it does not start work yet.", after: "Review the prompt in the drawer, then approve it if Codex should start." };
        }
        if (state.state === "ci") {
          return { button: "Asks for GitHub CI status.", after: "If CI fails, Codex fixes; if CI passes, Hermes reviews the PR again." };
        }
        return { button: "Opens the Codex run/task details.", after: "Use the drawer to inspect progress, retry, or request a Hermes re-check." };
      }
      if (isDraftPullRequest(item)) {
        if (isExternalDraftPullRequest(item)) {
          return { button: "Opens draft context; no Codex task starts from the card.", after: "Wait for the PR author or owning agent to mark it ready, unless you explicitly delegate Codex takeover." };
        }
        return { button: "Opens the active Codex draft task.", after: "Codex finishes the delegated draft work, marks ready, then CI and Hermes re-run." };
      }
      if (verdict.level === "block") {
        if (codexTaskFailedForItem(item)) {
          return { button: "Opens the failed Codex task output; no retry starts from the card.", after: "Inspect the runner error, then create a smaller retry task from the drawer." };
        }
        return { button: "Opens the blocker plan; no GitHub action happens from the card.", after: "Create or approve a Codex task from the drawer, then wait for CI/Hermes." };
      }
      if (verdict.level === "needs-review") {
        if (isCriticalFileReview(item, item.summary || {})) {
          return { button: "Opens the critical-file risk checklist.", after: "Approve locally only if the secret/deploy/schema boundary is intentional." };
        }
        if (isReleaseReviewVerdict(verdict)) {
          return { button: "Opens the release packet.", after: "Mark reviewed to move this green PR toward the release queue." };
        }
        return { button: "Opens the operator checklist.", after: "Approve locally or send it back to Codex with a concrete ask." };
      }
      if (verdict.level === "running") {
        return { button: "Asks Hermes for the current handoff details.", after: "Wait for Hermes to publish a verdict before assigning more work." };
      }
      if (verdict.level === "pass" && lane.key === "queue") {
        return { button: "Posts a merge-steward context request; it does not merge or deploy.", after: "If stewardship is clear, merge outside the monitor; then watch GitHub deploy and post-deploy verification." };
      }
      return { button: "Opens handoff details.", after: action.text || "Follow the owner handoff shown on this card." };
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
      if (v.indexOf("author") >= 0 || v.indexOf("external") >= 0) return "external";
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
      if (item && isTestbedMissionItem(item)) return "Fresh-agent browser mission";
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
      if (isDraftPullRequest(item)) {
        return isExternalDraftPullRequest(item) ? "Draft waiting for author" : "Draft delegated to Codex";
      }
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
      if (isTestbedMissionItem(item)) {
        const mission = testbedMissionRun(item) || {};
        const missionStatus = normalize(mission.status || status);
        if (missionStatus === "completed" || missionStatus === "failed") return null;
        return { id: "hermes", label: "Mission ready" };
      }
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
        if (isExternalDraftPullRequest(item)) return "";
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

    function codexDelegationPromptForItem(item, summary) {
      const repo = String(item.repo || "averray-agent/agent");
      const pr = item.pullRequestNumber || pullRequestNumberFromCorrelation(item.correlationId);
      const prLabel = pr ? "PR #" + pr : "this PR";
      const title = cardTitleText(pipelineTitle(item), pr, item);
      const correlation = item.correlationId ? " Correlation: " + item.correlationId + "." : "";
      const signals = summary && summary.reviewSignals ? summary.reviewSignals : {};
      const testSignals = Array.isArray(signals.testSignals) ? signals.testSignals.map(String).filter(Boolean) : [];
      const checks = testSignals.length ? " Relevant signals already seen: " + testSignals.slice(0, 6).join(", ") + "." : "";
      return "Take over " + repo + " " + prLabel + " (" + title + "). The operator explicitly delegated this draft from the Waiting / Drafts lane to Codex. First inspect the PR branch and current draft state; do not assume the work is complete. If the missing work is clear and safe, finish the smallest verifiable slice, run the relevant checks, push updates, and mark the PR ready for review only when it is actually complete. If the branch lacks context or ownership should remain with the original author, report that clearly and do not mark it ready. Do not merge or deploy." + checks + correlation;
    }

    function codexOperatorSendBackPromptForItem(item, summary, verdict, action) {
      const repo = String(item.repo || "averray-agent/agent");
      const pr = item.pullRequestNumber || pullRequestNumberFromCorrelation(item.correlationId);
      const prLabel = pr ? "PR #" + pr : "this PR";
      const title = cardTitleText(pipelineTitle(item), pr, item);
      const correlation = item.correlationId ? " Correlation: " + item.correlationId + "." : "";
      const signals = summary && summary.reviewSignals ? summary.reviewSignals : {};
      const touchedAreas = Array.isArray(signals.touchedAreas) ? signals.touchedAreas.map(String).filter(Boolean) : [];
      const missingTests = Array.isArray(signals.missingTestSignals) ? signals.missingTestSignals.map(String).filter(Boolean) : [];
      const reasons = operatorSendBackReasons(summary, verdict);
      const surfaces = touchedAreas.length ? " Touched areas: " + touchedAreas.slice(0, 6).join(", ") + "." : "";
      const tests = missingTests.length ? " Missing test signals: " + missingTests.slice(0, 6).join(", ") + "." : "";
      return "Follow up on " + repo + " " + prLabel + " (" + title + "). The operator sent this PR back from review instead of approving it locally. Review the Hermes/operator evidence first: " + reasons + "." + surfaces + tests + " Make the smallest targeted fix if the review points to code, tests, rollout notes, or architecture risk. If no code change is justified, report that clearly in the task output and leave the PR for operator review. Push updates only when you have a concrete fix, then let CI and Hermes re-run. Do not merge or deploy." + correlation;
    }

    function operatorSendBackReasons(summary, verdict) {
      const reasons = Array.isArray(summary && summary.reviewReasons) ? summary.reviewReasons : [];
      const text = reasons.slice(0, 4).map((reason) => {
        const code = String((reason && reason.code) || "review");
        const message = String((reason && reason.message) || "").trim();
        return message ? code + ": " + message : code;
      }).filter(Boolean).join("; ");
      return text || String(verdict && verdict.why || "operator review needs Codex follow-up").trim();
    }

    function renderMiniSteps(stage, verdict) {
      const steps = ["pr", "ci", "hermes", "testbed", "gate", "deploy"];
      const activeIndex = Math.max(0, steps.indexOf(stage.key));
      return '<div class="mini-steps" aria-label="Pipeline progress">' + steps.map((key, index) => {
        return '<span class="mini-step" data-state="' + escapeAttr(pipelineStepState(index, activeIndex, key, verdict.level)) + '"></span>';
      }).join("") + '</div>';
    }

    function primaryActionButton(item, verdict, action, lane) {
      if (isTestbedMissionItem(item)) {
        return '<button class="soft-button" data-action="primary" type="button" data-review-card="' + escapeAttr(boardItemKey(item)) + '" title="Open the mission packet, prompt, and expected report">Open mission packet</button>';
      }
      if (lane.key === "codex") {
        const state = codexWorkState(item, pipelineStage(item, verdict));
        if (state.state === "proposed" && state.task) {
          return '<button class="soft-button" data-action="primary" type="button" data-codex-task-action="approve" data-card-key="' + escapeAttr(boardItemKey(item)) + '" data-codex-task-id="' + escapeAttr(state.task.id) + '" title="Approve this queued task so Codex can pick it up">Approve Codex task</button>';
        }
        if (state.state === "approved" && state.task) {
          return '<button class="soft-button" type="button" data-review-card="' + escapeAttr(boardItemKey(item)) + '" title="Open the approved Codex task details">View approved task</button>';
        }
        if (state.state === "waiting") {
          return '<button class="soft-button" data-action="primary" type="button" data-codex-task-action="propose" data-card-key="' + escapeAttr(boardItemKey(item)) + '" title="Create a proposed Codex task; it still needs approval">Create Codex task</button>';
        }
        if (state.state === "ci") return '<button class="soft-button" type="button" data-command-suggestion="github status" title="Ask for the current GitHub CI status">Check CI status</button>';
        return '<button class="soft-button" type="button" data-review-card="' + escapeAttr(boardItemKey(item)) + '" title="Open Codex task/run details">View Codex run</button>';
      }
      if (verdict.level === "block") {
        if (codexTaskFailedForItem(item)) {
          return '<button class="soft-button" data-action="primary" type="button" data-review-card="' + escapeAttr(boardItemKey(item)) + '" title="Open failed Codex task output and retry controls; this does not mutate GitHub">Review failed task</button>';
        }
        return '<button class="soft-button" data-action="primary" type="button" data-review-card="' + escapeAttr(boardItemKey(item)) + '" title="Open the blocker plan; this does not mutate GitHub">Open fix plan</button>';
      }
      if (isExternalDraftPullRequest(item)) return '<button class="soft-button" data-action="primary" type="button" data-review-card="' + escapeAttr(boardItemKey(item)) + '" title="Open draft context; no Codex task starts from this card">Inspect draft</button>';
      if (isDraftPullRequest(item)) return '<button class="soft-button" data-action="primary" type="button" data-review-card="' + escapeAttr(boardItemKey(item)) + '" title="Open the active Codex draft task">Open Codex task</button>';
      if (verdict.level === "needs-review") {
        const label = isCriticalFileReview(item, item.summary || {}) ? "Open risk review" : isReleaseReviewVerdict(verdict) ? "Open release review" : "Open review checklist";
        return '<button class="soft-button" data-action="primary" type="button" data-review-card="' + escapeAttr(boardItemKey(item)) + '" title="Open the operator review drawer; no GitHub action happens from this card">' + escapeHtml(label) + '</button>';
      }
      if (verdict.level === "running") return '<button class="soft-button" data-action="primary" type="button" data-command-suggestion="handoff monitor details" title="Ask Hermes what is currently running">Ask what is running</button>';
      if (verdict.level === "pass" && lane.key === "queue") return '<button class="soft-button" data-action="primary" type="button" data-command-suggestion="merge steward details" title="Ask for merge context; this does not merge">Ask merge steward</button>';
      return '<button class="soft-button" type="button" data-command-suggestion="handoff monitor details" title="Open handoff context">Inspect details</button>';
    }

    function boardLaneForItem(item, verdict) {
      const summary = item.summary || {};
      const status = normalize(item.status);
      const reason = normalize(summary.finalReason || summary.reason || item.reason);
      const prState = pullRequestState(item, summary);
      if (isTestbedMissionItem(item)) {
        const mission = testbedMissionRun(item) || {};
        const missionStatus = normalize(mission.status || summary.status || status);
        if (missionStatus === "completed") return { key: "done" };
        if (missionStatus === "failed") return { key: "attention" };
        return { key: "hermes" };
      }
      if (isDonePullRequestState(prState)) return { key: "done" };
      if (isDeployItem(item)) {
        if (item.active === true || item.activeState === "running" || status === "running") return { key: "deploy" };
        return verdict.level === "pass" ? { key: "done" } : { key: "attention" };
      }
      if (isExternalDraftPullRequest(item)) return { key: "waiting" };
      if (isDraftPullRequest(item)) return { key: "waiting" };
      if (item.active === true || item.activeState === "running" || status === "running") return { key: "hermes" };
      const codexTask = codexTaskForItem(item);
      if (codexTaskFailedForItem(item)) return { key: "attention" };
      if (codexTask && !isTerminalCodexTask(codexTask)) return { key: "codex" };
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

    function isTestbedMissionItem(item) {
      const summary = (item && item.summary) || {};
      return normalize(item && item.intent) === "testbed_agent_mission"
        || normalize(summary.kind) === "testbed_mission_run"
        || Boolean(summary.testbedMission);
    }

    function testbedMissionRun(item) {
      const summary = (item && item.summary) || {};
      return summary.testbedMission || item.testbedMission || null;
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
      if (isTestbedMissionItem(item)) return String(item.correlationId || "testbed-mission");
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

    function itemByDecisionKey(key) {
      if (!key) return null;
      for (const item of latestPipelineItems) {
        if (decisionKeyForItem(item) === key) return item;
        if (Array.isArray(item.groupItems)) {
          const nested = item.groupItems.find((entry) => decisionKeyForItem(entry) === key);
          if (nested) return item;
        }
      }
      return null;
    }

    function matchingPipelineItem(item) {
      if (!item) return null;
      const repo = String(item.repo || "");
      const pr = Number(item.pullRequestNumber || pullRequestNumberFromCorrelation(item.correlationId));
      if (!repo || !Number.isFinite(pr) || pr < 1) return null;
      return latestPipelineItems.find((candidate) => {
        const candidatePr = Number(candidate.pullRequestNumber || pullRequestNumberFromCorrelation(candidate.correlationId));
        return String(candidate.repo || "") === repo && candidatePr === pr;
      }) || null;
    }

    function preserveSelectedActionContext(key, fallbackItem) {
      const match = itemByBoardKey(key) || matchingPipelineItem(fallbackItem);
      if (match) {
        selectedKey = boardItemKey(match);
      } else if (key) {
        selectedKey = key;
      }
      autoFocusPending = false;
      renderBoard(latestPipelineItems);
      renderDrawer(selectedItem() || fallbackItem || null);
      renderCommandContext();
    }

    function normalizeCodexTasks(value) {
      if (Array.isArray(value)) return value.filter(Boolean);
      if (value && Array.isArray(value.items)) return value.items.filter(Boolean);
      return [];
    }

    function codexTaskForItem(item) {
      const candidates = codexTasksForItem(item);
      return candidates.find((task) => !isTerminalCodexTask(task)) || candidates[0] || null;
    }

    function codexTasksForItem(item) {
      if (!item) return [];
      const repo = String(item.repo || "");
      const pr = Number(item.pullRequestNumber || pullRequestNumberFromCorrelation(item.correlationId));
      if (!repo || !Number.isFinite(pr) || pr < 1) return [];
      return latestCodexTasks
        .filter((task) => String(task.repo || "") === repo && Number(task.pullRequestNumber) === pr)
        .sort((a, b) => Date.parse(String(b.updatedAt || b.createdAt || "")) - Date.parse(String(a.updatedAt || a.createdAt || "")));
    }

    function isTerminalCodexTask(task) {
      const status = normalize(task && task.status);
      return status === "completed" || status === "failed" || status === "cancelled";
    }

    function renderDrawer(item) {
      const target = document.getElementById("detail-drawer");
      const scrim = document.getElementById("drawer-scrim");
      if (!target) return;
      if (!item) {
        target.dataset.open = "false";
        if (scrim) scrim.dataset.open = "false";
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
      if (scrim) scrim.dataset.open = "true";
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
        '<section class="drawer-section">' + renderHandoffOwnerContract(item, verdict, action) + '</section>' +
        '<section class="drawer-section">' + renderActionRecipe(item, summary, verdict, action) + '</section>' +
        renderTestbedMissionPanel(item, summary) +
        renderMergeStewardPacket(item, summary, verdict, action) +
        '<section class="drawer-section"><h3>Hermes verdict</h3>' + renderHermesVerdictBox(verdict, age) + (richReviewWhy ? '<div class="review-why">' + richReviewWhy + '</div>' : "") + '</section>' +
        renderDraftDelegationPanel(item, summary) +
        renderCodexTaskPrompt(item, summary, verdict, action) +
        (verdict.level === "block" ? renderBlockResolutionPanel(item, summary, verdict, action) : "") +
        (verdict.level === "needs-review" && !isDraftPullRequest(item) ? '<section class="drawer-section">' + renderOperatorChecklistPanel(item, verdict, action) + '</section>' : "") +
        renderDrawerDisclosureSection("Agent pre-check", renderAgentPrecheckList(item, summary, verdict, stage)) +
        renderDrawerDisclosureSection("Checks", renderCheckMatrix(summary, testSignals)) +
        ((touchedFiles.length || touchedAreas.length) ? renderDrawerDisclosureSection("Touched files", renderTouchedFiles(touchedFiles, touchedAreas)) : "") +
        renderDrawerDisclosureSection("Timeline", renderTimelineList(stage, verdict, item)) +
        renderDrawerDisclosureSection("References", renderReferencesKv(item, prUrl, workflowRunUrl, commitUrl, rollout, action)) +
        renderPhaseHistorySection(item) +
        renderOperatorDecisionNote(item) +
        '</div>' +
        '<div class="drawer-footer">' +
        '<div class="card-actions">' +
        (prUrl ? '<a class="pill" href="' + escapeAttr(prUrl) + '" target="_blank" rel="noreferrer">Open PR</a>' : "") +
        (workflowRunUrl ? '<a class="pill" href="' + escapeAttr(workflowRunUrl) + '" target="_blank" rel="noreferrer">Workflow Run</a>' : "") +
        '<button class="soft-button" type="button" data-command-suggestion="handoff monitor details">Ask Hermes for context</button>' +
        renderTestbedMissionFooterActions(item) +
        renderCodexFooterAction(item, summary, verdict, action) +
        '<button class="soft-button" type="button" data-copy-text="' + escapeAttr(item.correlationId || "") + '">Copy correlation id</button>' +
        renderOperatorFooterActions(item, verdict, locallyApproved) +
        '</div></div>';
    }

    function renderOperatorFooterActions(item, verdict, locallyApproved) {
      if (verdict.level !== "needs-review" || isDraftPullRequest(item) || locallyApproved) return "";
      return renderOperatorApprovalButton(item, verdict, "soft-button") +
        renderOperatorSendBackButton(item, "soft-button");
    }

    function renderOperatorApprovalButton(item, verdict, className) {
      return '<button class="' + escapeAttr(className || "decision-button") + '" data-action="primary" type="button" data-monitor-decision="approve" data-decision-key="' + escapeAttr(decisionKeyForItem(item)) + '" title="Private monitor decision only; this does not mutate GitHub">' + escapeHtml(operatorApprovalButtonLabel(item, verdict)) + '</button>';
    }

    function renderOperatorSendBackButton(item, className) {
      return '<button class="' + escapeAttr(className || "decision-button") + '" type="button" data-codex-task-action="send-back" data-card-key="' + escapeAttr(boardItemKey(item)) + '" title="Create and approve a Codex follow-up task from this operator review">Send back to Codex</button>';
    }

    function operatorApprovalButtonLabel(item, verdict) {
      if (isReleaseReviewVerdict(verdict)) return "Mark release reviewed";
      if (isCriticalFileReview(item, item.summary || {})) return "Approve risk review";
      return "Approve operator review";
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
          '<div class="oc-role"><strong>Codex</strong><span>builds code, fixes blockers, and resolves drafts only when a task is explicitly delegated.</span></div>' +
          '<div class="oc-role"><strong>Hermes</strong><span>runs read-only PR checks, code-risk review, testbed verification, and publishes the verdict.</span></div>' +
          '<div class="oc-role"><strong>Operator</strong><span>decides project intent, architecture, rollout, and business risk after agent pre-check evidence exists.</span></div>' +
          '<div class="oc-role"><strong>Queue</strong><span>merges only after branch protection, Hermes verdict, and any operator sign-off are clean.</span></div>' +
        '</div>' +
      '</div>';
    }

    function ownerContractForItem(item, verdict, action) {
      if (isTestbedMissionItem(item)) {
        return {
          owner: "Hermes",
          action: "Run this as a normal browser-only agent mission, not as an internal operator. The board is waiting for the structured report, not a code PR.",
        };
      }
      if (isDraftPullRequest(item)) {
        if (isExternalDraftPullRequest(item)) {
          return {
            owner: "PR author",
            action: "The PR is still draft. Hermes is watching it, but Codex should not take over unless the operator explicitly delegates that work.",
          };
        }
        return {
          owner: "Codex",
          action: "Codex has an active delegated task for this draft. Finish it or mark it ready for review, then let CI and Hermes re-run.",
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
      const proof = recipe.proof.length
        ? '<details class="drawer-disclosure recipe-proof-disclosure"><summary>Proof signals</summary><span class="recipe-proof">' + recipe.proof.map((value) => '<code>' + escapeHtml(value) + '</code>').join("") + '</span></details>'
        : escapeHtml("No proof recorded yet");
      return '<h3>Action recipe</h3><div class="action-recipe">' +
        '<dl class="recipe-grid">' +
          row("Owner", escapeHtml(recipe.owner)) +
          row("Why here", escapeHtml(recipe.why)) +
          row("Ask", escapeHtml(recipe.ask)) +
          row("Clears when", escapeHtml(recipe.clearsWhen)) +
          row("Proof", proof) +
        '</dl>' +
      '</div>';
    }

    function renderMergeStewardPacket(item, summary, verdict, action) {
      const packet = mergeStewardPacketForItem(item, summary, verdict, action);
      if (!packet) return "";
      const evidence = packet.evidence.length ? chips(packet.evidence) : escapeHtml("Hermes PASS");
      const rows = [
        row("Owner", escapeHtml(packet.owner)),
        row("Before merge", escapeHtml(packet.beforeMerge)),
        row("Button does", escapeHtml(packet.buttonDoes)),
        row("Button does not", escapeHtml(packet.buttonDoesNot)),
        row("After merge", escapeHtml(packet.afterMerge)),
        row("Evidence", evidence),
      ].join("");
      return '<section class="drawer-section merge-steward-packet"><h3>Merge steward packet</h3>' +
        '<p class="resolution-summary">' + escapeHtml(packet.summary) + '</p>' +
        '<dl class="resolution-grid">' + rows + '</dl>' +
        '<ol class="resolution-steps">' + packet.steps.map((step) => '<li>' + escapeHtml(step) + '</li>').join("") + '</ol>' +
        '<div class="resolution-actions">' +
          '<button class="soft-button" type="button" data-command-suggestion="merge steward details" title="Ask for merge context; this does not merge">Ask merge steward</button>' +
        '</div>' +
        '</section>';
    }

    function renderTestbedMissionPanel(item, summary) {
      if (!isTestbedMissionItem(item)) return "";
      const run = testbedMissionRun(item) || {};
      const mission = run.mission || {};
      const target = mission.target || {};
      const reportSchema = mission.reportSchema || {};
      const rubric = Array.isArray(mission.scoringRubric) ? mission.scoringRubric : [];
      const runbook = Array.isArray(mission.runbook) ? mission.runbook : [];
      const prompt = String(mission.missionPrompt || "");
      const reportTemplate = testbedMissionReportTemplate(run, mission);
      const result = run.result || null;
      const history = testbedMissionHistoryList(run.history);
      const rerunPrompt = testbedMissionRerunPrompt(run, mission);
      const baselinePrompt = testbedMissionBaselinePrompt(run, mission);
      const comparisonBrief = testbedMissionComparisonBrief(run);
      const fixBrief = testbedMissionFixBrief(run);
      const rows = [
        row("Target", escapeHtml(String(run.targetUrl || target.url || "[TESTBED_URL]"))),
        row("Goal", escapeHtml(String(run.goal || target.goal || "test first-contact usability"))),
        row("Agent", escapeHtml(String(run.agentName || target.agentName || "Hermes"))),
        row("Memory", escapeHtml(run.freshMemory === false ? "returning memory allowed" : "fresh or explicitly ignored")),
        row("Status", escapeHtml(String(run.status || summary.status || "ready"))),
      ].join("");
      const runbookHtml = runbook.length
        ? '<ol class="resolution-steps">' + runbook.slice(0, 8).map((step) => '<li>' + escapeHtml(String(step)) + '</li>').join("") + '</ol>'
        : '<p class="resolution-summary">Open the target in a clean browser profile, follow the visible UI, stop before mutation, and report evidence.</p>';
      const rubricHtml = rubric.length
        ? '<div class="check-matrix">' + rubric.slice(0, 8).map((entry) => {
          const id = entry && entry.id ? String(entry.id) : "rubric";
          const question = entry && entry.question ? String(entry.question) : String(entry && entry.label || "score this dimension");
          return '<div class="cm-row" data-state="pending"><span class="cm-dot"></span><span class="cm-name">' + escapeHtml(id) + '</span><span class="cm-state-pill">' + escapeHtml(question) + '</span></div>';
        }).join("") + '</div>'
        : '<div class="empty">No rubric attached.</div>';
      const resultHtml = result
        ? renderTestbedMissionReportPacket(result) +
          '<details class="drawer-disclosure prompt-disclosure"><summary>Structured result JSON</summary><pre class="prompt-box">' + escapeHtml(prettyJson(result)) + '</pre></details>'
        : '<p class="resolution-summary">No report is attached yet. The next useful thing is to run the browser mission and paste the structured report into the collaboration chat.</p>';
      return '<section class="drawer-section testbed-mission-panel"><h3>Testbed mission</h3>' +
        '<p class="resolution-summary">This starts from the monitor, but execution is browser-only: copy the prompt into a clean agent/browser run, then bring the report back here for Hermes to judge.</p>' +
        '<dl class="resolution-grid">' + rows + '</dl>' +
        '<h4>Runbook</h4>' + runbookHtml +
        '<h4>Rubric</h4>' + rubricHtml +
        resultHtml +
        renderTestbedMissionFixBrief(fixBrief) +
        (comparisonBrief ? '<h4>Comparison brief</h4><p class="resolution-summary">' + escapeHtml(comparisonBrief) + '</p>' : "") +
        (baselinePrompt ? '<details class="drawer-disclosure prompt-disclosure"><summary>Baseline for future runs</summary><pre class="prompt-box">' + escapeHtml(baselinePrompt) + '</pre></details>' : "") +
        (rerunPrompt ? '<details class="drawer-disclosure prompt-disclosure" open><summary>Rerun after fix</summary><pre class="prompt-box">' + escapeHtml(rerunPrompt) + '</pre></details>' : "") +
        (history.length ? '<h4>Mission timeline</h4><ol class="resolution-steps">' + history.map((entry) => '<li><strong>' + escapeHtml(entry.event) + '</strong> <span class="muted">' + escapeHtml(entry.at) + '</span><br>' + escapeHtml(entry.message) + '</li>').join("") + '</ol>' : "") +
        (prompt ? '<details class="drawer-disclosure prompt-disclosure"><summary>Mission prompt</summary><pre class="prompt-box">' + escapeHtml(prompt) + '</pre></details>' : "") +
        '<details class="drawer-disclosure prompt-disclosure"><summary>Report schema</summary><pre class="prompt-box">' + escapeHtml(prettyJson(reportSchema)) + '</pre></details>' +
        '<details class="drawer-disclosure prompt-disclosure"><summary>Report template</summary><pre class="prompt-box">' + escapeHtml(reportTemplate) + '</pre></details>' +
        '<div class="resolution-actions">' +
          (prompt ? '<button class="soft-button" type="button" data-copy-label="Mission prompt copied" data-copy-text="' + escapeAttr(prompt) + '">Copy mission prompt</button>' : "") +
          (baselinePrompt ? '<button class="soft-button" type="button" data-copy-label="Baseline prompt copied" data-copy-text="' + escapeAttr(baselinePrompt) + '">Copy baseline prompt</button>' : "") +
          (rerunPrompt ? '<button class="soft-button" type="button" data-copy-label="Rerun prompt copied" data-copy-text="' + escapeAttr(rerunPrompt) + '">Copy rerun prompt</button>' : "") +
          '<button class="soft-button" type="button" data-copy-label="Report schema copied" data-copy-text="' + escapeAttr(prettyJson(reportSchema)) + '">Copy report schema</button>' +
          '<button class="soft-button" type="button" data-copy-label="Report template copied" data-copy-text="' + escapeAttr(reportTemplate) + '">Copy report template</button>' +
        '</div>' +
        '</section>';
    }

    function renderTestbedMissionFixBrief(fixBrief) {
      if (!fixBrief) return "";
      const rows = [
        row("Primary blocker", escapeHtml(fixBrief.primaryBlocker)),
        row("Suspected UX gap", escapeHtml(fixBrief.suspectedUxGap)),
        row("Smallest move", escapeHtml(fixBrief.smallestProductMove)),
        row("Proof after fix", escapeHtml(fixBrief.rerunProof)),
      ].join("");
      return '<h4>Fix brief</h4>' +
        '<p class="resolution-summary">Hermes distilled the failed browser-agent report into the smallest product follow-up.</p>' +
        '<dl class="resolution-grid">' + rows + '</dl>' +
        (fixBrief.evidence.length ? '<h4>Fix evidence</h4><ol class="resolution-steps">' + fixBrief.evidence.map((entry) => '<li>' + escapeHtml(entry) + '</li>').join("") + '</ol>' : "");
    }

    function renderTestbedMissionFooterActions(item) {
      if (!isTestbedMissionItem(item)) return "";
      const run = testbedMissionRun(item) || {};
      const mission = run.mission || {};
      const prompt = String(mission.missionPrompt || "");
      const reportTemplate = testbedMissionReportTemplate(run, mission);
      const rerunPrompt = testbedMissionRerunPrompt(run, mission);
      const baselinePrompt = testbedMissionBaselinePrompt(run, mission);
      return [
        prompt ? '<button class="soft-button" type="button" data-copy-label="Mission prompt copied" data-copy-text="' + escapeAttr(prompt) + '">Copy mission prompt</button>' : "",
        baselinePrompt ? '<button class="soft-button" type="button" data-copy-label="Baseline prompt copied" data-copy-text="' + escapeAttr(baselinePrompt) + '">Copy baseline prompt</button>' : "",
        rerunPrompt ? '<button class="soft-button" type="button" data-copy-label="Rerun prompt copied" data-copy-text="' + escapeAttr(rerunPrompt) + '">Copy rerun prompt</button>' : "",
        '<button class="soft-button" type="button" data-copy-label="Report template copied" data-copy-text="' + escapeAttr(reportTemplate) + '">Copy report template</button>',
      ].filter(Boolean).join("");
    }

    function renderTestbedMissionReportPacket(result) {
      const verdict = String(result && result.verdict || "reported");
      const confidence = typeof result.confidence === "number" ? String(Math.round(result.confidence * 100)) + "%" : "not recorded";
      const stopped = result && typeof result.stoppedBeforeMutation === "boolean" ? (result.stoppedBeforeMutation ? "yes" : "no") : "not recorded";
      const rows = [
        row("Verdict", escapeHtml(verdict)),
        row("Confidence", escapeHtml(confidence)),
        row("Stopped before mutation", escapeHtml(stopped)),
      ].join("");
      const completedPath = testbedReportList(result && result.completedPath);
      const blockers = testbedReportList(result && result.blockers);
      const confusingMoments = testbedReportList(result && result.confusingMoments);
      const recommendations = testbedReportList(result && result.recommendations);
      const evidence = testbedReportEvidenceList(result && result.evidence);
      const scores = testbedReportScoreRows(result && result.scores);
      return '<section class="drawer-section testbed-report-packet"><h3>Browser-agent report</h3>' +
        '<dl class="resolution-grid">' + rows + '</dl>' +
        (completedPath.length ? '<h4>Completed path</h4><ol class="resolution-steps">' + completedPath.map((step) => '<li>' + escapeHtml(step) + '</li>').join("") + '</ol>' : "") +
        (blockers.length ? '<h4>Blockers</h4><ol class="resolution-steps">' + blockers.map((entry) => '<li>' + escapeHtml(entry) + '</li>').join("") + '</ol>' : "") +
        (confusingMoments.length ? '<h4>Confusing moments</h4><ol class="resolution-steps">' + confusingMoments.map((entry) => '<li>' + escapeHtml(entry) + '</li>').join("") + '</ol>' : "") +
        (evidence.length ? '<h4>Evidence</h4><div class="operator-evidence">' + evidence.map((entry) => '<div class="operator-evidence-item"><span class="operator-evidence-label">' + escapeHtml(entry.label) + '</span><span class="operator-evidence-value">' + escapeHtml(entry.value) + '</span></div>').join("") + '</div>' : "") +
        (scores.length ? '<h4>Scores</h4><div class="check-matrix">' + scores.map((entry) => '<div class="cm-row" data-state="' + escapeAttr(entry.state) + '"><span class="cm-dot"></span><span class="cm-name">' + escapeHtml(entry.label) + '</span><span class="cm-state-pill">' + escapeHtml(entry.value) + '</span></div>').join("") + '</div>' : "") +
        (recommendations.length ? '<h4>Recommendations</h4><ol class="resolution-steps">' + recommendations.map((entry) => '<li>' + escapeHtml(entry) + '</li>').join("") + '</ol>' : "") +
        '</section>';
    }

    function testbedReportList(value) {
      return Array.isArray(value)
        ? value.map((entry) => String(entry || "").trim()).filter(Boolean).slice(0, 8)
        : [];
    }

    function testbedReportEvidenceList(value) {
      if (!Array.isArray(value)) return [];
      return value.map((entry, index) => {
        if (entry && typeof entry === "object" && !Array.isArray(entry)) {
          const label = String(entry.type || "evidence " + String(index + 1));
          const detail = String(entry.value || entry.url || entry.path || "").trim();
          return detail ? { label, value: detail } : { label: "evidence " + String(index + 1), value: JSON.stringify(entry) };
        }
        return { label: "evidence " + String(index + 1), value: String(entry || "").trim() };
      }).filter((entry) => entry.value).slice(0, 8);
    }

    function testbedReportScoreRows(value) {
      if (!value || typeof value !== "object" || Array.isArray(value)) return [];
      return Object.entries(value).slice(0, 10).map(([label, score]) => {
        const numeric = Number(score);
        const state = Number.isFinite(numeric) && numeric >= 4 ? "pass" : Number.isFinite(numeric) && numeric <= 2 ? "fail" : "pending";
        return { label, value: String(score), state };
      });
    }

    function testbedMissionHistoryList(value) {
      if (!Array.isArray(value)) return [];
      return value.slice(-6).map((entry) => {
        const record = entry && typeof entry === "object" && !Array.isArray(entry) ? entry : {};
        return {
          at: String(record.at || "unknown time"),
          event: String(record.event || record.status || "mission update").replace(/_/g, " "),
          message: String(record.message || "Mission state changed."),
        };
      }).filter((entry) => entry.message.trim()).reverse();
    }

    function testbedMissionRerunPrompt(run, mission) {
      const result = run && run.result;
      const status = String(run && run.status || "");
      const verdict = String(result && result.verdict || "");
      const stopped = result && typeof result.stoppedBeforeMutation === "boolean" ? result.stoppedBeforeMutation : true;
      const needsRerun = result && (status === "failed" || verdict === "partial" || verdict === "fail" || stopped === false);
      if (!needsRerun) return "";
      const blockers = testbedReportList(result && result.blockers);
      const confusingMoments = testbedReportList(result && result.confusingMoments);
      const recommendations = testbedReportList(result && result.recommendations);
      const prompt = String(mission && mission.missionPrompt || "").trim();
      const primaryBlocker = blockers[0] || confusingMoments[0] || "the previous browser-agent run did not complete cleanly";
      const nl = String.fromCharCode(10);
      return [
        "Rerun testbed mission " + String(run && run.id || "unknown") + " after the product fix.",
        "",
        "Target: " + String(run && run.targetUrl || "[TESTBED_URL]"),
        "Goal: " + String(run && run.goal || "test first-contact usability"),
        "Memory mode: fresh browser agent; do not use Averray project memory or this monitor as product context.",
        "Previous verdict: " + String(verdict || status || "reported"),
        "Previous blocker to compare against: " + primaryBlocker,
        recommendations[0] ? "Expected improvement: " + recommendations[0] : "Expected improvement: the previous blocker should either disappear or become clearly different.",
        "",
        "Run the same visible-page path again. Stop before any real mutation boundary. Report whether the previous blocker is fixed, still present, or replaced by a new blocker.",
        prompt ? nl + "Original mission prompt:" + nl + prompt : "",
      ].filter(Boolean).join(nl);
    }

    function testbedMissionBaselinePrompt(run, mission) {
      const result = run && run.result;
      const status = String(run && run.status || "");
      const verdict = String(result && result.verdict || "");
      const stopped = result && typeof result.stoppedBeforeMutation === "boolean" ? result.stoppedBeforeMutation : true;
      const isBaseline = result && (status === "completed" || verdict === "pass") && stopped !== false;
      if (!isBaseline) return "";
      const completedPath = testbedReportList(result && result.completedPath);
      const evidence = testbedReportEvidenceList(result && result.evidence).map((entry) => entry.label + ": " + entry.value).slice(0, 5);
      const recommendations = testbedReportList(result && result.recommendations);
      const prompt = String(mission && mission.missionPrompt || "").trim();
      const confidence = typeof result.confidence === "number" ? String(Math.round(result.confidence * 100)) + "%" : "";
      const nl = String.fromCharCode(10);
      return [
        "Use testbed mission " + String(run && run.id || "unknown") + " as the baseline for future page checks.",
        "",
        "Target: " + String(run && run.targetUrl || "[TESTBED_URL]"),
        "Goal: " + String(run && run.goal || "test first-contact usability"),
        "Memory mode: fresh browser agent; do not use Averray project memory or previous monitor discussion as product context.",
        "Baseline verdict: " + String(verdict || status || "pass"),
        confidence ? "Baseline confidence: " + confidence : "",
        completedPath.length ? "Known-good path:" + nl + "- " + completedPath.join(nl + "- ") : "Known-good path: see the attached browser-agent report.",
        evidence.length ? "Baseline evidence:" + nl + "- " + evidence.join(nl + "- ") : "",
        recommendations[0] ? "Watch next time: " + recommendations[0] : "Watch next time: any new hesitation, missing context, or safety ambiguity compared with the known-good path.",
        "",
        "When the page changes, run this mission again and compare against the known-good path. Report whether the path still works, became clearer, or regressed.",
        prompt ? nl + "Original mission prompt:" + nl + prompt : "",
      ].filter(Boolean).join(nl);
    }

    function testbedMissionComparisonBrief(run) {
      const result = run && run.result;
      if (!result) return "";
      const status = String(run && run.status || "");
      const verdict = String(result.verdict || status || "reported");
      const completedPath = testbedReportList(result && result.completedPath);
      const blockers = testbedReportList(result && result.blockers);
      const confusingMoments = testbedReportList(result && result.confusingMoments);
      const recommendations = testbedReportList(result && result.recommendations);
      const weakScores = testbedWeakScoreLabels(result && result.scores);
      const isPass = status === "completed" || verdict === "pass";
      if (isPass) {
        const knownGood = completedPath.length
          ? 'Known-good path starts with "' + completedPath[0] + '".'
          : "Known-good path is attached in the browser-agent report.";
        return [
          "Comparison brief: treat this mission as a pass baseline.",
          knownGood,
          recommendations[0]
            ? "Next run should preserve the pass while checking this improvement: " + recommendations[0]
            : "Next run should preserve the same visible path and watch for any new hesitation or safety ambiguity.",
        ].join(" ");
      }
      const primaryBlocker = blockers[0] || confusingMoments[0] || "the fresh browser agent did not complete the mission cleanly";
      const weak = weakScores.length ? " Weak signal: " + weakScores.join(", ") + "." : "";
      return [
        'Comparison brief: verdict ' + verdict + '; next run must check whether "' + primaryBlocker + '" is gone, unchanged, or replaced.',
        recommendations[0] ? "Expected improvement: " + recommendations[0] + "." : "Expected improvement: the next safe step should be clearer to an outside agent.",
        weak,
      ].filter(Boolean).join(" ");
    }

    function testbedMissionFixBrief(run) {
      const result = run && run.result;
      const status = String(run && run.status || "");
      const verdict = String(result && result.verdict || "");
      const stopped = result && typeof result.stoppedBeforeMutation === "boolean" ? result.stoppedBeforeMutation : true;
      const needsFix = result && (status === "failed" || verdict === "partial" || verdict === "fail" || stopped === false);
      if (!needsFix) return null;
      const blockers = testbedReportList(result && result.blockers);
      const confusingMoments = testbedReportList(result && result.confusingMoments);
      const recommendations = testbedReportList(result && result.recommendations);
      const weakScores = testbedWeakScoreLabels(result && result.scores);
      const primaryBlocker = blockers[0] || confusingMoments[0] || "the fresh browser agent could not complete the mission cleanly";
      const smallestProductMove = recommendations[0] || testbedProductFixSuggestion(primaryBlocker, weakScores);
      const evidence = testbedReportEvidenceList(result && result.evidence)
        .map((entry) => entry.label + ": " + entry.value)
        .concat(blockers.map((blocker) => "blocker: " + blocker))
        .concat(confusingMoments.map((moment) => "confusing moment: " + moment))
        .concat(weakScores.map((score) => "weak score: " + score))
        .slice(0, 8);
      return {
        primaryBlocker,
        suspectedUxGap: testbedProductUxGap(primaryBlocker, weakScores),
        smallestProductMove,
        rerunProof: 'run this same testbed mission again and verify whether "' + primaryBlocker + '" is gone, unchanged, or replaced',
        evidence,
      };
    }

    function testbedWeakScoreLabels(value) {
      if (!value || typeof value !== "object" || Array.isArray(value)) return [];
      return Object.entries(value)
        .filter((entry) => Number(entry[1]) <= 3)
        .map((entry) => String(entry[0]) + ":" + String(entry[1]))
        .slice(0, 3);
    }

    function testbedProductFixSuggestion(primaryBlocker, weakScores) {
      const blocker = String(primaryBlocker || "").toLowerCase();
      const weak = Array.isArray(weakScores) ? weakScores.map((score) => String(score).toLowerCase()) : [];
      if (blocker.includes("wallet") || blocker.includes("submit") || blocker.includes("mutation")) {
        return "make the mutation boundary explicit before the agent reaches any wallet, submit, or irreversible action.";
      }
      if (blocker.includes("find") || blocker.includes("navigation") || blocker.includes("where")) {
        return "make the next action visible in the first viewport and label it with the user's goal language.";
      }
      if (weak.some((score) => score.includes("trust") || score.includes("safety"))) {
        return "add clearer trust and safety copy near the action that made the agent hesitate.";
      }
      return "remove the ambiguity the browser agent reported and make the next safe step visible without insider context.";
    }

    function testbedProductUxGap(primaryBlocker, weakScores) {
      const blocker = String(primaryBlocker || "").toLowerCase();
      const weak = Array.isArray(weakScores) ? weakScores.map((score) => String(score).toLowerCase()) : [];
      if (blocker.includes("wallet") || blocker.includes("submit") || blocker.includes("mutation")) {
        return "the page does not make the safe stopping point or irreversible action boundary obvious enough for a fresh agent.";
      }
      if (blocker.includes("find") || blocker.includes("navigation") || blocker.includes("where")) {
        return "the next action is discoverable to project insiders, but not prominent enough for an outside agent's first pass.";
      }
      if (weak.some((score) => score.includes("trust") || score.includes("safety"))) {
        return "the agent lacked enough trust or safety context near the moment it had to decide whether to continue.";
      }
      return "the page asks the agent to infer context that should be visible in the product experience.";
    }

    function testbedMissionReportTemplate(run, mission) {
      const currentRun = run || {};
      const currentMission = mission || {};
      const target = currentMission.target || {};
      const rubric = Array.isArray(currentMission.scoringRubric) ? currentMission.scoringRubric : [];
      const scores = {};
      rubric.slice(0, 12).forEach((entry) => {
        const id = entry && entry.id ? String(entry.id) : "";
        if (id) scores[id] = 0;
      });
      return JSON.stringify({
        missionId: String(currentRun.id || ""),
        verdict: "pass | partial | fail",
        confidence: 0,
        targetUrl: String(currentRun.targetUrl || target.url || "[TESTBED_URL]"),
        goal: String(currentRun.goal || target.goal || "test first-contact usability"),
        memoryMode: currentRun.freshMemory === false ? "returning_agent_memory_allowed" : "fresh_or_ignored",
        completedPath: [
          "1. Opened the target page.",
          "2. Followed the visible path without project-specific help.",
        ],
        blockers: [],
        confusingMoments: [],
        evidence: [
          { type: "observation", value: "What the agent saw or decided." },
          { type: "screenshot", value: "Screenshot path or URL, if available." },
        ],
        scores,
        recommendations: [],
        stoppedBeforeMutation: true,
      }, null, 2);
    }

    function mergeStewardPacketForItem(item, summary, verdict, action) {
      if (!item || !verdict || isDeployItem(item)) return null;
      const prState = pullRequestState(item, summary || {});
      if (isDonePullRequestState(prState)) return null;
      const lane = boardLaneForItem(item, verdict);
      const releaseReview = isReleaseReviewVerdict(verdict);
      const releaseQueued = lane.key === "queue" || action.owner === "Merge queue";
      if (!releaseReview && !releaseQueued) return null;
      const evidence = mergeStewardEvidence(summary || {}, verdict, releaseReview);
      if (releaseReview) {
        return {
          owner: "Operator, then merge steward",
          summary: "Hermes PASS is recorded, but this PR still needs the local release packet review before it can enter the release queue.",
          beforeMerge: "Operator marks release reviewed, branch protection is green, and no active Codex task is still changing the branch.",
          buttonDoes: "Opens the release review drawer so the operator can confirm the PR belongs in the queue.",
          buttonDoesNot: "It does not merge, deploy, approve GitHub checks, or change branch protection.",
          afterMerge: "Once this is reviewed and merged outside the monitor, GitHub deploy starts and Hermes should verify production before Done.",
          evidence,
          steps: [
            "Review the release packet and the Hermes evidence.",
            "Confirm this PR is intentionally ready to leave review.",
            "Mark release reviewed only if the branch can enter the merge queue.",
            "After merge, watch the Deploying lane until post-deploy verification is healthy.",
          ],
        };
      }
      return {
        owner: "Merge steward / operator",
        summary: "This PR is release-ready, not merged. The monitor is holding it in the release queue until branch protection, merge ownership, and deploy follow-up are explicit.",
        beforeMerge: "Branch protection green, Hermes PASS present, required operator sign-off complete, and no active Codex task on the branch.",
        buttonDoes: "Asks for merge context and stewardship details inside the collaboration thread.",
        buttonDoesNot: "It does not merge the PR, deploy production, mutate GitHub, or override branch protection.",
        afterMerge: "GitHub deploy workflow runs; keep watching until the monitor moves through Deploying and records post-deploy PASS.",
        evidence,
        steps: [
          "Open the PR or ask the merge steward for context.",
          "Confirm branch protection is green and there are no active or failing checks.",
          "Confirm someone owns merge timing and the post-merge deploy watch.",
          "Merge outside this monitor only when those conditions are clean.",
          "After merge, watch Deploying and do not call it done until post-deploy verification passes.",
        ],
      };
    }

    function mergeStewardEvidence(summary, verdict, releaseReview) {
      const evidence = [];
      const totals = summary && summary.githubLive && summary.githubLive.checkTotals ? summary.githubLive.checkTotals : null;
      const signals = summary && summary.reviewSignals ? summary.reviewSignals : {};
      const testSignals = Array.isArray(signals.testSignals) ? signals.testSignals.map(String).filter(Boolean) : [];
      if (verdict && verdict.label) evidence.push(verdict.label);
      if (totals && Number(totals.total) > 0) evidence.push(String(Number(totals.passed) || 0) + "/" + String(Number(totals.total) || 0) + " GitHub checks passed");
      if (testSignals.length) evidence.push(testSignals[0]);
      if (signals.rolloutNotesRequired === true) evidence.push(signals.rolloutNotesPresent === true ? "rollout notes present" : "rollout notes missing");
      if (signals.abiCompatChecked === true) evidence.push("ABI compatibility checked");
      if (releaseReview) evidence.push("operator release review required");
      return evidence.slice(0, 6);
    }

    function renderDrawerDisclosureSection(title, body) {
      return '<details class="drawer-section drawer-disclosure"><summary>' + escapeHtml(title) + '</summary>' + body + '</details>';
    }

    function renderDraftDelegationPanel(item, summary) {
      if (!isExternalDraftPullRequest(item)) return "";
      const key = escapeAttr(boardItemKey(item));
      return '<section class="drawer-section draft-delegation"><h3>Delegate takeover</h3>' +
        '<p class="resolution-summary">This draft is currently just being watched. Use this only when you want Codex to take ownership instead of waiting for the PR author or owning agent.</p>' +
        '<dl class="resolution-grid">' +
          row("Codex will", escapeHtml("inspect the branch, finish verifiable missing work, run relevant checks, and mark ready only if it is complete")) +
          row("Codex will not", escapeHtml("merge, deploy, or pretend the draft is ready without evidence")) +
          row("Clears when", escapeHtml("Codex pushes the smallest safe update or reports that ownership should stay external, then Hermes re-checks")) +
        '</dl>' +
        '<div class="resolution-actions">' +
          '<button class="soft-button" data-action="primary" type="button" data-codex-task-action="delegate-draft" data-card-key="' + key + '" title="Create and approve an explicit Codex takeover task">Delegate to Codex</button>' +
        '</div>' +
        '<details class="drawer-disclosure prompt-disclosure"><summary>Show takeover prompt</summary><pre class="prompt-box">' + escapeHtml(codexDelegationPromptForItem(item, summary || item.summary || {})) + '</pre></details>' +
        '</section>';
    }

    function renderCodexTaskPrompt(item, summary, verdict, action) {
      const prompt = codexPromptForItem(item, summary, verdict, action);
      if (!prompt) return "";
      const state = codexWorkState(item, pipelineStage(item, verdict));
      const task = state.task || codexTaskForItem(item);
      const status = normalize(task && task.status);
      const heading = status === "failed" ? "Codex retry prompt" : "Codex task prompt";
      const summaryLabel = status === "failed" ? "Show failed runner output and retry prompt" : "Show task queue and prompt";
      return '<section class="drawer-section codex-task-prompt"><h3>' + escapeHtml(heading) + '</h3>' +
        '<p class="codex-state-note">' + escapeHtml(state.detail) + '</p>' +
        '<div class="card-actions">' +
          renderCodexTaskControlButtons(item, task, prompt) +
          renderCodexFallbackCopyButton(task, prompt) +
        '</div>' +
        '<details class="drawer-disclosure prompt-disclosure"><summary>' + escapeHtml(summaryLabel) + '</summary>' +
          renderCodexQueueBox(task) +
          '<pre class="prompt-box">' + escapeHtml(prompt) + '</pre>' +
        '</details>' +
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
      if (isExternalDraftPullRequest(item)) {
        return '<button class="soft-button" data-action="primary" type="button" data-codex-task-action="delegate-draft" data-card-key="' + escapeAttr(boardItemKey(item)) + '" title="Create and approve an explicit Codex takeover task">Delegate to Codex</button>';
      }
      const prompt = codexPromptForItem(item, summary, verdict, action);
      if (!prompt) return "";
      const task = codexTaskForItem(item);
      return renderCodexTaskControlButtons(item, task, prompt);
    }

    function renderCodexTaskControlButtons(item, task, prompt) {
      const key = escapeAttr(boardItemKey(item));
      if (task && !isTerminalCodexTask(task)) {
        const status = normalize(task.status);
        if (status === "proposed") {
          return '<button class="soft-button" data-action="primary" type="button" data-codex-task-action="approve" data-card-key="' + key + '" data-codex-task-id="' + escapeAttr(task.id) + '">Approve Codex task</button>' +
            '<button class="soft-button" type="button" data-codex-task-action="cancel" data-card-key="' + key + '" data-codex-task-id="' + escapeAttr(task.id) + '">Cancel task</button>';
        }
        if (status === "approved") {
          return '<button class="soft-button" data-action="primary" type="button" data-copy-label="' + escapeAttr(codexCopyLabel()) + '" data-copy-text="' + escapeAttr(task.prompt || prompt) + '">Copy prompt fallback</button>' +
            '<button class="soft-button" type="button" data-codex-task-action="cancel" data-card-key="' + key + '" data-codex-task-id="' + escapeAttr(task.id) + '">Cancel task</button>';
        }
        return '<button class="soft-button" type="button" data-copy-label="' + escapeAttr(codexCopyLabel()) + '" data-copy-text="' + escapeAttr(task.prompt || prompt) + '">Copy Codex prompt</button>';
      }
      if (task && normalize(task.status) === "completed" && codexTaskCompletedAfterHermesReview(item)) {
        return '<button class="soft-button" data-action="primary" type="button" data-hermes-recheck="true" data-card-key="' + key + '">Ask Hermes to re-check</button>';
      }
      if (task && normalize(task.status) === "failed") {
        return '<button class="soft-button" data-action="primary" type="button" data-codex-task-action="propose" data-card-key="' + key + '" title="Creates a smaller proposed retry task; it still needs approval">Create smaller retry task</button>';
      }
      return '<button class="soft-button" data-action="primary" type="button" data-codex-task-action="propose" data-card-key="' + key + '">Propose Codex task</button>';
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
      if (isTestbedMissionItem(item)) {
        return {
          owner: "Hermes / browser agent",
          why: "A mission packet was generated to test whether an out-of-the-box agent can use the page without private Averray context.",
          ask: "Copy the mission prompt into a clean browser-capable agent, let it work only from visible UI, then paste the structured report into this room.",
          clearsWhen: "The report includes a verdict, evidence, scores, blockers, and whether the agent stopped before mutation.",
          proof: ["mission prompt", "fresh browser run", "structured report"],
        };
      }
      if (isDraftPullRequest(item)) {
        const state = codexWorkState(item, pipelineStage(item, verdict));
        if (isExternalDraftPullRequest(item)) {
          return {
            owner: "PR author",
            why: "The PR is still a draft and there is no active Codex takeover task.",
            ask: "Leave it watched while the author or owning agent finishes. If you want Codex to take over, say that explicitly in the collaboration chat.",
            clearsWhen: "GitHub reports draft=false, then CI and Hermes run on the ready PR.",
            proof: ["draft=false", "CI green", "Hermes verdict"],
          };
        }
        return {
          owner: "Codex",
          why: "The PR is still a draft and Codex has an active delegated task.",
          ask: state.state === "waiting" ? "Start or continue the delegated Codex task. Finish the draft work or mark the PR ready for review." : "Wait for Codex/CI to finish before assigning more work.",
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
        if (action.owner === "Merge queue") {
          return {
            owner: "Merge steward",
            why: "Hermes PASS is recorded, but the monitor has not merged anything.",
            ask: "Confirm branch protection, merge ownership, and deploy timing; then merge outside the monitor only when those release conditions are clean.",
            clearsWhen: "GitHub records the PR merged and post-deploy verification finishes healthy.",
            proof: ["branch protection green", "Hermes PASS", "operator sign-off if required", "post-deploy verification"],
          };
        }
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
      return '<div class="operator-checklist">' + head + rows + renderDecisionActions(item, verdict) + '</div>';
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
      if (isTestbedMissionItem(item)) {
        const run = testbedMissionRun(item) || {};
        const rows = [
          { state: "ok", label: "Mission packet", note: "prompt and rubric generated" },
          { state: run.freshMemory === false ? "warn" : "ok", label: "Memory mode", note: run.freshMemory === false ? "returning memory allowed" : "fresh or ignored" },
          { state: "ok", label: "Mutation boundary", note: "browser-only; stop before real mutation" },
          { state: run.result ? "ok" : "warn", label: "Structured report", note: run.result ? "report attached" : "waiting for browser-agent report" },
        ];
        return '<div class="precheck-list">' + rows.map((r) => (
          '<div class="pc-item">' +
            '<span class="pc-tick" data-state="' + escapeAttr(r.state) + '"></span>' +
            '<span class="pc-label">' + escapeHtml(r.label) + '</span>' +
            '<span class="pc-note">' + escapeHtml(r.note) + '</span>' +
          '</div>'
        )).join("") + '</div>';
      }
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
      if (isTestbedMissionItem(item)) {
        const run = testbedMissionRun(item) || {};
        const status = normalize(run.status || "ready");
        const rows = [
          { label: "Mission packet", state: "pass", value: "READY" },
          { label: "Fresh browser run", state: status === "ready" ? "running" : "pass", value: status === "ready" ? "WAITING" : "DONE" },
          { label: "Structured report", state: run.result ? "pass" : "pending", value: run.result ? "ATTACHED" : "WAITING" },
          { label: "Hermes judgement", state: status === "completed" ? "pass" : status === "failed" ? "fail" : "pending", value: status === "completed" ? "PASS" : status === "failed" ? "FAIL" : "PENDING" },
        ];
        return '<div class="timeline-list">' + rows.map((r) => (
          '<div class="tl-row" data-state="' + escapeAttr(r.state) + '">' +
            '<span class="tl-dot"></span>' +
            '<span class="tl-label">' + escapeHtml(r.label) + '</span>' +
            '<span class="tl-state">' + escapeHtml(r.value) + '</span>' +
          '</div>'
        )).join("") + '</div>';
      }
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
      if (isTestbedMissionItem(item)) {
        const run = testbedMissionRun(item) || {};
        return '<dl class="ref-kv">' +
          '<dt>mission</dt><dd><code>' + escapeHtml(String(run.id || item.correlationId || "unknown")) + '</code></dd>' +
          '<dt>target</dt><dd>' + escapeHtml(String(run.targetUrl || "[TESTBED_URL]")) + '</dd>' +
          '<dt>agent</dt><dd>' + escapeHtml(String(run.agentName || "Hermes")) + '</dd>' +
          '<dt>created</dt><dd>' + escapeHtml(String(run.createdAt || item.startedAt || "unknown")) + '</dd>' +
          '<dt>next action</dt><dd>' + escapeHtml(action.text) + '</dd>' +
          '</dl>';
      }
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
        // Remember whether the operator was at the bottom of the thread
        // before we re-render. If they were, snap back to bottom so
        // they always see the latest. If they had scrolled up to read
        // history, leave the scroll position alone and surface a
        // "N new ↓" affordance instead.
        const wasAtBottom = isCollabScrolledToBottom(output);
        const prevHadRows = output.querySelectorAll(".collab-message").length;
        const selected = selectedItem();
        output.innerHTML = selected ? renderSelectedCollaborationThread(selected) : renderCollaborationThread({ kind: "all" });
        const nextHadRows = output.querySelectorAll(".collab-message").length;
        if (wasAtBottom) {
          unreadScrolledCount = 0;
          scrollCollabToBottom(output);
        } else if (nextHadRows > prevHadRows) {
          unreadScrolledCount += (nextHadRows - prevHadRows);
        }
        updateCollabUnreadPill(output);
      });
    }

    // Treat "within 32px of the bottom" as bottom so a tiny scroll
    // jitter doesn't break the sticky-bottom behavior.
    function isCollabScrolledToBottom(output) {
      if (!output) return true;
      return output.scrollHeight - output.scrollTop - output.clientHeight < 32;
    }

    function scrollCollabToBottom(output) {
      if (!output) return;
      output.scrollTop = output.scrollHeight;
    }

    // Adds (or updates) a tiny "N new ↓" pill anchored to the chat
    // panel that, when clicked, scrolls to the latest message and
    // clears the unread count. Only shown when the operator has
    // scrolled up AND at least one message arrived in that state.
    function updateCollabUnreadPill(output) {
      if (!output) return;
      const parent = output.parentElement;
      if (!parent) return;
      let pill = parent.querySelector(".collab-unread-pill");
      if (unreadScrolledCount > 0 && !isCollabScrolledToBottom(output)) {
        if (!pill) {
          pill = document.createElement("button");
          pill.type = "button";
          pill.className = "collab-unread-pill";
          pill.addEventListener("click", () => {
            unreadScrolledCount = 0;
            scrollCollabToBottom(output);
            updateCollabUnreadPill(output);
          });
          parent.appendChild(pill);
        }
        pill.textContent = unreadScrolledCount + " new ↓";
      } else if (pill) {
        pill.remove();
      }
    }

    // Wire up scroll listeners on the chat outputs so the unread pill
    // hides itself when the operator scrolls back to bottom on their
    // own. Idempotent — relies on a dataset flag so we don't stack
    // listeners across re-renders.
    function ensureCollabScrollListeners() {
      [document.getElementById("command-output"), document.getElementById("ask-output")].forEach((output) => {
        if (!output) return;
        if (output.dataset.scrollWired === "true") return;
        output.dataset.scrollWired = "true";
        output.addEventListener("scroll", () => {
          if (isCollabScrolledToBottom(output)) {
            unreadScrolledCount = 0;
          }
          updateCollabUnreadPill(output);
        });
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
        if (payload.testbedMissionRun) {
          forceThreadMode();
          await load();
          selectedKey = String(payload.testbedMissionRun.id || selectedKey || "");
          renderBoard(latestPipelineItems);
          renderDrawer(selectedItem());
          renderCommandContext();
        }
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
      const lane = boardLaneForItem(item, verdict);
      const messages = [
        ...selectedConversationMemoryMessages(item),
        collabMessage("Hermes", selectedPrRoomBriefingForItem(item, verdict, action, lane), "PR room briefing · " + boardLaneLabel(lane.key), itemUpdatedMs(item)),
        collabMessage("Hermes", selectedPrRoomHandoffForItem(item, verdict, action, lane), "next turn", itemUpdatedMs(item) + 1, inferAddressedTo(action, lane)),
        collabMessage("Hermes", nextStepNarrationForItem(item, verdict, action, lane), "why it moves", itemUpdatedMs(item) + 2, inferAddressedTo(action, lane)),
      ];
      return renderCollaborationShell(cardTitleText(pipelineTitle(item), item.pullRequestNumber || pullRequestNumberFromCorrelation(item.correlationId), item), messages);
    }

    function selectedPrRoomBriefingForItem(item, verdict, action, lane) {
      const title = cardTitleText(pipelineTitle(item), item.pullRequestNumber || pullRequestNumberFromCorrelation(item.correlationId), item);
      if (isTestbedMissionItem(item)) {
        return selectedTestbedMissionBriefing(item, title);
      }
      const laneLabel = boardLaneLabel(lane && lane.key);
      const age = handoffAge(item);
      return "I am treating " + title + " as its own PR room, not just a card on the board. Right now it is in " + laneLabel + ", " + action.owner + " owns the next turn, and the latest signal is " + verdict.label + " from " + age.label.toLowerCase() + " " + age.duration + ". " +
        selectedPrRoomEvidenceForItem(item, verdict) + " " +
        selectedPrRoomBoundaryForItem(item, verdict, action, lane);
    }

    function selectedPrRoomEvidenceForItem(item, verdict) {
      const summary = item.summary || {};
      if (isTestbedMissionItem(item)) {
        return selectedTestbedMissionEvidence(item);
      }
      const signals = summary.reviewSignals || {};
      const githubLive = summary.githubLive || {};
      const totals = githubLive.checkTotals || {};
      const testSignals = Array.isArray(signals.testSignals) ? signals.testSignals.map(String).filter(Boolean) : [];
      const reviewReasons = Array.isArray(summary.reviewReasons) ? summary.reviewReasons : [];
      const codexTask = codexTaskForItem(item);
      if (isDraftPullRequest(item)) {
        return "The important evidence is GitHub's draft flag; while that is true, release checks are deliberately not the main question.";
      }
      if (codexTaskFailedForItem(item)) {
        return "The important evidence is the failed Codex runner output; I do not trust the branch state again until that output is inspected or a smaller retry exists.";
      }
      if (codexTask && !isTerminalCodexTask(codexTask)) {
        return "The important evidence is the active Codex task queue; I am waiting for that task to finish before pretending Hermes has a stable commit to review.";
      }
      if (Number(totals.total) > 0) {
        return "The important evidence I see is GitHub live checks at " + String(Number(totals.passed) || 0) + "/" + String(Number(totals.total) || 0) + " passed" + (testSignals[0] ? ", plus " + testSignals[0] : "") + ".";
      }
      if (reviewReasons.length) {
        const reason = reviewReasons[0] || {};
        const code = reason.code ? String(reason.code) : "review signal";
        const message = reason.message ? String(reason.message) : shortenVerdictWhy(verdict.why);
        return "The important evidence is " + code + ": " + message;
      }
      return "The important evidence is the Hermes verdict itself: " + shortenVerdictWhy(verdict.why || "no stronger signal is attached yet.");
    }

    function selectedPrRoomBoundaryForItem(item, verdict, action, lane) {
      if (isTestbedMissionItem(item)) return selectedTestbedMissionBoundary(item);
      if (isExternalDraftPullRequest(item)) return "I will keep it watched and quiet unless Pascal explicitly delegates a Codex takeover.";
      if (isDraftPullRequest(item)) return "I will hold it out of release until the draft is finished or marked ready, then CI and Hermes can take a real pass.";
      if (codexTaskFailedForItem(item)) return "I will not ask Hermes to bless this again until Codex has dealt with the failed task or proposed a clean retry.";
      if (action.owner === "Operator" || (lane && lane.key) === "operator") return "I need Pascal's judgement here; automation can prepare evidence, but it should not decide project intent or rollout risk.";
      if (action.owner === "Codex" || (lane && lane.key) === "codex" || verdict.level === "block") return "I will keep it visible until Codex changes the branch or creates a smaller retry and Hermes sees the blocking signal disappear.";
      if (action.owner === "Merge queue" || (lane && lane.key) === "queue") return "I will not call it done from the queue; it still needs merge ownership, a real GitHub merge, and then post-deploy verification.";
      if (action.owner === "Hermes" || (lane && lane.key) === "hermes") return "I am waiting for read-only evidence to settle before assigning anybody else work.";
      if ((lane && lane.key) === "deploy") return "I will watch production health before turning this into release history.";
      return "I will update this room when the owner, verdict, or lane changes.";
    }

    function selectedPrRoomHandoffForItem(item, verdict, action, lane) {
      const title = cardTitleText(pipelineTitle(item), item.pullRequestNumber || pullRequestNumberFromCorrelation(item.correlationId), item);
      if (isTestbedMissionItem(item)) {
        return selectedTestbedMissionHandoff(item, title);
      }
      if (isExternalDraftPullRequest(item)) {
        return "Pascal, " + title + " is an external draft. I am watching it, but I will not quietly convert it into Codex work unless you explicitly hand it over.";
      }
      if (isDraftPullRequest(item)) {
        return "Codex, " + title + " is still draft work. Finish the draft or mark it ready only when the branch is actually ready for CI and Hermes.";
      }
      if (codexTaskFailedForItem(item)) {
        return "Codex, for " + title + ", start with the runner output instead of guessing. Tell us whether this is runner/auth setup, a real PR failure, or a task that needs to be split smaller.";
      }
      if (action.owner === "Operator" || (lane && lane.key) === "operator") {
        return "Pascal, your next turn is not a rubber stamp on " + title + ". Read the evidence, decide whether the risk is intentional, then approve locally or send it back with a precise ask.";
      }
      if (action.owner === "Codex" || (lane && lane.key) === "codex" || verdict.level === "block") {
        return "Codex, your next turn on " + title + " is the smallest branch update that removes the named blocker, followed by CI and a Hermes re-check.";
      }
      if (action.owner === "Merge queue" || (lane && lane.key) === "queue") {
        return "Merge steward, " + title + " is not done yet. Confirm branch protection, merge timing, and who watches the deploy before this leaves the queue.";
      }
      if (action.owner === "Hermes" || (lane && lane.key) === "hermes") {
        return "Hermes, keep " + title + " in read-only review until the moving checks stop moving; then post the verdict back into this room.";
      }
      if ((lane && lane.key) === "deploy") {
        return "Hermes, " + title + " is in production verification. Watch hosted health and the post-deploy suite before calling it done.";
      }
      return action.owner + ", your next turn on " + title + " is: " + action.text + ".";
    }

    function selectedTestbedMissionBriefing(item, title) {
      const run = testbedMissionRun(item) || {};
      const status = normalize(run.status || (item.summary || {}).status || item.status);
      const target = String(run.targetUrl || "[TESTBED_URL]");
      const goal = String(run.goal || "test first-contact usability");
      const statusLine = status === "completed"
        ? "It has a passing report, so I am treating it as baseline evidence rather than active work."
        : status === "failed"
          ? "It has a failed or partial browser-agent report, so the useful question is what small page fix or rerun proves the blocker changed."
          : "It is waiting for a clean browser-only report from a fresh agent.";
      return "I am treating " + title + " as a testbed mission room, not a PR room. Target: " + target + ". Goal: " + goal + ". " + statusLine;
    }

    function selectedTestbedMissionEvidence(item) {
      const run = testbedMissionRun(item) || {};
      const result = run.result || null;
      if (!result) {
        return "The important evidence is still missing: a fresh browser-agent report with verdict, scores, blockers, and screenshots or trace references.";
      }
      const verdict = String(result.verdict || run.status || "reported");
      const blockers = testbedReportList(result.blockers);
      const completedPath = testbedReportList(result.completedPath);
      const recommendations = testbedReportList(result.recommendations);
      if (normalize(run.status) === "completed") {
        return "The important evidence is the passing browser-agent report: verdict " + verdict + ". " +
          (completedPath[0] ? "Known-good path starts with: " + completedPath[0] + ". " : "") +
          (recommendations[0] ? "Next time I will watch this improvement: " + recommendations[0] + "." : "This is the baseline to compare future page changes against.");
      }
      return "The important evidence is the failed browser-agent report: verdict " + verdict + ". " +
        (blockers[0] ? "Primary blocker: " + blockers[0] + ". " : "") +
        (recommendations[0] ? "Suggested next product move: " + recommendations[0] + "." : "Use the rerun prompt to see whether the blocker disappears, stays, or changes.");
    }

    function selectedTestbedMissionBoundary(item) {
      const run = testbedMissionRun(item) || {};
      const status = normalize(run.status || (item.summary || {}).status || item.status);
      if (status === "completed") return "I will keep the mission as release-adjacent evidence, not a merge gate; it becomes useful again when a future page change needs comparison against this baseline.";
      if (status === "failed") return "I will keep this visible until the report turns into either one bounded product fix or a rerun that proves the blocker changed; this is product evidence, not a GitHub merge signal.";
      return "I will keep this in Hermes Checking until the browser mission report arrives; this is product/testbed evidence, not a GitHub merge signal.";
    }

    function selectedTestbedMissionHandoff(item, title) {
      const run = testbedMissionRun(item) || {};
      const status = normalize(run.status || (item.summary || {}).status || item.status);
      if (status === "completed") {
        return "Hermes, keep " + title + " as the known-good outside-agent path. When the page changes, ask for a fresh run and compare it against this baseline before trusting the new experience.";
      }
      if (status === "failed") {
        const brief = testbedMissionComparisonBrief(run);
        return "Hermes, turn " + title + " into a concrete follow-up: " + (brief || "compare the next run against the blocker in the failed report.") + " If the fix is not obvious, ask Codex for one small product change instead of a broad redesign.";
      }
      return "Hermes, run " + title + " like a normal outside agent: browser-visible UI only, no repo memory, no private MCP, and stop before real mutation. Bring back the structured report so Pascal can see what a future agent actually experiences.";
    }

    function renderCollaborationThread(options) {
      const kind = options && options.kind ? options.kind : "all";
      const messages = buildCollaborationMessages(kind);
      const title = kind === "codex" ? "Codex handoff"
        : kind === "hermes" ? "Hermes review"
          : kind === "operator" ? "Operator asks"
            : kind === "blocked" ? "Needs attention"
            : kind === "now" ? "What is happening now"
              : "Collaboration";
      return renderCollaborationShell(title, messages, { showNowPanel: true });
    }

    function renderCollaborationShell(title, messages, options) {
      const rows = (messages && messages.length ? messages : [
        collabMessage("System", "No active handoff right now. Codex and Hermes will speak up here when there's work to coordinate.", "idle", Date.now()),
      ])
        .sort((a, b) => a.ts - b.ts)
        .slice(-18);
      const lastIndex = rows.length - 1;
      const typingRow = hermesTypingSinceMs ? renderHermesTypingRow() : "";
      const nowPanel = options && options.showNowPanel ? renderCollabNowPanel() : "";
      // Compute which rows are "fresh" (their id wasn't in the previous
      // render). On the very first render every row is fresh — which
      // would produce a flood of slide-ins; skip that case.
      const previouslyKnown = knownCollabMessageIds;
      const firstRender = previouslyKnown.size === 0;
      const nextKnown = new Set();
      const html = '<div class="collab-thread">' +
        '<div class="collab-head">' +
          '<strong>' + escapeHtml(title) + '</strong>' +
          '<span class="collab-head-meta">' +
            '<span>' + escapeHtml(currentStreamLabel()) + '</span>' +
            '<button id="collab-sound-toggle" class="collab-sound-toggle" type="button" ' +
              'aria-pressed="' + (collabSoundEnabled ? "true" : "false") + '" ' +
              'title="' + (collabSoundEnabled ? "Mute @operator chime" : "Unmute @operator chime") + '">' +
              (collabSoundEnabled ? "🔊" : "🔇") +
            '</button>' +
          '</span>' +
        '</div>' +
        nowPanel +
        rows.map((m, i) => {
          const key = collabRowKey(m);
          nextKnown.add(key);
          const isFresh = !firstRender && !previouslyKnown.has(key);
          return renderCollabMessage(m, {
            prev: i > 0 ? rows[i - 1] : null,
            isNewest: i === lastIndex,
            isFresh,
          });
        }).join("") +
        typingRow +
        renderCollabPresenceFooter() +
        '</div>';
      knownCollabMessageIds = nextKnown;
      return html;
    }

    function renderCollabNowPanel() {
      const snapshot = boardNowSnapshot(latestPipelineItems || []);
      return '<div class="collab-now" data-tone="' + escapeAttr(snapshot.tone) + '">' +
        '<span class="collab-now-kicker">Current read</span>' +
        '<div class="collab-now-title">' + escapeHtml(snapshot.headline) + '</div>' +
        '<div class="collab-now-next">' + escapeHtml(snapshot.next) + '</div>' +
        '<div class="collab-now-counts">' + boardNowCountsMarkup(snapshot.counts) + '</div>' +
      '</div>';
    }

    // Presence footer rendered at the bottom of the collaboration thread.
    // One small status row per agent (Codex / Hermes / Operator) so the
    // operator can tell at a glance who's busy on what, vs who's idle.
    // Derived from the existing client-side state — no new backend calls.
    function renderCollabPresenceFooter() {
      const codex = describeCodexPresence();
      const hermes = describeHermesPresence();
      const operator = describeOperatorPresence();
      const part = (slug, who, status) =>
        '<span class="collab-presence-agent" data-agent="' + escapeAttr(slug) + '" data-active="' + (status.active ? "true" : "false") + '">' +
          '<span class="collab-presence-dot"></span>' +
          '<span class="collab-presence-name">' + escapeHtml(who) + '</span>' +
          '<span class="collab-presence-status">' + escapeHtml(status.text) + '</span>' +
        '</span>';
      return '<div class="collab-presence" aria-label="Agent presence">' +
        part("codex", "Codex", codex) +
        part("hermes", "Hermes", hermes) +
        part("operator", "Operator", operator) +
      '</div>';
    }

    function describeCodexPresence() {
      // Prefer a real active codex task — it's a concrete, ground-truth
      // signal that Codex is doing something right now.
      const liveTask = (latestCodexTasks || [])
        .filter((task) => {
          const s = normalize(task && task.status);
          return s === "running" || s === "approved";
        })
        .sort((a, b) => taskUpdatedMs(b) - taskUpdatedMs(a))[0];
      if (liveTask) {
        const status = normalize(liveTask.status);
        const title = codexTaskTitle(liveTask);
        if (status === "running") return { active: true, text: "working on " + title };
        if (status === "approved") return { active: true, text: "claiming " + title };
      }
      const codexCard = (latestPipelineItems || []).find((it) => {
        const v = releaseVerdict(it);
        return boardLaneForItem(it, v).key === "codex";
      });
      if (codexCard) {
        const ref = collabPresenceItemRef(codexCard);
        return { active: true, text: "needed on " + ref };
      }
      return { active: false, text: "idle" };
    }

    function describeHermesPresence() {
      const hermesCard = (latestPipelineItems || []).find((it) => {
        const v = releaseVerdict(it);
        return boardLaneForItem(it, v).key === "hermes";
      });
      if (hermesCard) {
        const ref = collabPresenceItemRef(hermesCard);
        return { active: true, text: "watching " + ref };
      }
      const deployCard = (latestPipelineItems || []).find((it) => isDeployItem(it) && (it.active === true || it.activeState === "running" || normalize(it.status) === "running"));
      if (deployCard) {
        const ref = collabPresenceItemRef(deployCard);
        return { active: true, text: "verifying deploy on " + ref };
      }
      return { active: false, text: "idle" };
    }

    function describeOperatorPresence() {
      const sel = selectedItem();
      if (sel) {
        const ref = collabPresenceItemRef(sel);
        return { active: true, text: "viewing " + ref };
      }
      const operatorCard = (latestPipelineItems || []).find((it) => {
        const v = releaseVerdict(it);
        const lane = boardLaneForItem(it, v);
        return lane.key === "operator" || lane.key === "attention";
      });
      if (operatorCard) {
        const ref = collabPresenceItemRef(operatorCard);
        return { active: true, text: "decision needed on " + ref };
      }
      return { active: false, text: "idle" };
    }

    function collabPresenceItemRef(item) {
      if (!item) return "the board";
      const pr = item.pullRequestNumber || pullRequestNumberFromCorrelation(item.correlationId);
      const repo = String(item.repo || "averray-agent/agent");
      const repoShort = repo.split("/")[1] || repo;
      return pr ? repoShort + "#" + pr : repoShort;
    }

    // Stable identity for fresh-detection. Posted messages have a real
    // server-generated id; synthesized messages don't, so we fall back
    // to a composite of speaker+text+ts. Same logical message ⇒ same key
    // across re-renders ⇒ no spurious slide-in animation.
    function collabRowKey(m) {
      if (!m) return "";
      if (m.id) return String(m.id);
      return (m.speaker || "") + "·" + (m.text || "") + "·" + (m.ts || 0);
    }

    // Transient "Hermes is typing…" row rendered at the bottom of the
    // thread while a Hermes auto-reply is in flight. Uses the same
    // .collab-message layout as a real row so the typography matches,
    // with three animated dots in place of the message text.
    function renderHermesTypingRow() {
      return '<article class="collab-message" data-speaker="hermes" data-typing="true" aria-live="polite">' +
        '<div class="collab-byline">' +
          '<span class="collab-speaker">Hermes</span>' +
          '<span class="collab-typing-label">is typing</span>' +
        '</div>' +
        '<div class="collab-text">' +
          '<span class="typing-dots" aria-hidden="true"><span></span><span></span><span></span></span>' +
        '</div>' +
      '</article>';
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
      // "Fresh" = this id wasn't in the previous render's id set. JS
      // populates the set after each render so the slide-in animation
      // only plays once per message, not on every re-render.
      const isFresh = ctx.isFresh === true;
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
      // Long synthesized messages were a wall of text in the live
      // thread. Compute a short summary (first ~2 sentences, capped
      // at 180 chars) and a "more" affordance — clicking expands the
      // row to show the full text. expandedCollabRowKeys persists the
      // expanded state per-session, keyed by the same composite key
      // collabRowKey() uses for fresh-detection.
      const rowKey = collabRowKey(message);
      const text = String(message.text || "");
      const summary = collapsedCollabSummary(text);
      const isOverflow = summary !== text;
      const expanded = isOverflow && expandedCollabRowKeys.has(rowKey);
      const overflowAttr = isOverflow ? ' data-overflow="true"' : "";
      const expandedAttr = expanded ? ' data-expanded="true"' : "";
      const renderText = !isOverflow || expanded ? text : summary;
      const moreButton = isOverflow
        ? '<button type="button" class="collab-more" data-collab-more="' + escapeAttr(rowKey) + '" aria-expanded="' + (expanded ? "true" : "false") + '">' + (expanded ? "less ↑" : "more ↓") + '</button>'
        : "";
      return '<article class="collab-message"' +
        ' data-speaker="' + escapeAttr(slug) + '"' +
        ' data-posted="' + posted + '"' +
        ' data-kind="' + escapeAttr(kindAttr) + '"' +
        ' data-addressed="' + escapeAttr(addressedAttr) + '"' +
        ' data-grouped="' + (grouped ? "true" : "false") + '"' +
        (isNewest ? ' data-newest="true"' : "") +
        (isFresh ? ' data-fresh="true"' : "") +
        overflowAttr +
        expandedAttr +
        '>' +
        byline +
        '<div class="collab-text">' + escapeHtml(renderText) + moreButton + '</div>' +
      '</article>';
    }

    // Synthesized board-state messages can run 4-6 sentences explaining
    // the whole workflow. That made the thread feel like a wall of text
    // on a busy board. Show only the first 1-2 sentences (max ~180
    // chars) by default; the operator can expand inline if they need
    // the full explanation.
    //
    // The cap constants are INSIDE the function body (not module-level
    // const) on purpose. The script body calls setComposeMode() at
    // boot, which transitively reaches this function — module-level
    // const declarations below that call hit a TDZ ReferenceError
    // because they haven't been evaluated yet. Function declarations
    // are hoisted but const isn't.
    function collapsedCollabSummary(text) {
      const MAX_CHARS = 180;
      const MAX_SENTENCES = 2;
      const trimmed = String(text || "").trim();
      if (!trimmed) return trimmed;
      if (trimmed.length <= MAX_CHARS) return trimmed;
      // Sentence boundary = period/exclaim/question followed by space
      // (so URLs and "1 changed file(s)" parens don't trip the split).
      const sentences = trimmed.split(/(?<=[.!?])\s+/);
      let out = "";
      for (let i = 0; i < Math.min(sentences.length, MAX_SENTENCES); i += 1) {
        const next = (out ? out + " " : "") + sentences[i];
        if (next.length > MAX_CHARS) {
          if (!out) {
            // First sentence is already too long — hard-cap on chars.
            out = next.slice(0, MAX_CHARS).trimEnd() + "…";
          }
          break;
        }
        out = next;
      }
      if (!out) out = trimmed.slice(0, MAX_CHARS).trimEnd() + "…";
      // If we cut before the end, add ellipsis so the trim is obvious.
      if (out.length < trimmed.length && !out.endsWith("…")) out += " …";
      return out;
    }

    function collabMessage(speaker, text, meta, ts, addressedTo) {
      const row = { speaker, text, meta: meta || "", ts: Number.isFinite(ts) ? ts : Date.now() };
      if (addressedTo) row.addressedTo = addressedTo;
      return row;
    }

    // Infer the conversational target of a synthesized Hermes line by
    // looking at the action owner and lane. This pushes the chat from
    // monologue ("Codex: PR #439 — finish the draft…") into dialogue
    // ("Hermes → @codex: PR #439 — finish the draft…"), so the eye
    // reads it as one agent talking to another.
    function inferAddressedTo(action, lane) {
      const owner = action && action.owner ? String(action.owner) : "";
      const laneKey = lane && lane.key ? String(lane.key) : "";
      if (owner === "Codex" || laneKey === "codex") return "codex";
      if (owner === "Operator" || laneKey === "operator" || laneKey === "attention") return "operator";
      if (owner === "Hermes" || laneKey === "hermes") return "hermes";
      return "";
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

    function selectedConversationMemoryMessages(item) {
      if (!item) return [];
      const posted = latestCollabMessages
        .filter((message) => collabMessageMatchesItem(message, item))
        .map(postedToCollabRow);
      const narrations = latestBoardNarrations
        .filter((message) => boardNarrationMatchesItem(message, item));
      const tasks = codexTasksForItem(item)
        .sort((a, b) => taskUpdatedMs(a) - taskUpdatedMs(b))
        .slice(-5)
        .flatMap((task) => collaborationMessagesForTask(task));
      const memory = posted.concat(narrations, tasks)
        .sort((a, b) => a.ts - b.ts)
        .slice(-14);
      if (memory.length) return memory;
      return [
        collabMessage("Hermes", "This PR room is quiet so far. I will keep the next Codex, Hermes, and operator turns here once they attach to this PR.", "conversation memory", itemUpdatedMs(item) - 2),
      ];
    }

    function collabMessageMatchesItem(message, item) {
      if (!message || !item) return false;
      const identity = itemConversationIdentity(item);
      const related = message.relatedPr || {};
      if (related.repo && related.number && String(related.repo) === identity.repo && Number(related.number) === identity.pr) return true;
      if (message.relatedCorrelationId && identity.correlations.has(String(message.relatedCorrelationId))) return true;
      return false;
    }

    function boardNarrationMatchesItem(message, item) {
      if (!message || !item) return false;
      const identity = itemConversationIdentity(item);
      if (message.relatedBoardKey && String(message.relatedBoardKey) === identity.boardKey) return true;
      const related = message.relatedPr || {};
      if (related.repo && related.number && String(related.repo) === identity.repo && Number(related.number) === identity.pr) return true;
      if (message.relatedCorrelationId && identity.correlations.has(String(message.relatedCorrelationId))) return true;
      return false;
    }

    function itemConversationIdentity(item) {
      const repo = String(item && item.repo || "averray-agent/agent");
      const pr = Number(item && (item.pullRequestNumber || pullRequestNumberFromCorrelation(item.correlationId)));
      return {
        repo,
        pr,
        boardKey: item ? boardItemKey(item) : "",
        correlations: itemCorrelationIds(item),
      };
    }

    function itemCorrelationIds(item) {
      const ids = new Set();
      if (!item) return ids;
      if (item.correlationId) ids.add(String(item.correlationId));
      if (Array.isArray(item.groupItems)) {
        item.groupItems.forEach((entry) => {
          if (entry && entry.correlationId) ids.add(String(entry.correlationId));
        });
      }
      return ids;
    }

    function buildCollaborationMessages(kind) {
      const messages = [];
      // Real posted messages take precedence visually — they are the
      // human/agent voice on the channel and shouldn't be drowned by
      // synthesized status lines.
      latestCollabMessages
        .filter((m) => postedMessageMatchesKind(m, kind))
        .forEach((m) => messages.push(postedToCollabRow(m)));
      latestBoardNarrations
        .filter((m) => boardNarrationMatchesKind(m, kind))
        .forEach((m) => messages.push(m));
      // The board briefing emits a header + N per-item lines. Capture
      // which items it covered so the per-item ask loop below doesn't
      // echo the same content for those same items.
      const briefing = buildBoardBriefingMessages(kind);
      messages.push(...briefing.messages);
      const briefingCoveredKeys = new Set(briefing.items.map(boardItemKey));
      latestCodexTasks
        .filter((task) => !isTerminalCodexTask(task))
        .sort((a, b) => taskUpdatedMs(b) - taskUpdatedMs(a))
        .slice(0, 8)
        .forEach((task) => messages.push(...collaborationMessagesForTask(task)));
      (latestPipelineItems || []).forEach((item) => {
        const verdict = releaseVerdict(item);
        const lane = boardLaneForItem(item, verdict);
        if (lane.key === "done") return;
        // Skip items the briefing already covered — otherwise the thread
        // shows two near-identical synthesized lines per PR.
        if (briefingCoveredKeys.has(boardItemKey(item))) return;
        const action = nextPipelineAction(item, verdict);
        if (kind === "codex" && action.owner !== "Codex" && lane.key !== "codex") return;
        if (kind === "hermes" && action.owner !== "Hermes" && lane.key !== "hermes") return;
        if (kind === "operator" && action.owner !== "Operator" && lane.key !== "operator") return;
        if (kind === "blocked" && lane.key !== "attention" && verdict.level !== "block") return;
        messages.push(collabMessage("Hermes", collaborationAskForItem(item, verdict, action, lane), collaborationMetaForItem(item, verdict), itemUpdatedMs(item), inferAddressedTo(action, lane)));
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

    // Returns { messages, items } so the caller can dedupe — items
    // here are the pipeline items the briefing already mentioned by
    // name, and the per-item ask loop should skip those keys to avoid
    // echoing the same status twice.
    function buildBoardBriefingMessages(kind) {
      if (!["all", "now", "blocked"].includes(kind || "all")) return { messages: [], items: [] };
      const items = topConsoleItems(boardBriefingItems(kind), 4);
      if (!items.length) return { messages: [], items: [] };
      const baseTs = newestBoardItemUpdateMs(items);
      const messages = [
        collabMessage("Hermes", boardBriefingSummary(items), "board briefing", baseTs),
      ];
      items.forEach((item, index) => {
        const verdict = releaseVerdict(item);
        const lane = boardLaneForItem(item, verdict);
        const action = nextPipelineAction(item, verdict);
        messages.push(collabMessage("Hermes", boardBriefingLineForItem(item, verdict, action, lane), boardBriefingMeta(item, verdict, lane), baseTs + index + 1, inferAddressedTo(action, lane)));
      });
      return { messages, items };
    }

    function boardBriefingItems(kind) {
      return (latestPipelineItems || []).filter((item) => {
        if (!item) return false;
        const verdict = releaseVerdict(item);
        const lane = boardLaneForItem(item, verdict);
        if (lane.key === "done") return false;
        if (kind === "blocked") return lane.key === "attention" || verdict.level === "block";
        return true;
      });
    }

    function newestBoardItemUpdateMs(items) {
      const latest = items.reduce((max, item) => {
        const value = itemUpdatedMs(item);
        return Number.isFinite(value) ? Math.max(max, value) : max;
      }, 0);
      return latest || Date.now();
    }

    function boardBriefingSummary(items) {
      const counts = items.reduce((acc, item) => {
        const verdict = releaseVerdict(item);
        const lane = boardLaneForItem(item, verdict);
        const action = nextPipelineAction(item, verdict);
        acc.total += 1;
        if (lane.key === "attention" || verdict.level === "block") acc.attention += 1;
        if (lane.key === "waiting") acc.waiting += 1;
        if (action.owner === "Codex") acc.codex += 1;
        if (action.owner === "Operator") acc.operator += 1;
        if (action.owner === "Hermes") acc.hermes += 1;
        if (action.owner === "Merge queue" || lane.key === "queue") acc.queue += 1;
        if (isTestbedMissionItem(item)) {
          const mission = testbedMissionRun(item) || {};
          const missionStatus = normalize(mission.status || (item.summary || {}).status || item.status);
          acc.testbed += 1;
          if (missionStatus === "failed") acc.testbedFailed += 1;
          else if (missionStatus === "completed") acc.testbedBaseline += 1;
          else acc.testbedWaiting += 1;
        }
        return acc;
      }, { total: 0, attention: 0, waiting: 0, codex: 0, operator: 0, hermes: 0, queue: 0, testbed: 0, testbedWaiting: 0, testbedFailed: 0, testbedBaseline: 0 });
      const parts = [];
      if (counts.attention) parts.push(plural(counts.attention, "item") + (counts.attention === 1 ? " needs attention" : " need attention"));
      if (counts.waiting) parts.push(plural(counts.waiting, "draft") + (counts.waiting === 1 ? " is being watched" : " are being watched"));
      if (counts.codex) parts.push("Codex owns " + counts.codex);
      if (counts.operator) parts.push("operator owns " + counts.operator);
      if (counts.hermes) parts.push("Hermes is checking " + counts.hermes);
      if (counts.queue) parts.push(counts.queue + " waiting in the merge queue");
      if (counts.testbed) parts.push(testbedMissionBoardDigest(counts));
      const headline = parts.length ? parts.join("; ") + "." : plural(counts.total, "item") + (counts.total === 1 ? " is" : " are") + " on the board.";
      const operatorNote = counts.operator
        ? "Pascal, I will call out the decision points instead of making them look like normal queue work."
        : counts.testbedWaiting
          ? "Pascal, I am treating testbed missions as evidence work, not PR blockers; the useful move is getting a clean outside-agent report."
        : counts.waiting && !counts.codex
          ? "Pascal, I am watching drafts without pretending Codex owns them; I will only ask Codex to take over if you explicitly say so."
        : "Pascal, nothing here needs your decision right this second; I am mostly keeping Codex pointed at the next handoff.";
      return "Here is the live shape of the board: " + headline + " " + operatorNote + " " + boardBriefingNextMove(items) + " I will narrate the next useful move here as the cards change, so the board is not just a wall of badges.";
    }

    function testbedMissionBoardDigest(counts) {
      const bits = [];
      if (counts.testbedWaiting) bits.push(plural(counts.testbedWaiting, "testbed mission") + " waiting for a browser-agent report");
      if (counts.testbedFailed) bits.push(plural(counts.testbedFailed, "testbed mission") + " needing a rerun or product fix");
      if (counts.testbedBaseline) bits.push(plural(counts.testbedBaseline, "testbed baseline") + " recorded");
      return bits.join(", ");
    }

    function plural(count, noun) {
      return count + " " + noun + (count === 1 ? "" : "s");
    }

    function boardBriefingNextMove(items) {
      const lead = (items || [])[0];
      if (!lead) return "The room is quiet; I will speak up when a card needs an owner.";
      const verdict = releaseVerdict(lead);
      const lane = boardLaneForItem(lead, verdict);
      const action = nextPipelineAction(lead, verdict);
      const title = cardTitleText(pipelineTitle(lead), lead.pullRequestNumber || pullRequestNumberFromCorrelation(lead.correlationId), lead);
      if (isTestbedMissionItem(lead)) {
        return testbedMissionNextMove(lead, title);
      }
      if (isDraftPullRequest(lead)) {
        if (isExternalDraftPullRequest(lead)) {
          return "First useful move: leave " + title + " watched while the PR author or owning agent finishes it; Codex should only take over if Pascal explicitly delegates that.";
        }
        return "First useful move: Codex should finish the delegated draft work for " + title + ", mark it ready, and let CI plus Hermes re-check it.";
      }
      if (codexTaskFailedForItem(lead)) {
        return "First useful move: Codex should open the failed runner output for " + title + ", then either fix the runner/auth setup or split the work into a smaller retry.";
      }
      if (action.owner === "Operator" || lane.key === "operator") {
        return "First useful move: Pascal should review " + title + " as a release decision, not as busywork; approve it only if the risk and intent are clear.";
      }
      if (action.owner === "Codex" || lane.key === "codex" || lane.key === "attention") {
        return "First useful move: Codex should take " + title + " and make the smallest change that clears the named blocker.";
      }
      if (action.owner === "Merge queue" || lane.key === "queue") {
        return "First useful move: keep " + title + " queued until branch protection is green and merge ownership is explicit.";
      }
      if (action.owner === "Hermes" || lane.key === "hermes") {
        return "First useful move: Hermes should finish the read-only check on " + title + " and publish the verdict here.";
      }
      return "First useful move: " + action.owner + " should " + action.text + " for " + title + ".";
    }

    function testbedMissionNextMove(item, title) {
      const mission = testbedMissionRun(item) || {};
      const missionStatus = normalize(mission.status || (item.summary || {}).status || item.status);
      if (missionStatus === "completed") {
        return "First useful move: keep " + title + " as a baseline, and compare the next page change against its known-good browser-agent path.";
      }
      if (missionStatus === "failed") {
        return "First useful move: turn the failed browser-agent report for " + title + " into one small product fix or a rerun prompt, then compare whether the blocker disappeared.";
      }
      return "First useful move: run " + title + " with a clean browser-capable agent, stop before mutation, and paste the structured report back so Hermes can judge evidence instead of vibes.";
    }

    function captureBoardNarrations(items) {
      const next = new Map();
      let added = 0;
      (items || []).forEach((item) => {
        if (!item) return;
        const verdict = releaseVerdict(item);
        const lane = boardLaneForItem(item, verdict);
        if (lane.key === "done") return;
        const action = nextPipelineAction(item, verdict);
        const key = boardItemKey(item);
        const signature = boardNarrationSignature(item, verdict, action, lane);
        next.set(key, { signature, laneKey: lane.key, verdictLevel: verdict.level, owner: action.owner });
        if (!hasBoardNarrationSnapshot) return;
        const previous = previousBoardNarrationState.get(key);
        if (previous && previous.signature === signature) return;
        if (!previous && !shouldNarrateNewBoardItem(item, verdict, action, lane)) return;
        addBoardNarration(boardNarrationForChange(item, verdict, action, lane, previous), boardNarrationMeta(item, verdict, lane), itemUpdatedMs(item) || Date.now(), inferAddressedTo(action, lane), item);
        added += 1;
      });
      previousBoardNarrationState = next;
      hasBoardNarrationSnapshot = true;
      return added;
    }

    function boardNarrationSignature(item, verdict, action, lane) {
      return [
        lane && lane.key,
        verdict && verdict.level,
        action && action.owner,
        action && action.text,
        normalize(item && item.status),
        normalize(item && item.activeState),
        isDraftPullRequest(item) ? "draft" : "",
        codexTaskFailedForItem(item) ? "codex-failed" : "",
        testbedMissionSignature(item),
      ].join("|");
    }

    function shouldNarrateNewBoardItem(item, verdict, action, lane) {
      if (isTestbedMissionItem(item)) return true;
      if (codexTaskFailedForItem(item) || isDraftPullRequest(item)) return true;
      return lane.key === "attention" || lane.key === "operator" || lane.key === "codex" || verdict.level === "block" || verdict.level === "needs-review";
    }

    function testbedMissionSignature(item) {
      if (!isTestbedMissionItem(item)) return "";
      const mission = testbedMissionRun(item) || {};
      const result = mission.result || {};
      return [
        "testbed",
        normalize(mission.status || (item.summary || {}).status || item.status),
        normalize(mission.statusReason || item.reason),
        normalize(result.verdict),
        String(result.stoppedBeforeMutation === false),
      ].join(":");
    }

    function addBoardNarration(text, meta, ts, addressedTo, item) {
      const message = collabMessage("Hermes", text, meta, ts || Date.now(), addressedTo);
      message.id = "board-narration-" + String(ts || Date.now()) + "-" + String(latestBoardNarrations.length + 1);
      message.kind = "status";
      if (item) {
        const identity = itemConversationIdentity(item);
        message.relatedBoardKey = identity.boardKey;
        if (identity.repo && Number.isFinite(identity.pr) && identity.pr > 0) {
          message.relatedPr = { repo: identity.repo, number: identity.pr };
        }
        if (item.correlationId) message.relatedCorrelationId = String(item.correlationId);
      }
      latestBoardNarrations.push(message);
      latestBoardNarrations = latestBoardNarrations.slice(-BOARD_NARRATION_LIMIT);
    }

    function boardNarrationMatchesKind(message, kind) {
      if (!kind || kind === "all" || kind === "now") return true;
      if (kind === "blocked") return String(message.meta || "").toLowerCase().includes("needs attention") || String(message.text || "").toLowerCase().includes("blocked");
      if (kind === "codex") return message.addressedTo === "codex";
      if (kind === "hermes") return message.addressedTo === "hermes";
      if (kind === "operator") return message.addressedTo === "operator";
      return true;
    }

    function boardNarrationMeta(item, verdict, lane) {
      return "board changed · " + boardLaneLabel(lane && lane.key) + " · " + (verdict && verdict.label ? verdict.label : "monitor verdict");
    }

    function boardLaneLabel(key) {
      if (key === "attention") return "Needs Attention";
      if (key === "waiting") return "Waiting / Drafts";
      if (key === "codex") return "Codex Needed";
      if (key === "hermes") return "Hermes Checking";
      if (key === "operator") return "Operator Review";
      if (key === "queue") return "Release Queue";
      if (key === "deploy") return "Deploying";
      return "Board";
    }

    function boardNarrationForChange(item, verdict, action, lane, previous) {
      const title = cardTitleText(pipelineTitle(item), item.pullRequestNumber || pullRequestNumberFromCorrelation(item.correlationId), item);
      const movedFrom = previous ? " from " + boardLaneLabel(previous.laneKey) : "";
      const nextStep = nextStepNarrationForItem(item, verdict, action, lane);
      if (isTestbedMissionItem(item)) {
        return "Update on " + title + ": I opened a testbed mission room" + movedFrom + ". This is not a PR gate; it is a browser-only evidence run. " + testbedMissionChatSummary(testbedMissionRun(item)) + " " + nextStep;
      }
      if (isDraftPullRequest(item)) {
        return "Update on " + title + ": it is still a draft, so I am keeping it in Waiting / Drafts instead of treating it as an urgent release blocker. " + nextStep;
      }
      if (codexTaskFailedForItem(item)) {
        return "Update on " + title + ": I moved it" + movedFrom + " back to Needs Attention because the Codex runner failed. " + nextStep;
      }
      if (action.owner === "Operator" || lane.key === "operator") {
        return "Update on " + title + ": this moved" + movedFrom + " into Operator Review. Automation has gone as far as it safely can. " + nextStep;
      }
      if (action.owner === "Codex" || lane.key === "codex" || lane.key === "attention") {
        return "Update on " + title + ": the board now needs Codex. " + nextStep;
      }
      if (action.owner === "Hermes" || lane.key === "hermes") {
        return "Update on " + title + ": I am taking it back through Hermes checks now. " + nextStep;
      }
      if (action.owner === "Merge queue" || lane.key === "queue") {
        return "Update on " + title + ": the checks look merge-ready, so I moved it into the release queue. " + nextStep;
      }
      if (lane.key === "deploy") {
        return "Update on " + title + ": it is in deploy verification now. " + nextStep;
      }
      return "Update on " + title + ": the board changed" + movedFrom + " to " + boardLaneLabel(lane.key) + ". " + nextStep;
    }

    function nextStepNarrationForItem(item, verdict, action, lane) {
      const recipe = actionRecipeForItem(item, item.summary || {}, verdict, action);
      const codexState = lane && lane.key === "codex" ? codexWorkState(item, pipelineStage(item, verdict)) : null;
      const flow = cardFlowCopy(item, verdict, action, lane || {}, codexState);
      return "Here is the actual handoff: " + recipe.owner + " owns it because " + sentenceFragment(recipe.why) + "." +
        " Right move now: " + recipe.ask +
        " The card button just " + sentenceFragment(flow.button) + "." +
        " After that, " + sentenceFragment(flow.after) + "." +
        " I will move it once " + sentenceFragment(recipe.clearsWhen) + ".";
    }

    function boardBriefingLineForItem(item, verdict, action, lane) {
      const title = cardTitleText(pipelineTitle(item), item.pullRequestNumber || pullRequestNumberFromCorrelation(item.correlationId), item);
      const nextStep = nextStepNarrationForItem(item, verdict, action, lane);
      if (isTestbedMissionItem(item)) {
        return "Hermes has a testbed browser mission for " + title + ". " + testbedMissionChatSummary(testbedMissionRun(item)) + " " + nextStep;
      }
      if (isDraftPullRequest(item)) {
        if (isExternalDraftPullRequest(item)) {
          return "Hermes is watching " + title + " as a draft owned outside this board. I am holding it out of release and not asking Codex to move unless Pascal explicitly delegates takeover. " + nextStep;
        }
        return "Codex, " + title + " is still a draft with a delegated task, so I am holding it out of the release path until the task makes it ready. Finish the draft work or mark it ready for review, then let CI and Hermes take another pass. " + nextStep;
      }
      if (codexTaskFailedForItem(item)) {
        return "Codex, " + title + " is back in Needs Attention because the last runner task failed. Start by opening the failed runner output: if it is auth or clone setup, fix the runner path; if it is a real PR/check failure, come back with the smallest retry task or smallest branch fix. " + nextStep;
      }
      if (lane.key === "attention" && action.owner === "Codex") {
        return "Codex, " + title + " is blocked at the gate. " + capitalizeFirst(action.text) + "; I will keep it visible here until the blocking signal disappears and Hermes records a clean pass. " + nextStep;
      }
      if (action.owner === "Operator" || lane.key === "operator") {
        return "Pascal, " + title + " needs your judgement rather than more automation. Check the evidence and only approve if the intent, architecture, rollout risk, and test coverage match what you actually want shipped. " + nextStep;
      }
      if (action.owner === "Hermes" || lane.key === "hermes") {
        return "Hermes is holding " + title + " while the read-only checks settle. I will bring the verdict back here, and if it turns red I will say exactly who needs to move next. " + nextStep;
      }
      if (action.owner === "Merge queue" || lane.key === "queue") {
        return title + " looks merge-ready, so I am keeping it in the release queue rather than pretending it is done. Merge only after branch protection is green and merge/deploy ownership is clear. " + nextStep;
      }
      if (lane.key === "deploy") {
        return title + " is in post-deploy verification. I am watching hosted health and deploy checks before calling it safe. " + nextStep;
      }
      return action.owner + ": " + title + " needs the next step — " + action.text + ". " + nextStep;
    }

    function boardBriefingMeta(item, verdict, lane) {
      const stage = pipelineStage(item, verdict);
      return stage.label + " · " + lane.key;
    }

    function capitalizeFirst(text) {
      const value = String(text || "");
      return value ? value.charAt(0).toUpperCase() + value.slice(1) : value;
    }

    function sentenceFragment(text) {
      const value = String(text || "").trim().replace(/[.]+$/g, "");
      return value ? value.charAt(0).toLowerCase() + value.slice(1) : "";
    }

    // Synthesized agent voice — these lines are derived from board
    // state, not generated by an LLM. Truth-boundary stays clean
    // because the text only restates what the verdict/lane already
    // says, just in a less robotic register. Codex's voice: pragmatic,
    // terse, action-first. Hermes's voice: dry, methodical, observing.
    function collaborationAskForItem(item, verdict, action, lane) {
      const title = cardTitleText(pipelineTitle(item), item.pullRequestNumber || pullRequestNumberFromCorrelation(item.correlationId), item);
      if (isTestbedMissionItem(item)) return "Hermes, " + title + " is a browser-only mission. " + testbedMissionChatSummary(testbedMissionRun(item));
      if (isExternalDraftPullRequest(item)) return "I am watching " + title + " as an external draft. It stays out of the release path until the PR author or owning agent marks it ready; Codex should not pick it up unless Pascal explicitly delegates takeover.";
      if (isDraftPullRequest(item)) return "Codex, " + title + " is still in draft mode with a delegated task. Finish the draft or mark it ready for review; once that happens I will wait for CI and Hermes to re-run before moving it forward.";
      if (codexTaskFailedForItem(item)) return "Codex, " + title + " failed in the runner. Please inspect the failed output first, then either fix the runner setup, push the smallest PR-check fix, or create a smaller retry task so Hermes has something concrete to re-check.";
      if (action.owner === "Codex" || lane.key === "codex") return "Codex, you are up on " + title + ". " + capitalizeFirst(action.text) + "; keep it narrow and hand it back when CI/Hermes can see the new signal.";
      if (action.owner === "Operator" || lane.key === "operator" || lane.key === "attention") return "Pascal, " + title + " needs your call. " + capitalizeFirst(action.text) + "; if the answer is no, send it back to Codex with the exact change you want.";
      if (action.owner === "Hermes" || lane.key === "hermes") return "I am watching " + title + " now. I will land the verdict here once the checks clear, and I will not pretend it is ready while the evidence is still moving.";
      if (lane.key === "queue") return title + " is ready enough to sit in the merge queue. I am holding it there until branch protection and merge/deploy ownership are both clear.";
      if (lane.key === "deploy") return "I am watching the deploy on " + title + ". If health or verification slips, I will say so here before anyone calls it done.";
      return action.owner + ", " + action.text + " for " + title + ".";
    }

    function testbedMissionChatSummary(run) {
      const mission = run || {};
      const result = mission.result || null;
      const status = String(mission.status || "");
      if (result && (status === "completed" || result.verdict === "pass")) {
        return "The browser-agent report passed, so I am treating it as a baseline: future runs should preserve the known-good path and compare against the attached evidence.";
      }
      if (result && (status === "failed" || result.verdict === "partial" || result.verdict === "fail" || result.stoppedBeforeMutation === false)) {
        const brief = testbedMissionComparisonBrief(mission);
        return "The browser-agent report needs a follow-up run. " + (brief || "Use the rerun prompt to check whether the prior blocker is gone, unchanged, or replaced.");
      }
      return "Run it as a clean outside agent with fresh memory, use only the visible page, stop before mutation, and bring the structured report back here so the board can judge the product experience instead of guessing.";
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
        // Collapsed from two Hermes lines into one — they were back-to-
        // back from the same speaker and read as duplicate noise.
        messages.push(collabMessage("Hermes", "I drafted a focused Codex task for " + title + ". Pascal, approve it when you want the runner to start; until then I will keep it visible but untouched.", "task proposed · approval needed", ts));
      } else if (status === "approved") {
        // Same collapse — Hermes's approval note and Codex's queued
        // ack happen in the same beat; keep them as one row each but
        // tighten the wording.
        messages.push(collabMessage("Hermes", "Approved. Codex, " + title + " is yours now: take the smallest useful step, push the branch, and I will watch the checks when you hand it back.", "approved", ts));
        messages.push(collabMessage("Codex", "Got it. I am queued behind the runner now; once I claim it, I will report back with either the branch update or the thing that blocked me.", "waiting runner", ts + 1));
      } else if (status === "running") {
        messages.push(collabMessage("Codex", "I am working on " + title + ". " + (task.progressMessage || "I will ping here when the branch is ready or if I hit something that needs a smaller task."), "running", ts));
      } else if (status === "completed") {
        messages.push(collabMessage("Codex", title + " is in. Hermes, please take it back through the checks so we know whether it actually cleared the board.", "completed", ts));
      } else if (status === "failed") {
        messages.push(collabMessage("Codex", "I stalled on " + title + ". " + (lastCodexTaskTail(task) || "Please check the runner output; if the task was too broad, send me a smaller follow-up and I will pick it up cleanly."), "failed", ts));
      } else if (status === "cancelled") {
        messages.push(collabMessage("Operator", "I cancelled the Codex task for " + title + ". Keep the card parked until there is a clearer next move.", "cancelled", ts));
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
      if (text.includes("approve") || text.includes("cancel") || text.includes("delegat") || text.includes("sent review back")) return "Operator";
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
      preserveSelectedActionContext(key, item);
      button.disabled = true;
      try {
        if (action === "delegate-draft") {
          if (!item) throw new Error("No draft PR selected for Codex delegation.");
          if (!isExternalDraftPullRequest(item)) throw new Error("This PR already has a Codex task or is not an external draft.");
          const summary = item.summary || {};
          const prompt = codexDelegationPromptForItem(item, summary);
          const pr = Number(item.pullRequestNumber || pullRequestNumberFromCorrelation(item.correlationId));
          if (!prompt || !Number.isFinite(pr) || pr < 1) throw new Error("This draft does not have enough PR metadata for Codex delegation.");
          const repo = String(item.repo || "averray-agent/agent");
          await postDraftDelegationConversation(item, "operator");
          const proposed = await postCodexTask({
            action: "propose",
            repo,
            pullRequestNumber: pr,
            correlationId: item.correlationId,
            title: "Draft takeover: " + cardTitleText(pipelineTitle(item), pr, item),
            reason: "operator explicitly delegated draft takeover to Codex",
            requester: "monitor",
            prompt,
          });
          const createdTask = proposed && proposed.task ? proposed.task : null;
          if (!createdTask || !createdTask.id) throw new Error("Codex task was not returned after delegation.");
          await postCodexTask({ action: "approve", id: createdTask.id });
          await postDraftDelegationConversation(item, "agents");
          preserveSelectedActionContext(key, item);
          forceThreadMode();
          renderAutoCollaborationThread();
          setComposeStatus("Draft delegated to Codex. Task approved; runner pickup is now allowed.", "ok");
          return;
        }
        if (action === "send-back") {
          if (!item) throw new Error("No PR selected for operator send-back.");
          if (isDraftPullRequest(item)) throw new Error("Draft PRs need explicit draft delegation instead of operator send-back.");
          const summary = item.summary || {};
          const verdict = releaseVerdict(item);
          if (verdict.level !== "needs-review") throw new Error("Only operator-review cards can be sent back to Codex.");
          const next = nextPipelineAction(item, verdict);
          const prompt = codexOperatorSendBackPromptForItem(item, summary, verdict, next);
          const pr = Number(item.pullRequestNumber || pullRequestNumberFromCorrelation(item.correlationId));
          if (!prompt || !Number.isFinite(pr) || pr < 1) throw new Error("This review card does not have enough PR metadata for Codex send-back.");
          const repo = String(item.repo || "averray-agent/agent");
          await postOperatorSendBackConversation(item, "operator", verdict);
          const proposed = await postCodexTask({
            action: "propose",
            repo,
            pullRequestNumber: pr,
            correlationId: item.correlationId,
            title: "Operator send-back: " + cardTitleText(pipelineTitle(item), pr, item),
            reason: "operator sent review back to Codex",
            requester: "monitor",
            prompt,
          });
          const createdTask = proposed && proposed.task ? proposed.task : null;
          if (!createdTask || !createdTask.id) throw new Error("Codex task was not returned after operator send-back.");
          await postCodexTask({ action: "approve", id: createdTask.id });
          await postOperatorSendBackConversation(item, "agents", verdict);
          preserveSelectedActionContext(key, item);
          forceThreadMode();
          renderAutoCollaborationThread();
          setComposeStatus("Sent back to Codex. Task approved; runner pickup is now allowed.", "ok");
          return;
        }
        if (action === "propose") {
          if (!item) throw new Error("No PR selected for Codex task proposal.");
          const summary = item.summary || {};
          const verdict = releaseVerdict(item);
          const next = nextPipelineAction(item, verdict);
          const prompt = codexPromptForItem(item, summary, verdict, next);
          const pr = Number(item.pullRequestNumber || pullRequestNumberFromCorrelation(item.correlationId));
          if (!prompt || !Number.isFinite(pr) || pr < 1) throw new Error("This card does not have enough PR metadata for a Codex task.");
          const proposed = await postCodexTask({
            action: "propose",
            repo: String(item.repo || "averray-agent/agent"),
            pullRequestNumber: pr,
            correlationId: item.correlationId,
            title: cardTitleText(pipelineTitle(item), pr, item),
            reason: next.text,
            requester: "monitor",
            prompt,
          });
          await postCodexTaskActionReceipt(item, "propose", proposed && proposed.task);
          preserveSelectedActionContext(key, item);
          forceThreadMode();
          renderAutoCollaborationThread();
          setComposeStatus("Codex task proposed. Approve it when you want Codex to pick it up.", "ok");
          return;
        }
        if (action === "approve") {
          if (!taskId) throw new Error("Missing Codex task id.");
          await postCodexTask({ action: "approve", id: taskId });
          await postCodexTaskActionReceipt(item, "approve", latestCodexTasks.find((task) => task.id === taskId));
          preserveSelectedActionContext(key, item);
          forceThreadMode();
          renderAutoCollaborationThread();
          setComposeStatus("Codex task approved. Codex worker pickup is now allowed.", "ok");
          return;
        }
        if (action === "cancel") {
          if (!taskId) throw new Error("Missing Codex task id.");
          await postCodexTask({ action: "cancel", id: taskId });
          await postCodexTaskActionReceipt(item, "cancel", latestCodexTasks.find((task) => task.id === taskId));
          preserveSelectedActionContext(key, item);
          forceThreadMode();
          renderAutoCollaborationThread();
          setComposeStatus("Codex task cancelled.", "ok");
          return;
        }
        throw new Error("Unsupported Codex task action: " + action);
      } catch (error) {
        if (output) output.textContent = "Codex task action failed: " + String(error.message || error);
      } finally {
        button.disabled = false;
      }
    }

    async function postDraftDelegationConversation(item, phase) {
      const relation = collaborationRelationForItem(item);
      const prLabel = relation.relatedPr ? relation.relatedPr.repo + "#" + relation.relatedPr.number : "this draft PR";
      if (phase === "operator") {
        await safePostCollaborationMessage(Object.assign({
          author: "operator",
          kind: "proposal",
          addressedTo: "codex",
          text: "Codex, please take over " + prLabel + ". It is still a draft, but I want you to inspect the branch, finish only the missing work you can verify, run the relevant checks, and mark it ready only if it is actually complete. Do not merge or deploy.",
        }, relation));
        return;
      }
      await safePostCollaborationMessage(Object.assign({
        author: "hermes",
        kind: "status",
        addressedTo: "operator",
        text: "I recorded that as an explicit takeover. " + prLabel + " can move from Waiting / Drafts into Codex Needed now; I will keep it out of the release path until Codex finishes and the PR is ready for a fresh check.",
      }, relation));
      await safePostCollaborationMessage(Object.assign({
        author: "codex",
        kind: "status",
        addressedTo: "operator",
        text: "Got it. I will treat this as a deliberate draft takeover: inspect first, keep the change small, and report back through the task before Hermes moves it forward.",
      }, relation));
    }

    async function postOperatorSendBackConversation(item, phase, verdict) {
      const relation = collaborationRelationForItem(item);
      const prLabel = relation.relatedPr ? relation.relatedPr.repo + "#" + relation.relatedPr.number : "this PR";
      const why = operatorSendBackReasons(item.summary || {}, verdict || releaseVerdict(item));
      if (phase === "operator") {
        await safePostCollaborationMessage(Object.assign({
          author: "operator",
          kind: "request_help",
          addressedTo: "codex",
          text: "Codex, I am sending " + prLabel + " back from operator review. Hermes' pre-check is not enough for me to approve it yet: " + why + ". Please make the smallest justified fix, or report clearly if the right answer is no code change.",
        }, relation));
        return;
      }
      await safePostCollaborationMessage(Object.assign({
        author: "hermes",
        kind: "status",
        addressedTo: "operator",
        text: "I recorded the operator send-back. " + prLabel + " can move to Codex Needed now; I will wait for Codex to hand it back before I re-check the PR.",
      }, relation));
      await safePostCollaborationMessage(Object.assign({
        author: "codex",
        kind: "status",
        addressedTo: "operator",
        text: "Understood. I will inspect the operator concern, keep the follow-up narrow, and report back through the task if the right move is a code change or a no-change explanation.",
      }, relation));
    }

    async function postActionReceipt(item, payload) {
      if (!payload || !payload.text) return null;
      const message = await safePostCollaborationMessage(Object.assign({
        author: "operator",
        kind: "status",
        addressedTo: "everyone",
      }, collaborationRelationForItem(item), payload));
      if (!message) return null;
      if (payload.addressedTo === "hermes" || payload.addressedTo === "everyone") {
        hermesTypingSinceMs = Date.now();
        const ts = Number(message.ts);
        if (Number.isFinite(ts)) pollCollaborationSince(ts);
      }
      forceThreadMode();
      renderAutoCollaborationThread();
      return message;
    }

    async function postFailedTaskReviewReceipt(item) {
      await postActionReceipt(item, {
        author: "operator",
        kind: "status",
        addressedTo: "codex",
        text: "Codex, I opened the failed task output for " + receiptPrLabel(item) + ". I am looking for the runner error first; the next move is either a smaller retry task or a clear no-code-change explanation.",
      });
    }

    async function postMonitorDecisionReceipt(item, decision, verdict) {
      if (!item || !decision) return;
      if (decision === "reset") {
        await postActionReceipt(item, {
          author: "operator",
          kind: "status",
          addressedTo: "hermes",
          text: "Hermes, I reopened my local review for " + receiptPrLabel(item) + ". Keep it out of the release path until I mark it reviewed again or send it back to Codex.",
        });
        return;
      }
      if (decision !== "approve") return;
      const label = operatorApprovalButtonLabel(item, verdict || releaseVerdict(item));
      if (isReleaseReviewVerdict(verdict)) {
        await postActionReceipt(item, {
          author: "operator",
          kind: "approval",
          addressedTo: "hermes",
          text: "Hermes, I marked " + receiptPrLabel(item) + " reviewed for release. This did not merge anything; move it toward the release queue only while GitHub branch protection stays green.",
        });
        return;
      }
      await postActionReceipt(item, {
        author: "operator",
        kind: "approval",
        addressedTo: "hermes",
        text: "Hermes, I clicked " + label + " for " + receiptPrLabel(item) + ". I am accepting the project-level review gate in the monitor; if CI or the evidence changes, bring it back before it moves forward.",
      });
    }

    async function postCommandSuggestionReceipt(command, item) {
      const receipt = commandSuggestionReceipt(command, item);
      if (!receipt) return;
      await postActionReceipt(item, receipt);
    }

    async function postCodexTaskActionReceipt(item, action, task) {
      const label = receiptPrLabel(item);
      if (action === "propose") {
        await postActionReceipt(item, {
          author: "operator",
          kind: "proposal",
          addressedTo: "codex",
          text: "Codex, I created a proposed task for " + label + ". It is not a runner start yet; hold until the task is approved, then keep the follow-up narrow and report back through the task.",
        });
        return;
      }
      if (action === "approve") {
        await postActionReceipt(item, {
          author: "operator",
          kind: "approval",
          addressedTo: "codex",
          text: "Codex, I approved the task for " + label + ". You are allowed to pick it up now; please keep the change bounded, push only if there is a concrete fix, and let Hermes re-check after CI.",
        });
        return;
      }
      if (action === "cancel") {
        const title = task && task.title ? " (" + task.title + ")" : "";
        await postActionReceipt(item, {
          author: "operator",
          kind: "status",
          addressedTo: "hermes",
          text: "Hermes, I cancelled the Codex task for " + label + title + ". Keep the card parked until the next move is clearer or a smaller task is proposed.",
        });
      }
    }

    function commandSuggestionReceipt(command, item) {
      const normalized = normalizeConsoleCommandText(command);
      const label = receiptPrLabel(item);
      if (normalized === "merge steward details") {
        return {
          author: "operator",
          kind: "request_context",
          addressedTo: "hermes",
          text: "Hermes, I am asking for merge-steward context on " + label + ". This button does not merge the PR; tell me what branch protection, ownership, and deploy follow-up need before this leaves the release queue.",
        };
      }
      if (normalized === "github status") {
        return {
          author: "operator",
          kind: "request_context",
          addressedTo: "hermes",
          text: "Hermes, I am checking CI status for " + label + ". Please focus on the current head commit, failed checks, active checks, and whether Codex or GitHub is the next blocker.",
        };
      }
      if (normalized === "handoff monitor details") {
        if (isTestbedMissionItem(item)) {
          return {
            author: "operator",
            kind: "request_context",
            addressedTo: "hermes",
            text: "Hermes, I opened testbed mission context for " + label + ". Explain the mission state, what evidence is attached or missing, and the next smallest useful move for a normal outside-agent page test.",
          };
        }
        return {
          author: "operator",
          kind: "request_context",
          addressedTo: "hermes",
          text: "Hermes, I opened handoff context for " + label + ". Explain why this card is here, who owns the next move, and what clears it.",
        };
      }
      if (normalized === "ops health") {
        return {
          author: "operator",
          kind: "request_context",
          addressedTo: "hermes",
          text: "Hermes, I am asking for ops health context from this card. Keep it read-only: summarize service health, recent errors, and whether production needs attention.",
        };
      }
      return null;
    }

    function receiptPrLabel(item) {
      if (!item) return "the selected card";
      const pr = item.pullRequestNumber || pullRequestNumberFromCorrelation(item.correlationId);
      const repo = String(item.repo || "averray-agent/agent");
      if (isTestbedMissionItem(item)) {
        const run = testbedMissionRun(item) || {};
        return run.id ? "testbed mission " + String(run.id) : "the selected testbed mission";
      }
      if (pr) return repo + "#" + pr;
      if (item.sha) return repo + "@" + compactSha(item.sha);
      return item.correlationId ? "handoff " + String(item.correlationId) : "this card";
    }

    function collaborationRelationForItem(item) {
      const relation = {};
      const pr = item && (item.pullRequestNumber || pullRequestNumberFromCorrelation(item.correlationId));
      if (item && pr) relation.relatedPr = { repo: String(item.repo || "averray-agent/agent"), number: Number(pr) };
      if (item && item.correlationId) relation.relatedCorrelationId = String(item.correlationId);
      return relation;
    }

    async function safePostCollaborationMessage(payload) {
      try {
        return await postCollaborationMessage(payload);
      } catch (error) {
        return null;
      }
    }

    async function postCollaborationMessage(payload) {
      const response = await fetch(collaborationUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.message || result.error || "HTTP " + response.status);
      if (result && result.message) {
        latestCollabMessages = (latestCollabMessages || []).concat([result.message]);
      }
      return result.message || null;
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
        await postActionReceipt(item, {
          author: "operator",
          kind: "request_recheck",
          addressedTo: "hermes",
          text: "Hermes, please re-check " + repo + "#" + pr + " now. Codex has handed something back or the board needs fresh evidence; rerun the read-only review and tell us what changed.",
        });
        const result = await postHermesRecheck({
          repo,
          pullRequestNumber: pr,
          correlationId: item.correlationId,
          reason: "monitor requested Hermes re-check after Codex handoff",
        });
        await postActionReceipt(item, {
          author: "hermes",
          kind: "status",
          addressedTo: "operator",
          text: result.text || ("I finished the re-check request for " + repo + "#" + pr + ". The board is refreshing with the latest verdict."),
        });
        forceThreadMode();
        renderAutoCollaborationThread();
        setComposeStatus(result.text || ("Hermes re-check completed for " + repo + "#" + pr + "."), "ok");
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
      // Same setText path as before, plus mirror the data-empty toggle
      // we already use for the top-strip counter chips (#157) so the
      // bottom filter pills dim when their count is 0. Reduces visual
      // noise — operator's eye lands on the pills that actually have
      // work behind them.
      setFilterPillCount("board-all", entries.length - (counts.done || 0));
      setFilterPillCount("board-block", counts.attention || 0);
      setFilterPillCount("board-review", counts.operator || 0);
      setFilterPillCount("board-ready", counts.queue || 0);
      setFilterPillCount("board-running", (counts.hermes || 0) + (counts.deploy || 0));
      setFilterPillCount("done-count", counts.done || 0);
      renderOwnerSummary(entries);
      renderStalenessSummary(entries);
      updatePipelineFilterButtons();
    }

    function renderBoardNowSummary(entries) {
      const target = document.getElementById("board-now");
      if (!target) return;
      const snapshot = boardNowSnapshot(entries);
      target.dataset.tone = snapshot.tone;
      target.innerHTML = '<div class="board-now-copy">' +
          '<span class="board-now-kicker">Board now</span>' +
          '<strong class="board-now-title">' + escapeHtml(snapshot.headline) + '</strong>' +
          '<span class="board-now-next">' + escapeHtml(snapshot.next) + '</span>' +
        '</div>' +
        '<div class="board-now-counts">' + boardNowCountsMarkup(snapshot.counts) + '</div>';
    }

    function boardNowSnapshot(entries) {
      const items = (entries || []).filter((item) => {
        if (!item) return false;
        return boardLaneForItem(item, releaseVerdict(item)).key !== "done";
      });
      const counts = commandBoardLaneCounts(items);
      const attention = counts.attention || 0;
      const waiting = counts.waiting || 0;
      const codex = counts.codex || 0;
      const operator = counts.operator || 0;
      const hermes = counts.hermes || 0;
      const queue = counts.queue || 0;
      const deploy = counts.deploy || 0;
      const running = hermes + deploy;
      const total = attention + waiting + codex + operator + queue + running;
      let tone = "quiet";
      let headline = "Board is quiet: no active PR handoffs in this monitor window.";
      if (attention) {
        tone = "attention";
        headline = "Board now: " + plural(attention, "card") + " " + (attention === 1 ? "needs" : "need") + " a fix or explicit decision before the release path can move.";
      } else if (codex) {
        tone = "codex";
        headline = "Board now: Codex owns " + plural(codex, "next move") + "; keep the patch small and hand it back to Hermes.";
      } else if (operator) {
        tone = "operator";
        headline = "Board now: " + plural(operator, "card") + " " + (operator === 1 ? "needs" : "need") + " Pascal's review decision; automation has gone as far as it safely can.";
      } else if (running) {
        tone = "running";
        headline = "Board now: " + plural(running, "check") + " or deploy verification " + (running === 1 ? "is" : "are") + " still moving.";
      } else if (queue) {
        tone = "queue";
        headline = "Board now: " + plural(queue, "PR") + " " + (queue === 1 ? "sits" : "sit") + " in the merge queue; branch protection and merge ownership decide what leaves next.";
      } else if (waiting) {
        tone = "waiting";
        headline = "Board now: " + plural(waiting, "draft") + " " + (waiting === 1 ? "is" : "are") + " parked in Waiting / Drafts; Codex is not taking over unless you delegate it.";
      } else if (total) {
        headline = "Board now: " + plural(total, "item") + " are visible, but none need a new owner right now.";
      }
      const focus = topConsoleItems(items, 4);
      const next = trimBoardNowText(boardBriefingNextMove(focus));
      return { tone, headline, next, counts: { attention, waiting, codex, operator, queue, running } };
    }

    function boardNowCountsMarkup(counts) {
      const chips = [
        { label: "fix", value: counts.attention },
        { label: "draft", value: counts.waiting },
        { label: "codex", value: counts.codex },
        { label: "review", value: counts.operator },
        { label: "queue", value: counts.queue },
        { label: "moving", value: counts.running },
      ].filter((chip) => chip.value > 0);
      if (!chips.length) return '<span class="pill">idle</span>';
      return chips.map((chip) => '<span class="pill">' + escapeHtml(chip.label + " " + chip.value) + '</span>').join("");
    }

    function trimBoardNowText(text) {
      const value = String(text || "I will speak up when a card needs an owner.").replace(/^First useful move:\s*/i, "Next: ");
      return value.length > 250 ? value.slice(0, 247).trimEnd() + "..." : value;
    }

    // Set a filter pill's inner count span AND toggle data-empty on
    // the outer button so CSS can dim 0-count filters. Mirrors
    // setCounterChip for the top-strip chips.
    function setFilterPillCount(spanId, value) {
      const span = document.getElementById(spanId);
      if (!span) return;
      const num = Number(value);
      const safe = Number.isFinite(num) ? Math.max(0, Math.floor(num)) : 0;
      span.textContent = String(safe);
      const pill = span.closest(".toggle-pill");
      if (pill) pill.setAttribute("data-empty", safe > 0 ? "false" : "true");
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
        { key: "waiting", title: "Waiting", owner: "PR author", empty: "No external drafts waiting." },
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

    function renderDecisionActions(item, verdict) {
      return '<div class="decision-actions">' +
        renderOperatorApprovalButton(item, verdict || releaseVerdict(item), "decision-button") +
        renderOperatorSendBackButton(item, "decision-button") +
        '</div>';
    }

    function renderOperatorDecisionNote(item) {
      const decision = decisionForItem(item);
      if (decision.status !== "approved") return "";
      const key = decisionKeyForItem(item);
      const at = decision.at ? " at " + new Date(decision.at).toLocaleString() : "";
      return '<section class="decision-note" aria-label="Operator decision">' +
        '<strong>Operator review marked complete</strong>' + escapeHtml(at) + '. This is a private monitor decision only; GitHub was not mutated. ' +
        '<button class="decision-button" type="button" data-monitor-decision="reset" data-decision-key="' + escapeAttr(key) + '">Undo local review</button>' +
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
      const externalDraft = isExternalDraftPullRequest(item);
      const criticalReview = isCriticalFileReview(item, summary);
      return {
        title: fixRequest.title || (isDraft ? (externalDraft ? "Draft waiting on PR author" : "Delegated draft readiness task") : verdict.level === "block" ? "Fix request for Codex" : criticalReview ? "Critical-file risk review" : "Operator decision request"),
        owner: fixRequest.owner || (externalDraft ? "PR author" : action.owner),
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
        if (isExternalDraftPullRequest(item)) {
          return "No agent action is required inside this board yet. Wait for the PR author or owning agent to finish the draft and mark it ready; delegate Codex takeover only if that ownership should change.";
        }
        return "Codex should finish the delegated draft work, mark the PR ready for review, and let CI plus Hermes run on the ready PR.";
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
      if (isCriticalFileReview(item, summary)) {
        return "Hermes/Codex should provide the code-level pre-check evidence. Operator should confirm the critical file change is intentional, rollbackable, and acceptable before the PR can move toward merge.";
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
        .concat(testbedMissionPipelineItems(payload.testbedMissions || []))
        .filter((item) => {
          const key = String(item.correlationId || item.repo + "#" + item.pullRequestNumber);
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
      return keepCurrentDeployItems(entries)
        .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
    }

    function testbedMissionPipelineItems(missions) {
      if (!Array.isArray(missions)) return [];
      return missions
        .filter((run) => run && typeof run === "object")
        .map((run) => {
          const status = normalize(run.status);
          const active = status === "ready" || status === "running";
          const terminalStatus = status === "completed" ? "completed" : status === "failed" ? "failed" : "running";
          const verdict = status === "completed" ? "pass" : status === "failed" ? "failed" : "running";
          return {
            correlationId: run.id,
            requester: "monitor",
            intent: "testbed_agent_mission",
            repo: "testbed/agent",
            status: terminalStatus,
            phase: "testbed_mission",
            active,
            activeState: active ? "running" : "inactive",
            startedAt: run.createdAt,
            updatedAt: run.updatedAt,
            reason: run.statusReason,
            summary: {
              kind: "testbed_mission_run",
              title: run.title || "Fresh-agent browser mission",
              status: run.status,
              finalReason: run.statusReason,
              finalVerdict: verdict,
              mergeRecommendation: "not_applicable",
              reviewSignals: {
                touchedAreas: ["testbed"],
                testSignals: ["browser mission packet ready"],
                missingTestSignals: status === "completed" ? [] : ["browser agent report"],
              },
              reviewReasons: status === "failed"
                ? [{ severity: "high", code: "testbed_mission_failed", message: run.statusReason || "Browser mission failed." }]
                : [],
              testbedMission: run,
            },
            safety: {
              source: "monitor",
              wouldMutate: false,
              wouldWriteLocalCheckpoint: false,
              freeFormHermesPromptUsed: false,
            },
          };
        });
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
        || intent === "testbed_agent_mission"
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
      if (isTestbedMissionItem(item)) return { key: "testbed", label: "Browser mission" };
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
      if (isTestbedMissionItem(item)) return "Hermes";
      if (item.active === true || item.activeState === "running" || status === "running") return "Hermes";
      if (isExternalDraftPullRequest(item)) return "PR author";
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
      const codexTask = codexTaskForItem(item);
      if (isTestbedMissionItem(item)) {
        const mission = testbedMissionRun(item) || {};
        const missionStatus = normalize(mission.status || summary.status || item.status);
        if (missionStatus === "completed") {
          return { owner: "Done", text: "use the browser mission report as evidence for the next testbed improvement" };
        }
        if (missionStatus === "failed") {
          return { owner: "Hermes", text: "inspect the browser mission report and decide whether the page or mission prompt needs the next fix" };
        }
        return { owner: "Hermes", text: "run the browser-only mission with a fresh agent and post the structured report back here" };
      }
      if (isDonePullRequestState(prState)) {
        return { owner: "Done", text: "PR is no longer open in GitHub; keep this handoff as release history" };
      }
      if (item.active === true || item.activeState === "running" || status === "running") {
        return { owner: "Hermes", text: "finish the current handoff checks and publish a verdict" };
      }
      if (isExternalDraftPullRequest(item)) {
        return { owner: "PR author", text: "finish the draft or mark it ready; Codex only takes over if the operator delegates a task" };
      }
      if (isDraftPullRequest(item)) {
        return { owner: codexTask && !isTerminalCodexTask(codexTask) ? "Codex" : "PR author", text: "finish the draft or mark it ready for review, then let CI and Hermes re-run" };
      }
      if (codexTaskFailedForItem(item)) {
        return { owner: "Codex", text: "review the failed Codex task output, push a smaller fix, or propose a retry task" };
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
        if (isCriticalFileReview(item, summary)) {
          return { owner: "Operator", text: "review the critical-file risk, confirm it is intentional, or send it back to Codex with the exact change needed" };
        }
        return { owner: "Operator", text: "use the agent pre-check evidence to decide project intent, architecture, and rollout risk" };
      }
      if (verdict.level === "pass") {
        return { owner: "Merge queue", text: "merge when branch protection and queue checks are green" };
      }
      return { owner: "GitHub Actions", text: "finish CI before Hermes can make a release-gate recommendation" };
    }

    function handoffAge(item) {
      const updated = Date.parse(String(item.updatedAt || ""));
      if (!Number.isFinite(updated)) return { state: "waiting", label: "Waiting", duration: "unknown age", staleTier: "" };
      const minutes = Math.max(0, Math.floor((Date.now() - updated) / 60000));
      const state = minutes >= 120 ? "stale" : minutes >= 30 ? "waiting" : "fresh";
      const label = state === "stale" ? "Stale" : state === "waiting" ? "Waiting" : "Fresh";
      // Sub-tier so a 1-day-old stuck PR signals louder than a freshly-
      // stale 2-hour-old one. Empty string when the item isn't stale.
      //   warn:     2h  ≤ age < 12h  (default stale yellow/red)
      //   high:    12h  ≤ age < 24h  (orange, bolder)
      //   critical: 24h ≤ age        (red, bold, faster pulse)
      const staleTier = state === "stale"
        ? (minutes >= 1440 ? "critical" : minutes >= 720 ? "high" : "warn")
        : "";
      return { state, label, duration: formatDuration(minutes), staleTier };
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

    // Page-title flash for unfocused tabs. When new posted messages
    // arrive while document.hidden is true, the title becomes
    // "(N) Hermes Monitor"; coming back into focus resets it.
    function updateUnreadTitle() {
      if (unreadPostedCount > 0) {
        document.title = "(" + unreadPostedCount + ") " + baseDocumentTitle;
      } else {
        document.title = baseDocumentTitle;
      }
    }
    window.addEventListener("focus", () => {
      unreadPostedCount = 0;
      updateUnreadTitle();
    });
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) {
        unreadPostedCount = 0;
        updateUnreadTitle();
      }
    });

    // Set a counter-chip's number and toggle data-empty on its outer
    // chip so the CSS can dim zero-count chips. The value is expected
    // to be a non-negative integer; anything else is treated as 0.
    function setCounterChip(numberId, value) {
      const numberEl = document.getElementById(numberId);
      if (!numberEl) return;
      const num = Number(value);
      const safe = Number.isFinite(num) ? Math.max(0, Math.floor(num)) : 0;
      numberEl.textContent = String(safe);
      const chip = numberEl.closest(".counter-chip");
      if (chip) chip.setAttribute("data-empty", safe > 0 ? "false" : "true");
    }

    // Short soft chime via Web Audio API when an @operator-addressed
    // message lands. Lazily creates the AudioContext on first use to
    // avoid the "no user gesture yet" warning at boot; subsequent
    // chimes share the same context. The browser autoplay policy is
    // satisfied because the operator already clicked something to get
    // here (mode toggles, send button, etc.).
    function playOperatorChime() {
      if (!collabSoundEnabled) return;
      try {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return;
        if (!collabAudioContext) collabAudioContext = new Ctx();
        const ctx = collabAudioContext;
        const now = ctx.currentTime;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sine";
        // Two-note "ding-dong": A5 then E6. Short, soft, not jarring.
        osc.frequency.setValueAtTime(880, now);
        osc.frequency.setValueAtTime(1318.5, now + 0.12);
        gain.gain.setValueAtTime(0, now);
        gain.gain.linearRampToValueAtTime(0.08, now + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.36);
        osc.connect(gain).connect(ctx.destination);
        osc.start(now);
        osc.stop(now + 0.38);
      } catch (e) {
        // Audio not available — swallow; this is a UX nicety, not a
        // load-bearing channel.
      }
    }

    function setCollabSoundEnabled(value) {
      collabSoundEnabled = !!value;
      try { localStorage.setItem(SOUND_STORAGE_KEY, collabSoundEnabled ? "on" : "off"); }
      catch (e) { /* private mode / quota — ignore */ }
      const btn = document.getElementById("collab-sound-toggle");
      if (btn) {
        btn.setAttribute("aria-pressed", collabSoundEnabled ? "true" : "false");
        btn.textContent = collabSoundEnabled ? "🔊" : "🔇";
        btn.setAttribute("title", collabSoundEnabled ? "Mute @operator chime" : "Unmute @operator chime");
      }
    }

    // After ingesting a fresh batch of posted messages, walk anything
    // addressed to "operator" that we haven't chimed for yet and play
    // the chime. Guarded by an ID set so we never chime twice for the
    // same message even across SSE snapshots.
    function maybeChimeForOperator(messages) {
      for (const m of messages || []) {
        if (!m || !m.id) continue;
        if (m.addressedTo !== "operator") continue;
        if (m.author === "operator") continue;
        if (playedSoundIds.has(m.id)) continue;
        playedSoundIds.add(m.id);
        playOperatorChime();
      }
    }

    function needsAttention(item) {
      const level = releaseVerdict(item).level;
      return level === "block" || level === "needs-review";
    }

    function releaseVerdict(item) {
      if (isTestbedMissionItem(item)) {
        const summary = item.summary || {};
        const mission = testbedMissionRun(item) || {};
        const status = normalize(mission.status || summary.status || item.status);
        const why = String(mission.statusReason || summary.finalReason || item.reason || "Mission packet is waiting for a browser-agent report.");
        if (status === "completed") return { level: "pass", label: "MISSION DONE", why };
        if (status === "failed") return { level: "block", label: "MISSION FAILED", why };
        return { level: "running", label: status === "running" ? "MISSION RUNNING" : "MISSION READY", why };
      }
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
        return { level: "needs-review", label: "DRAFT", why: "GitHub reports this PR is still a draft; the PR author or owning agent must mark it ready before Hermes/operator review." };
      }
      if (prState && normalize(prState.mergeableState) === "dirty") {
        return { level: "block", label: "CONFLICT", why: "GitHub reports this PR has merge conflicts." };
      }
      if (reason === "pr_checks_active" || reason === "ci_in_progress") {
        return { level: "running", label: "CI RUNNING", why: releaseReason(summary, item, "running") };
      }
      if (codexTaskFailedForItem(item)) {
        return { level: "block", label: "CODEX FAILED", why: "Codex task runner failed; inspect the task output or propose a smaller retry task before Hermes can continue." };
      }
      if (isCriticalFileReview(item, summary) && !hasFailingCheckSignal(summary, reason)) {
        return { level: "needs-review", label: "CRITICAL REVIEW", why: releaseReason(summary, item, "needs-review") };
      }
      const terminal = classifyReleaseGate(status, finalVerdict, mergeRecommendation, reason, reviewReasons);
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

    function reviewReasonCodes(summary) {
      const reasons = Array.isArray(summary && summary.reviewReasons) ? summary.reviewReasons : [];
      return reasons.map((reason) => normalize(reason && reason.code)).filter(Boolean);
    }

    function isCriticalFileReview(item, summary) {
      const reason = normalize((summary && (summary.finalReason || summary.reason)) || (item && item.reason));
      return reason === "pr_critical_files" || reviewReasonCodes(summary).includes("pr_critical_files");
    }

    function hasFailingCheckSignal(summary, reason) {
      const normalizedReason = normalize(reason || (summary && (summary.finalReason || summary.reason)));
      if (normalizedReason === "pr_checks_failed" || normalizedReason === "ci_failed") return true;
      const live = summary && summary.githubLive && summary.githubLive.checkTotals;
      if (live && Number(live.failed || 0) > 0) return true;
      const checks = Array.isArray(summary && summary.checks) ? summary.checks : [];
      return checks.some((check) => {
        const state = normalize(check && (check.conclusion || check.state || check.status));
        return ["failure", "failed", "fail", "error", "cancelled", "timed_out"].includes(state);
      });
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
      if (reason === "pr_is_draft") return "PR is still marked as draft; the author or owning agent must finish it before release review.";
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

    function isExternalDraftPullRequest(item) {
      if (!isDraftPullRequest(item)) return false;
      const task = codexTaskForItem(item);
      return !task || isTerminalCodexTask(task);
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

    function prettyJson(value) {
      try {
        return JSON.stringify(value || {}, null, 2);
      } catch {
        return String(value || "");
      }
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
