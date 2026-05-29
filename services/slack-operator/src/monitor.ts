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
  if (isTestbedMissionMonitorCommand(text) && isTestbedMutationModeText(text)) {
    return /\b(merge\s+(pr|#|now)|deploy(?! for)|rollback(?! for)|restart|rotate|set secret|secret set|ssh|claim)\b/.test(text)
      || /\bwikipedia citation repair\b/.test(text);
  }
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
    || isTestbedMissionMonitorCommand(text)
    || /^run testbed e2e read[ -]?only( details?| full| audit)?$/.test(text)
  );
}

function isTestbedMissionMonitorCommand(text: string): boolean {
  return /^(testbed agent mission|agent testbed mission|agent browser mission|browser mission|fresh agent mission|fresh agent page test|out of box agent test|out-of-box agent test|normal agent page test|can hermes test the page|test page as fresh agent)(\b.*)?$/.test(text);
}

function isTestbedMutationModeText(text: string): boolean {
  return /\b(test mode|test-mode|sandbox|fake|demo|allow test mutation|allow test mutations|test mutation allowed|test mutations allowed|may submit|can submit)\b/.test(text);
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

function nonEmpty(value: string | undefined): string | undefined {
  return value && value.length > 0 ? value : undefined;
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
