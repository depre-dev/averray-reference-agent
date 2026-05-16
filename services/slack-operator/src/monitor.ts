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

export function renderMonitorHtml(options: { title?: string; eventsPath?: string } = {}): string {
  const title = escapeHtml(options.title ?? "Hermes Handoff Monitor");
  const eventsPath = JSON.stringify(options.eventsPath ?? "/monitor/events");
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
      .pipeline-steps,
      .pipeline-meta { grid-template-columns: 1fr; }
      dl { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>${title}</h1>
        <p id="subtitle">Live private view of agent-to-agent handoffs.</p>
      </div>
      <button id="refresh" type="button">Refresh</button>
    </header>
    <section class="grid" aria-label="Monitor summary">
      <div class="card"><span class="metric">Status</span><span id="status" class="value">...</span></div>
      <div class="card"><span class="metric">Active / Just Finished</span><span id="active-count" class="value">0</span></div>
      <div class="card"><span class="metric">Blocked / Human Review</span><span id="gate-count" class="value">0 / 0</span></div>
      <div class="card"><span class="metric">Recent</span><span id="recent-count" class="value">0</span></div>
      <div class="card"><span class="metric">Events</span><span id="event-count" class="value">0</span></div>
    </section>
    <div class="section-title"><h2>Live Lane</h2><span id="generated" class="pill">waiting</span></div>
    <section id="active" class="list"><div class="empty">No running or just-finished handoffs.</div></section>
    <div class="section-title"><h2>PR Pipeline</h2><span class="pill">stage view</span></div>
    <section id="pipeline" class="pipeline-list"><div class="empty">No PR handoffs in the monitor window.</div></section>
    <div class="section-title"><h2>Release Gate</h2><span class="pill">blocks + human review</span></div>
    <section id="attention" class="list"><div class="empty">No handoffs need attention.</div></section>
    <div class="section-title"><h2>Release Timeline</h2><span class="pill">auto-refresh 5s</span></div>
    <section id="recent" class="list"><div class="empty">Loading recent handoffs...</div></section>
  </main>
  <script>
    const eventsPath = ${eventsPath};
    const token = new URLSearchParams(location.search).get("token");
    const withToken = buildEventsUrl();

    document.getElementById("refresh").addEventListener("click", () => load());
    load();
    setInterval(load, 5000);

    async function load() {
      try {
        const response = await fetch(withToken, { cache: "no-store" });
        if (!response.ok) throw new Error("HTTP " + response.status);
        render(await response.json());
      } catch (error) {
        document.getElementById("recent").innerHTML = '<div class="empty error">Monitor unavailable: ' + escapeHtml(String(error.message || error)) + '</div>';
      }
    }

    function render(payload) {
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
      renderPipeline(collectPipelineItems(payload));
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

    function renderPipeline(entries) {
      const target = document.getElementById("pipeline");
      if (!entries.length) {
        target.innerHTML = '<div class="empty">No PR handoffs in the monitor window.</div>';
        return;
      }
      target.innerHTML = entries.slice(0, 12).map(renderPipelineItem).join("");
    }

    function renderPipelineItem(item) {
      const summary = item.summary || {};
      const verdict = releaseVerdict(item);
      const stage = pipelineStage(item, verdict);
      const actor = nextPipelineActor(item, verdict);
      const prUrl = item.pullRequestUrl || derivePullRequestUrl(item);
      const commitUrl = deriveCommitUrl(item);
      const workflowRunUrl = deriveWorkflowRunUrl(item);
      const title = pipelineTitle(item);
      const links = [
        prUrl ? '<a class="pill" href="' + escapeAttr(prUrl) + '" target="_blank" rel="noreferrer">open PR</a>' : "",
        workflowRunUrl ? '<a class="pill" href="' + escapeAttr(workflowRunUrl) + '" target="_blank" rel="noreferrer">open run</a>' : "",
        commitUrl ? '<a class="pill" href="' + escapeAttr(commitUrl) + '" target="_blank" rel="noreferrer">open commit</a>' : "",
      ].filter(Boolean).join("");
      return '<article class="pipeline-card" data-verdict="' + escapeAttr(verdict.level) + '">' +
        '<div class="pipeline-head"><div class="pipeline-title">' + escapeHtml(title) + '</div><span class="pill state-pill" data-level="' + escapeAttr(verdict.level) + '">' + escapeHtml(verdict.label) + '</span></div>' +
        '<p class="pipeline-why">' + escapeHtml(releaseReason(summary, item, verdict.level)) + '</p>' +
        renderPipelineSteps(stage, verdict) +
        '<dl class="pipeline-meta">' +
        row("Stage", escapeHtml(stage.label)) +
        row("Next actor", escapeHtml(actor)) +
        row("Updated", escapeHtml(item.updatedAt ? new Date(item.updatedAt).toLocaleString() : "unknown")) +
        row("Correlation", "<code>" + escapeHtml(item.correlationId || "unknown") + "</code>") +
        '</dl>' +
        (links ? '<div class="pipeline-links">' + links + '</div>' : "") +
        '</article>';
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
      if (item.active === true || item.activeState === "running" || status === "running") {
        return { key: "hermes", label: "Hermes reviewing" };
      }
      if (verdict.level === "block") return { key: "gate", label: "Blocked at gate" };
      if (verdict.level === "needs-review") return { key: "gate", label: "Human review" };
      if (verdict.level === "pass") return { key: "gate", label: "Ready for merge" };
      return { key: "ci", label: "CI / handoff" };
    }

    function nextPipelineActor(item, verdict) {
      const status = normalize(item.status);
      if (item.active === true || item.activeState === "running" || status === "running") return "Hermes";
      if (verdict.level === "block") return "Codex";
      if (verdict.level === "needs-review") return "Human owner";
      if (verdict.level === "pass") return "Merge queue";
      return "GitHub Actions";
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

    function buildEventsUrl() {
      const separator = eventsPath.includes("?") ? "&" : "?";
      const params = new URLSearchParams({
        limit: "50",
        activeWindowMinutes: "240"
      });
      if (token) params.set("token", token);
      return eventsPath + separator + params.toString();
    }

    function needsAttention(item) {
      const level = releaseVerdict(item).level;
      return level === "block" || level === "needs-review";
    }

    function releaseVerdict(item) {
      const summary = item.summary || {};
      const status = normalize(item.status);
      const finalVerdict = normalize(summary.finalVerdict || summary.status);
      const mergeRecommendation = normalize(summary.mergeRecommendation);
      const reason = normalize(summary.finalReason || summary.reason || item.reason);
      const reviewReasons = Array.isArray(summary.reviewReasons) ? summary.reviewReasons : [];

      if (status === "running") {
        return { level: "running", label: "RUNNING", why: releaseReason(summary, item, "running") };
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
        return { level: "needs-review", label: "HUMAN REVIEW" };
      }
      return { level: "pass", label: "PASS" };
    }

    function releaseReason(summary, item, level) {
      const reviewReasons = Array.isArray(summary.reviewReasons) ? summary.reviewReasons : [];
      const first = reviewReasons.find(Boolean);
      if (first) {
        const code = String(first.code || "review");
        const message = String(first.message || "Human review recommended.");
        return code + ": " + message;
      }
      const reason = normalize(summary.finalReason || summary.reason || item.reason);
      if (reason === "github_needs_review") return "Human review recommended by the GitHub risk gate.";
      if (reason === "pr_review_hold") return "PR risk gate held this for human review.";
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
        const message = reason && reason.message ? String(reason.message) : "Human review recommended.";
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
