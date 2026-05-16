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

export function renderMonitorHtml(options: { title?: string; eventsPath?: string; streamPath?: string } = {}): string {
  const title = escapeHtml(options.title ?? "Hermes Handoff Monitor");
  const eventsPath = JSON.stringify(options.eventsPath ?? "/monitor/events");
  const streamPath = JSON.stringify(options.streamPath ?? "/monitor/stream");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #041d1a;
      --panel: #0a302c;
      --panel-2: #0d3b36;
      --line: #4d766f;
      --text: #f5ead3;
      --muted: #a7b5aa;
      --accent: #ffb02e;
      --ok: #52d273;
      --bad: #ff6b6b;
      --warn: #ffd166;
      --ok-bg: rgba(82, 210, 115, 0.12);
      --bad-bg: rgba(255, 107, 107, 0.12);
      --warn-bg: rgba(255, 209, 102, 0.12);
      --accent-bg: rgba(255, 176, 46, 0.12);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: radial-gradient(circle at top left, #123a35, var(--bg) 34rem);
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
      background: rgba(10, 48, 44, 0.9);
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
      min-height: 24px;
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 2px 8px;
      color: var(--text);
      background: rgba(255, 255, 255, 0.05);
      font-size: 0.82rem;
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
      background: rgba(0, 0, 0, 0.24);
      color: var(--text);
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
    }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>${title}</h1>
        <p id="subtitle">Live private view of agent-to-agent handoffs.<span id="live-status" class="live-status" data-state="connecting">connecting</span></p>
      </div>
      <button id="refresh" type="button">Refresh</button>
    </header>
    <section class="grid" aria-label="Monitor summary">
      <div class="card"><span class="metric">Status</span><span id="status" class="value">...</span></div>
      <div class="card"><span class="metric">Active / Just Finished</span><span id="active-count" class="value">0</span></div>
      <div class="card"><span class="metric">Blocked / Operator Review</span><span id="gate-count" class="value">0 / 0</span></div>
      <div class="card"><span class="metric">Recent</span><span id="recent-count" class="value">0</span></div>
      <div class="card"><span class="metric">Events</span><span id="event-count" class="value">0</span></div>
    </section>
    <div class="section-title"><h2>Live Lane</h2><span id="generated" class="pill">waiting</span></div>
    <section id="active" class="list"><div class="empty">No running or just-finished handoffs.</div></section>
    <div class="section-title"><h2>PR Board</h2><span class="pill">release queue</span></div>
    <section class="pr-board" aria-label="PR board filters">
      <button class="filter-button" type="button" data-pipeline-filter="all" aria-pressed="true"><span class="filter-label">All</span><span id="board-all" class="filter-count">0</span></button>
      <button class="filter-button" type="button" data-pipeline-filter="block" aria-pressed="false"><span class="filter-label">Blocked</span><span id="board-block" class="filter-count">0</span></button>
      <button class="filter-button" type="button" data-pipeline-filter="needs-review" aria-pressed="false"><span class="filter-label">Review</span><span id="board-review" class="filter-count">0</span></button>
      <button class="filter-button" type="button" data-pipeline-filter="pass" aria-pressed="false"><span class="filter-label">Ready</span><span id="board-ready" class="filter-count">0</span></button>
      <button class="filter-button" type="button" data-pipeline-filter="running" aria-pressed="false"><span class="filter-label">Running</span><span id="board-running" class="filter-count">0</span></button>
    </section>
    <section class="staleness-summary" aria-label="PR staleness summary">
      <div class="staleness-card" data-age="fresh"><span class="age-label">Fresh</span><span id="age-fresh" class="age-count">0</span></div>
      <div class="staleness-card" data-age="waiting"><span class="age-label">Waiting</span><span id="age-waiting" class="age-count">0</span></div>
      <div class="staleness-card" data-age="stale"><span class="age-label">Stale</span><span id="age-stale" class="age-count">0</span></div>
    </section>
    <section class="owner-summary" aria-label="Next action owners">
      <div class="owner-card"><span class="owner-label">Codex needs</span><span id="owner-codex" class="owner-count">0</span></div>
      <div class="owner-card"><span class="owner-label">Operator needs</span><span id="owner-human" class="owner-count">0</span></div>
      <div class="owner-card"><span class="owner-label">Merge queue</span><span id="owner-merge" class="owner-count">0</span></div>
      <div class="owner-card"><span class="owner-label">Hermes active</span><span id="owner-hermes" class="owner-count">0</span></div>
    </section>
    <div class="section-title"><h2>Owner Lanes</h2><span class="pill">who acts next</span></div>
    <section id="owner-lanes" class="owner-lanes" aria-label="Owner lanes"><div class="empty">No PR handoffs in the monitor window.</div></section>
    <div class="section-title"><h2>PR Pipeline</h2><span class="pill">grouped by repo</span></div>
    <section id="pipeline" class="pipeline-list"><div class="empty">No PR handoffs in the monitor window.</div></section>
    <div class="section-title"><h2>Release Gate</h2><span class="pill">blocks + operator review</span></div>
    <section id="attention" class="list"><div class="empty">No handoffs need attention.</div></section>
    <div class="section-title"><h2>Release Timeline</h2><span class="pill">auto-refresh 5s</span></div>
    <section id="recent" class="list"><div class="empty">Loading recent handoffs...</div></section>
  </main>
  <script>
    const eventsPath = ${eventsPath};
    const streamPath = ${streamPath};
    const token = new URLSearchParams(location.search).get("token");
    const withToken = buildMonitorUrl(eventsPath);
    const streamUrl = buildMonitorUrl(streamPath);
    const decisionStorageKey = "averray-monitor-human-decisions:v1";
    let pipelineFilter = "all";
    let latestPipelineItems = [];
    let latestPayload = null;
    let monitorDecisions = loadMonitorDecisions();
    let pollTimer = null;
    let streamSource = null;

    document.getElementById("refresh").addEventListener("click", () => load());
    document.addEventListener("click", (event) => {
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
        renderPipeline(latestPipelineItems);
      });
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
      const verdicts = recent.map(releaseVerdict);
      const attention = recent.filter(needsAttention);
      const blocked = verdicts.filter((verdict) => verdict.level === "block").length;
      const review = verdicts.filter((verdict) => verdict.level === "needs-review").length;
      document.getElementById("status").textContent = payload.status || "unknown";
      document.getElementById("active-count").textContent = counts.active || 0;
      document.getElementById("gate-count").textContent = blocked + " / " + review;
      document.getElementById("recent-count").textContent = counts.recent || 0;
      document.getElementById("event-count").textContent = counts.events || 0;
      document.getElementById("generated").textContent = payload.generatedAt ? new Date(payload.generatedAt).toLocaleString() : "unknown";
      renderList("active", payload.active || [], "No running or just-finished handoffs.");
      latestPipelineItems = collectPipelineItems(payload);
      renderPipelineBoard(latestPipelineItems);
      renderOwnerLanes(latestPipelineItems);
      renderPipeline(latestPipelineItems);
      renderList("attention", attention, "No handoffs need attention.");
      renderList("recent", recent, "No recent handoffs in the monitor window.");
    }

    function renderList(id, entries, emptyText) {
      const target = document.getElementById(id);
      if (!entries.length) {
        target.innerHTML = '<div class="empty">' + escapeHtml(emptyText) + '</div>';
        return;
      }
      target.innerHTML = entries.map(renderHandoff).join("");
    }

    function renderPipelineBoard(entries) {
      const verdicts = entries.map(releaseVerdict);
      document.getElementById("board-all").textContent = String(entries.length);
      document.getElementById("board-block").textContent = String(verdicts.filter((verdict) => verdict.level === "block").length);
      document.getElementById("board-review").textContent = String(verdicts.filter((verdict) => verdict.level === "needs-review").length);
      document.getElementById("board-ready").textContent = String(verdicts.filter((verdict) => verdict.level === "pass").length);
      document.getElementById("board-running").textContent = String(verdicts.filter((verdict) => verdict.level === "running").length);
      renderOwnerSummary(entries);
      renderStalenessSummary(entries);
      updatePipelineFilterButtons();
    }

    function renderStalenessSummary(entries) {
      const ages = entries.map(handoffAge);
      document.getElementById("age-fresh").textContent = String(ages.filter((age) => age.state === "fresh").length);
      document.getElementById("age-waiting").textContent = String(ages.filter((age) => age.state === "waiting").length);
      document.getElementById("age-stale").textContent = String(ages.filter((age) => age.state === "stale").length);
    }

    function renderOwnerSummary(entries) {
      const owners = entries.map((item) => nextPipelineAction(item, releaseVerdict(item)).owner);
      document.getElementById("owner-codex").textContent = String(owners.filter((owner) => owner === "Codex").length);
      document.getElementById("owner-human").textContent = String(owners.filter((owner) => owner === "Operator").length);
      document.getElementById("owner-merge").textContent = String(owners.filter((owner) => owner === "Merge queue").length);
      document.getElementById("owner-hermes").textContent = String(owners.filter((owner) => owner === "Hermes").length);
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
        { key: "operator", title: "Operator", owner: "Operator", empty: "No operator review needed." },
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
        '<p class="pipeline-why">' + escapeHtml(verdict.why) + '</p>' +
        '<p class="age-line" data-age="' + escapeAttr(age.state) + '">' + escapeHtml(age.label + " - " + action.owner + " for " + age.duration) + '</p>' +
        '<div class="next-action"><strong>Next action:</strong> ' + escapeHtml(action.owner + " - " + action.text) + '</div>' +
        renderHumanDecisionNote(item) +
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

    function renderHumanDecisionNote(item) {
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
        title: fixRequest.title || (verdict.level === "block" ? "Fix request for Codex" : "Operator decision request"),
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

    function isPrPipelineItem(item) {
      const intent = normalize(item.intent);
      const correlationId = String(item.correlationId || "");
      return Boolean(
        item.pullRequestNumber
        || intent === "pr_handoff"
        || intent === "pr_code_review"
        || correlationId.startsWith("github-pr-")
      );
    }

    function pipelineTitle(item) {
      const repo = item.repo || "unknown repo";
      const prNumber = item.pullRequestNumber || pullRequestNumberFromCorrelation(item.correlationId);
      const intent = item.intent || "pr_handoff";
      return [repo, prNumber ? "#" + prNumber : "", intent].filter(Boolean).join(" ");
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
      const title = [item.repo, item.pullRequestNumber ? "#" + item.pullRequestNumber : "", item.intent].filter(Boolean).join(" ");
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

    function needsAttention(item) {
      const level = releaseVerdict(item).level;
      return level === "block" || level === "needs-review";
    }

    function releaseVerdict(item) {
      const verdict = baseReleaseVerdict(item);
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
      return monitorDecisions[decisionKeyForItem(item)] || {};
    }

    function decisionKeyForItem(item) {
      return String(item.correlationId || [item.repo, item.pullRequestNumber].filter(Boolean).join("#") || "unknown");
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
