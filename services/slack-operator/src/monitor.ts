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
    || /^what can you do for us( details?| full| audit)?$/.test(text)
    || /^(how do we deploy|runbook for|secret rotation runbook)( .*)?$/.test(text)
    || /^propose (merge|deploy|secret rotation|rollback)\b/.test(text)
    || /^run testbed e2e read[ -]?only( details?| full| audit)?$/.test(text)
  );
}

export function renderMonitorHtml(options: { title?: string; eventsPath?: string; streamPath?: string; commandPath?: string } = {}): string {
  const title = escapeHtml(options.title ?? "Hermes Handoff Monitor");
  const eventsPath = JSON.stringify(options.eventsPath ?? "/monitor/events");
  const streamPath = JSON.stringify(options.streamPath ?? "/monitor/stream");
  const commandPath = JSON.stringify(options.commandPath ?? "/monitor/command");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
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
      --muted: #8d9b91;
      --faint: #5f7169;
      --accent: #d89a2b;
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
      align-items: baseline;
      gap: 6px;
      min-height: 30px;
      padding: 0 10px;
      border: 1px solid var(--line);
      border-radius: 7px;
      background: var(--surface-soft);
      white-space: nowrap;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
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
      color: var(--text);
      font-weight: 800;
      font-size: 0.95rem;
    }
    .counter-label {
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.08em;
      font-size: 0.62rem;
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
      grid-template-rows: auto minmax(0, 1fr);
      gap: 12px;
      padding: 12px 14px 88px;
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
        44px;
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
      border-left: 3px solid var(--lane-accent);
      border-radius: 8px;
      background: var(--surface-strong);
      box-shadow: 0 10px 28px rgba(0, 0, 0, 0.24);
      padding: 10px;
      cursor: pointer;
      text-align: left;
      color: var(--text);
      transition: transform 0.14s ease, border-color 0.14s ease, opacity 0.14s ease;
    }
    .handoff-card:hover,
    .handoff-card[data-selected="true"] {
      transform: translateY(-1px);
      border-color: var(--lane-accent);
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
    .done-rail {
      min-width: 44px;
      width: 44px;
      cursor: pointer;
      border-style: dashed;
      background: rgba(2, 15, 13, 0.5);
    }
    .done-rail .lane-head {
      min-height: 100%;
      height: 100%;
      justify-content: center;
      padding: 8px 4px;
      border-top-width: 0;
      border-left: 2px solid var(--lane-accent);
    }
    .done-rail .lane-title {
      writing-mode: vertical-rl;
      transform: rotate(180deg);
      gap: 8px;
      overflow: visible;
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
    }
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
      grid-template-columns: minmax(0, 1fr) minmax(240px, auto);
      gap: 10px;
      align-items: end;
      border: 1px solid var(--line);
      border-radius: 12px;
      background: rgba(7, 15, 12, 0.97);
      box-shadow: 0 18px 60px rgba(0, 0, 0, 0.34);
      padding: 10px;
      backdrop-filter: blur(14px);
    }
    .command-shell.has-selection .command-console {
      right: calc(clamp(420px, 31vw, 640px) + 18px);
    }
    .console-main {
      display: grid;
      gap: 8px;
      min-width: 0;
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
    .console-output {
      max-height: 96px;
      overflow: auto;
      color: var(--muted);
      font-size: 0.82rem;
      line-height: 1.4;
      white-space: pre-wrap;
    }
    .suggestions {
      display: flex;
      align-items: center;
      gap: 6px;
      flex-wrap: wrap;
      justify-content: flex-end;
    }
    .suggestion {
      min-height: 30px;
      padding: 0 10px;
      border-radius: 999px;
      font-size: 0.78rem;
      background: var(--surface-soft);
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
      .pipeline-detail { grid-template-columns: 1fr; }
      dl { grid-template-columns: 1fr; }
      .cmdbar,
      .filterbar,
      .command-console { grid-template-columns: 1fr; }
      .cmd-counters,
      .filter-left,
      .filter-right,
      .suggestions { justify-content: flex-start; overflow-x: auto; }
      .kanban-board,
      .kanban-board[data-done-expanded="true"] {
        grid-template-columns: repeat(7, minmax(250px, 82vw));
        overflow-x: auto;
      }
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
  </style>
</head>
<body>
  <main id="monitor-shell" class="command-shell">
    <header class="cmdbar">
      <div class="brand">
        <div class="brand-mark">A</div>
        <div>
          <div class="brand-name">Hermes</div>
          <div class="brand-sub">handoff monitor · averray</div>
        </div>
      </div>
      <div class="cmd-counters" aria-label="Release counters">
        <span class="counter-chip" data-tone="warn"><span id="attention-chip" class="counter-number">0</span><span class="counter-label">needs attention</span></span>
        <span class="counter-chip" data-tone="bad"><span id="blocked-chip" class="counter-number">0</span><span class="counter-label">blocked</span></span>
        <span class="counter-chip"><span id="review-chip" class="counter-number">0</span><span class="counter-label">operator</span></span>
        <span class="counter-chip" data-tone="ok"><span id="ready-chip" class="counter-number">0</span><span class="counter-label">ready</span></span>
        <span class="counter-chip"><span id="running-chip" class="counter-number">0</span><span class="counter-label">in flight</span></span>
      </div>
      <div class="refresh-cluster">
        <span id="live-status" class="cmd-status" data-state="connecting">connecting</span>
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
        <span class="fb-pill-group" aria-label="Pipeline filters">
          <button class="toggle-pill" type="button" data-pipeline-filter="all" aria-pressed="true">all <span id="board-all">0</span></button>
          <button class="toggle-pill" type="button" data-pipeline-filter="block" aria-pressed="false">blocked <span id="board-block">0</span></button>
          <button class="toggle-pill" type="button" data-pipeline-filter="needs-review" aria-pressed="false">operator <span id="board-review">0</span></button>
          <button class="toggle-pill" type="button" data-pipeline-filter="pass" aria-pressed="false">ready <span id="board-ready">0</span></button>
          <button class="toggle-pill" type="button" data-pipeline-filter="running" aria-pressed="false">running <span id="board-running">0</span></button>
        </span>
        <button id="toggle-done" class="toggle-pill" type="button" aria-pressed="false">done lane <span id="done-count">0</span></button>
      </div>
    </section>
    <section class="board-shell">
      <div id="active" class="live-lane"><strong>Live lane</strong><span>No running or just-finished handoffs.</span><span class="pill">SSE + polling</span></div>
      <section id="owner-lanes" class="kanban-board" aria-label="Release command board"><div class="empty">Loading command board...</div></section>
    </section>
    <aside id="detail-drawer" class="drawer" data-open="false" aria-label="Selected handoff detail"></aside>
    <form id="command-console" class="command-console" autocomplete="off">
      <div class="console-main">
        <div class="console-context"><strong>Ask Hermes</strong><span id="console-context">global monitor context</span></div>
        <div class="console-row">
          <input id="command-input" class="console-input" name="text" placeholder="Ask for status, merge steward, why this PR is here..." autocomplete="off">
          <button id="command-submit" type="submit">Send</button>
        </div>
        <div id="command-output" class="console-output">Read-only command console. It will refuse merge, deploy, claim, submit, and secret commands.</div>
      </div>
      <div class="suggestions" aria-label="Suggested Hermes commands">
        <button class="suggestion" type="button" data-command-suggestion="handoff monitor details">handoff monitor</button>
        <button class="suggestion" type="button" data-command-suggestion="merge steward details">merge steward</button>
        <button class="suggestion" type="button" data-command-suggestion="github status">github status</button>
        <button class="suggestion" type="button" data-command-suggestion="ops health">ops health</button>
        <button class="suggestion" type="button" data-command-suggestion="codex handoff protocol">protocol</button>
      </div>
    </form>
  </main>
  <script>
    const eventsPath = ${eventsPath};
    const streamPath = ${streamPath};
    const commandPath = ${commandPath};
    const token = new URLSearchParams(location.search).get("token");
    const withToken = buildMonitorUrl(eventsPath);
    const streamUrl = buildMonitorUrl(streamPath);
    const commandUrl = buildCommandUrl(commandPath);
    const decisionStorageKey = "averray-monitor-operator-decisions:v1";
    let pipelineFilter = "all";
    let repoFilter = "all";
    let agentFilter = "all";
    let searchText = "";
    let showDone = false;
    let selectedKey = "";
    let autoFocusPending = true;
    let latestPipelineItems = [];
    let latestPayload = null;
    let monitorDecisions = loadMonitorDecisions();
    let pollTimer = null;
    let streamSource = null;

    document.getElementById("refresh").addEventListener("click", () => load());
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
        selectedKey = "";
        autoFocusPending = false;
        renderBoard(latestPipelineItems);
        renderDrawer(null);
        renderCommandContext();
        return;
      }
      const copyButton = event.target && event.target.closest ? event.target.closest("[data-copy-text]") : null;
      if (copyButton) {
        const value = String(copyButton.getAttribute("data-copy-text") || "");
        void navigator.clipboard?.writeText(value);
        return;
      }
      const suggestion = event.target && event.target.closest ? event.target.closest("[data-command-suggestion]") : null;
      if (suggestion) {
        const value = String(suggestion.getAttribute("data-command-suggestion") || "");
        document.getElementById("command-input").value = contextualCommand(value);
        document.getElementById("command-input").focus();
        return;
      }
      const button = event.target && event.target.closest ? event.target.closest("[data-monitor-decision]") : null;
      if (!button) return;
      const key = String(button.getAttribute("data-decision-key") || "");
      const decision = String(button.getAttribute("data-monitor-decision") || "");
      if (!key) return;
      if (decision === "approve") setMonitorDecision(key, { status: "approved", at: new Date().toISOString() });
      if (decision === "reset") setMonitorDecision(key, null);
      if (latestPayload) render(latestPayload);
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
      void submitMonitorCommand(text);
    });
    load();
    startLiveUpdates();

    async function load() {
      try {
        const response = await fetch(withToken, { cache: "no-store" });
        if (!response.ok) throw new Error("HTTP " + response.status);
        render(await response.json());
      } catch (error) {
        updateLiveStatus("error", "update failed");
        document.getElementById("recent").innerHTML = '<div class="empty error">Monitor unavailable: ' + escapeHtml(String(error.message || error)) + '</div>';
      }
    }

    function startLiveUpdates() {
      if ("EventSource" in window) {
        connectMonitorStream();
        return;
      }
      startPolling("polling 5s");
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
      updateLiveStatus("polling", label || "polling 5s");
      if (pollTimer) return;
      pollTimer = setInterval(load, 5000);
    }

    function updateLiveStatus(state, label) {
      const target = document.getElementById("live-status");
      if (!target) return;
      target.dataset.state = state;
      target.textContent = label;
    }

    function render(payload) {
      latestPayload = payload;
      const counts = payload.counts || {};
      const recent = payload.recent || [];
      setText("generated", payload.generatedAt ? new Date(payload.generatedAt).toLocaleTimeString() : "unknown");
      latestPipelineItems = groupPrPipelineItems(collectPipelineItems(payload));
      const attention = latestPipelineItems.filter(needsAttention);
      const verdicts = latestPipelineItems.map(releaseVerdict);
      const blocked = verdicts.filter((verdict) => verdict.level === "block").length;
      const review = verdicts.filter((verdict) => verdict.level === "needs-review").length;
      const ready = verdicts.filter((verdict) => verdict.level === "pass").length;
      const running = verdicts.filter((verdict) => verdict.level === "running").length;
      setText("attention-chip", String(blocked + review));
      setText("blocked-chip", String(blocked));
      setText("review-chip", String(review));
      setText("ready-chip", String(ready));
      setText("running-chip", String(running));
      renderPipelineBoard(latestPipelineItems);
      renderLiveLane(payload.active || []);
      renderBoard(latestPipelineItems);
      renderDrawer(selectedItem());
      renderCommandContext();
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
      target.innerHTML = lanes
        .filter((lane) => lane.key !== "done" || showDone)
        .map((lane) => renderBoardLane(lane, filtered))
        .join("") + (showDone ? "" : renderDoneStub(filtered));
    }

    function filterCommandBoardItems(entries) {
      return entries.filter((item) => {
        const verdict = releaseVerdict(item);
        const lane = boardLaneForItem(item, verdict);
        if (pipelineFilter !== "all" && verdict.level !== pipelineFilter) return false;
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
        { key: "codex", title: "Codex Working", kicker: "agent · writing", empty: "Nothing waiting on Codex." },
        { key: "hermes", title: "Hermes Checking", kicker: "agent · reviewing", empty: "Hermes has no active PR checks." },
        { key: "operator", title: "Operator Review", kicker: "operator · sign-off", empty: "No operator sign-off needed." },
        { key: "queue", title: "Release Queue", kicker: "cleared to merge", empty: "Nothing ready to merge." },
        { key: "deploy", title: "Deploying", kicker: "post-deploy verify", empty: "No deploy verification active." },
        { key: "done", title: "Done", kicker: "release history", empty: "No completed PRs in view." },
      ];
    }

    function renderBoardLane(lane, entries) {
      const items = entries
        .filter((item) => boardLaneForItem(item, releaseVerdict(item)).key === lane.key)
        .sort((a, b) => boardSortScore(b) - boardSortScore(a) || String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
      const cards = items.length
        ? items.slice(0, lane.key === "done" ? 10 : 8).map((item) => renderBoardCard(item, lane)).join("")
        : '<div class="lane-empty">' + escapeHtml(lane.empty) + '</div>';
      return '<section class="lane" data-lane="' + escapeAttr(lane.key) + '">' +
        '<div class="lane-head"><div class="lane-title">' + escapeHtml(lane.title) + ' <span class="pill">' + escapeHtml(String(items.length)) + '</span></div><span class="lane-subtitle">' + escapeHtml(lane.kicker) + '</span></div>' +
        '<div class="lane-body">' + cards + '</div>' +
        '</section>';
    }

    function renderDoneStub(entries) {
      const done = entries.filter((item) => boardLaneForItem(item, releaseVerdict(item)).key === "done");
      setText("done-count", String(done.length));
      return '<button class="lane done-rail" data-lane="done" type="button" id="done-stub" aria-label="Show done lane" onclick="document.getElementById(\\'toggle-done\\').click()">' +
        '<div class="lane-head"><div class="lane-title">Done <span class="pill">' + escapeHtml(String(done.length)) + '</span></div></div>' +
        '<div class="lane-body"><div class="lane-empty">click to show release history</div></div>' +
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
      return '<article class="handoff-card" data-select-card="' + escapeAttr(key) + '" data-selected="' + escapeAttr(String(selected)) + '">' +
        '<div class="card-head"><span class="pill state-pill" data-level="' + escapeAttr(verdict.level) + '">' + escapeHtml(verdict.label) + '</span><span class="card-subtitle">' + escapeHtml(age.label + " " + age.duration) + '</span></div>' +
        '<div class="card-subtitle">' + escapeHtml(item.repo || "unknown repo") + (item.pullRequestNumber ? " #" + escapeHtml(String(item.pullRequestNumber)) : "") + '</div>' +
        '<h3 class="card-title">' + escapeHtml(title.replace(/^.*?#\\d+\\s*/, "")) + '</h3>' +
        renderGroupBadges(item) +
        renderMiniSteps(stage, verdict) +
        '<p class="card-why">' + escapeHtml(verdict.why) + '</p>' +
        '<div class="card-meta-row"><span class="tags">' + touchedAreas.slice(0, 3).map((value) => '<code>' + escapeHtml(String(value)) + '</code>').join("") + '</span><span class="card-subtitle">' + escapeHtml(testSummaryText(tests)) + '</span></div>' +
        '<div class="card-foot"><span class="card-next">Next <strong>' + escapeHtml(action.owner) + '</strong></span><span class="card-actions">' + primaryActionButton(item, verdict, action, lane) + '</span></div>' +
        '</article>';
    }

    function renderMiniSteps(stage, verdict) {
      const steps = ["pr", "ci", "hermes", "testbed", "gate", "deploy"];
      const activeIndex = Math.max(0, steps.indexOf(stage.key));
      return '<div class="mini-steps" aria-label="Pipeline progress">' + steps.map((key, index) => {
        return '<span class="mini-step" data-state="' + escapeAttr(pipelineStepState(index, activeIndex, key, verdict.level)) + '"></span>';
      }).join("") + '</div>';
    }

    function primaryActionButton(item, verdict, action, lane) {
      if (verdict.level === "block") return '<button class="soft-button" data-action="primary" type="button" data-command-suggestion="merge steward details">Codex Fix -></button>';
      if (verdict.level === "needs-review") return '<button class="soft-button" data-action="primary" type="button" data-monitor-decision="approve" data-decision-key="' + escapeAttr(decisionKeyForItem(item)) + '">Approve</button>';
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
      if (reason === "ci_in_progress") return { key: "codex" };
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
      const testSignals = Array.isArray(signals.testSignals) ? signals.testSignals : [];
      const missingTests = Array.isArray(signals.missingTestSignals) ? signals.missingTestSignals : [];
      const rollout = signals.rolloutNotesRequired === true
        ? signals.rolloutNotesPresent === true ? "present" : "missing"
        : "not required";
      const reviewWhy = reviewReasonRows(summary) || row("Why", escapeHtml(verdict.why));
      const links = [
        prUrl ? '<a class="pill" href="' + escapeAttr(prUrl) + '" target="_blank" rel="noreferrer">open PR</a>' : "",
        workflowRunUrl ? '<a class="pill" href="' + escapeAttr(workflowRunUrl) + '" target="_blank" rel="noreferrer">workflow run</a>' : "",
        commitUrl ? '<a class="pill" href="' + escapeAttr(commitUrl) + '" target="_blank" rel="noreferrer">commit</a>' : "",
      ].filter(Boolean).join("");
      target.dataset.open = "true";
      target.innerHTML = '<div class="drawer-head">' +
        '<div class="drawer-topline"><span class="pill state-pill" data-level="' + escapeAttr(verdict.level) + '">' + escapeHtml(verdict.label) + '</span><button class="soft-button" type="button" data-close-drawer>Close</button></div>' +
        '<h2 class="drawer-title">' + escapeHtml(title) + '</h2>' +
        '<div class="drawer-links">' + (links || '<span class="pill">no external links</span>') + '<span class="pill">' + escapeHtml(age.label + " " + age.duration) + '</span></div>' +
        '</div>' +
        '<div class="drawer-body">' +
        '<section class="drawer-section"><h3>Next action</h3><p><strong>' + escapeHtml(action.owner) + ':</strong> ' + escapeHtml(action.text) + '</p></section>' +
        '<section class="drawer-section"><h3>Pipeline</h3>' + renderPipelineSteps(stage, verdict) + '</section>' +
        '<section class="drawer-section"><h3>Hermes verdict</h3><p>' + escapeHtml(verdict.why) + '</p><dl class="pipeline-detail">' + reviewWhy + '</dl></section>' +
        operatorChecklistSection(item, verdict, action) +
        '<section class="drawer-section"><h3>Agent pre-check</h3><dl class="pipeline-detail">' +
        row("Changed areas", touchedAreas.length ? chips(touchedAreas) : "n/a") +
        row("Tests seen", testSignals.length ? chips(testSignals.slice(0, 8)) : "n/a") +
        row("Missing tests", missingTests.length ? chips(missingTests) : "none recorded") +
        row("Rollout notes", escapeHtml(rollout)) +
        row("Correlation", '<code>' + escapeHtml(item.correlationId || "unknown") + '</code>') +
        row("Commit", escapeHtml(item.sha ? compactSha(item.sha) : "n/a")) +
        '</dl></section>' +
        renderOperatorDecisionNote(item) +
        '</div>' +
        '<div class="drawer-footer">' +
        '<div class="card-actions">' +
        (prUrl ? '<a class="pill" href="' + escapeAttr(prUrl) + '" target="_blank" rel="noreferrer">Open PR</a>' : "") +
        (workflowRunUrl ? '<a class="pill" href="' + escapeAttr(workflowRunUrl) + '" target="_blank" rel="noreferrer">Workflow Run</a>' : "") +
        '<button class="soft-button" type="button" data-command-suggestion="handoff monitor details">Ask Hermes</button>' +
        '<button class="soft-button" type="button" data-copy-text="' + escapeAttr(item.correlationId || "") + '">copy correlation</button>' +
        (verdict.level === "needs-review" ? '<button class="soft-button" data-action="primary" type="button" data-monitor-decision="approve" data-decision-key="' + escapeAttr(decisionKeyForItem(item)) + '">Approve locally</button>' : "") +
        '</div></div>';
    }

    function operatorChecklistSection(item, verdict, action) {
      if (verdict.level !== "needs-review") return "";
      const summary = item.summary || {};
      const request = buildFixRequest(item, summary, verdict, action);
      return '<section class="drawer-section"><h3>Operator sign-off</h3>' +
        '<p>Hermes has already checked CI, touched areas, test signals, rollout notes, and PR state. Your job is not line-by-line code review; decide whether the project intent, architecture, and release risk are acceptable.</p>' +
        '<dl class="pipeline-detail">' +
        row("Decision needed", escapeHtml(request.reason)) +
        row("Review surfaces", request.surfaces.length ? chips(request.surfaces) : "n/a") +
        row("Ask Codex if", escapeHtml("the intent is wrong, rollout risk is unclear, or the architecture should change")) +
        row("Proceed if", escapeHtml("the change matches the project direction and the recorded checks are enough for this risk")) +
        '</dl></section>';
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

    async function submitMonitorCommand(text) {
      const output = document.getElementById("command-output");
      const submit = document.getElementById("command-submit");
      const input = document.getElementById("command-input");
      const item = selectedItem();
      output.textContent = "Hermes is checking: " + text;
      submit.disabled = true;
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
        output.textContent = payload.text || "Hermes command completed.";
        input.value = "";
      } catch (error) {
        output.textContent = "Command refused or failed: " + String(error.message || error);
      } finally {
        submit.disabled = false;
      }
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
      const verdicts = entries.map(releaseVerdict);
      setText("board-all", String(entries.length));
      setText("board-block", String(verdicts.filter((verdict) => verdict.level === "block").length));
      setText("board-review", String(verdicts.filter((verdict) => verdict.level === "needs-review").length));
      setText("board-ready", String(verdicts.filter((verdict) => verdict.level === "pass").length));
      setText("board-running", String(verdicts.filter((verdict) => verdict.level === "running").length));
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
      const actions = verdict.level === "needs-review" ? renderDecisionActions(item) : "";
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

    function buildFixRequest(item, summary, verdict, action) {
      const signals = summary.reviewSignals || {};
      const fixRequest = summary.fixRequest && typeof summary.fixRequest === "object" ? summary.fixRequest : {};
      const reviewReasons = Array.isArray(summary.reviewReasons) ? summary.reviewReasons : [];
      const touchedAreas = Array.isArray(signals.touchedAreas) ? signals.touchedAreas.map(String).filter(Boolean) : [];
      const missingTests = Array.isArray(signals.missingTestSignals) ? signals.missingTestSignals.map(String).filter(Boolean) : [];
      const testSignals = Array.isArray(signals.testSignals) ? signals.testSignals.map(String).filter(Boolean) : [];
      const reason = firstReviewReason(reviewReasons) || releaseReason(summary, item, verdict.level);
      const checks = Array.isArray(fixRequest.checks)
        ? fixRequest.checks.map(String).filter(Boolean)
        : missingTests.length ? missingTests : testSignals.slice(0, 5);
      return {
        title: fixRequest.title || (verdict.level === "block" ? "Fix request for Codex" : "Operator sign-off request"),
        owner: fixRequest.owner || action.owner,
        instruction: fixRequest.instruction || fixRequestInstruction(verdict, action),
        reason,
        surfaces: Array.isArray(fixRequest.surfaces) ? fixRequest.surfaces.map(String).filter(Boolean) : touchedAreas,
        checks,
        rerun: fixRequest.rerun || "push an update, then let CI and Hermes handoff run again",
      };
    }

    function fixRequestInstruction(verdict, action) {
      if (verdict.level === "block") {
        return "Codex should fix the blocking signal, push the PR branch, and wait for CI plus Hermes to re-run.";
      }
      if (verdict.level === "needs-review") {
        return "Hermes/Codex should provide the code-level pre-check evidence. Operator should decide whether the project intent, architecture, and rollout risk are acceptable.";
      }
      return action.text;
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
      return entries.sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
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
      if (verdict.level === "block") return { key: "gate", label: "Blocked at gate" };
      if (verdict.level === "needs-review") return { key: "gate", label: "Operator review" };
      if (verdict.level === "pass") return { key: "gate", label: "Ready for merge" };
      return { key: "ci", label: "CI / handoff" };
    }

    function nextPipelineActor(item, verdict) {
      const status = normalize(item.status);
      if (item.active === true || item.activeState === "running" || status === "running") return "Hermes";
      if (verdict.level === "block") return "Codex";
      if (verdict.level === "needs-review") return "Operator";
      if (verdict.level === "pass") return "Merge queue";
      return "GitHub Actions";
    }

    function nextPipelineAction(item, verdict) {
      const status = normalize(item.status);
      const prState = pullRequestState(item, item.summary || {});
      if (isDonePullRequestState(prState)) {
        return { owner: "Done", text: "PR is no longer open in GitHub; keep this handoff as release history" };
      }
      if (item.active === true || item.activeState === "running" || status === "running") {
        return { owner: "Hermes", text: "finish the current handoff checks and publish a verdict" };
      }
      if (verdict.level === "block") {
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
      return verdict;
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
        return { level: "needs-review", label: "DRAFT", why: "GitHub reports this PR is still a draft." };
      }
      if (prState && normalize(prState.mergeableState) === "dirty") {
        return { level: "block", label: "CONFLICT", why: "GitHub reports this PR has merge conflicts." };
      }
      const terminal = classifyReleaseGate(status, finalVerdict, mergeRecommendation, reason, reviewReasons);
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
      if (reason === "ci_in_progress") return "CI is still running; wait for the result.";
      if (level === "pass") return "No blocking release signals recorded.";
      return String(summary.finalReason || summary.reason || item.reason || item.phase || "No reason recorded.");
    }

    function pullRequestState(item, summary) {
      if (summary && typeof summary.currentPullRequest === "object" && summary.currentPullRequest !== null) return summary.currentPullRequest;
      if (summary && typeof summary.pullRequest === "object" && summary.pullRequest !== null) return summary.pullRequest;
      return null;
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
