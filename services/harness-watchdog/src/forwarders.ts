export type WatchdogSinkState = "configured" | "disabled";

export interface AlertForwarder {
  readonly name: string;
  readonly state: WatchdogSinkState;
  forward(alert: Readonly<Record<string, unknown>>): Promise<void>;
}

export type WatchdogFetch = (
  input: string,
  init: RequestInit,
) => Promise<Pick<Response, "ok" | "status">>;

export type OutboundScrubber = (
  value: Readonly<Record<string, unknown>>,
) => Record<string, unknown>;

const SENSITIVE_KEY = /(?:^|[_-])(?:authorization|token|secret|api[_-]?key|private[_-]?key)(?:$|[_-])/iu;
const AUTHORIZATION_VALUE = /(authorization\s*[:=]\s*)(?:bearer\s+)?(?:"[^"]*"|'[^']*'|[^\s,;}\]]+)/giu;
const SENSITIVE_ASSIGNMENT = /([a-z0-9_.-]*(?:token|secret|api[_-]?key|private[_-]?key)[a-z0-9_.-]*\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}\]]+)/giu;

export function scrubOutboundAlert(
  input: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  return scrubObject(input);
}

export function createSlackForwarder(options: {
  webhookUrl?: string;
  fetchImpl?: WatchdogFetch;
  scrub?: OutboundScrubber;
  timeoutMs?: number;
}): AlertForwarder {
  const webhookUrl = options.webhookUrl?.trim();
  const fetchImpl = options.fetchImpl ?? fetch;
  const scrub = options.scrub ?? scrubOutboundAlert;
  const timeoutMs = options.timeoutMs ?? 5_000;

  return {
    name: "slack",
    state: webhookUrl ? "configured" : "disabled",
    async forward(alert): Promise<void> {
      if (!webhookUrl) return;
      const safeAlert = scrub(alert);
      const response = await fetchImpl(webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: renderSlackText(safeAlert) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        throw new SlackDeliveryError(response.status);
      }
    },
  };
}

export class SlackDeliveryError extends Error {
  constructor(readonly status: number) {
    super(`Slack webhook refused the watchdog alert with HTTP ${status}`);
    this.name = "SlackDeliveryError";
  }
}

function renderSlackText(alert: Readonly<Record<string, unknown>>): string {
  const severity = stringField(alert.severity, "warn").toUpperCase();
  const code = stringField(alert.code, "watchdog_alert");
  const message = stringField(alert.message, "Watchdog alert details unavailable.");
  return `[HARNESS WATCHDOG ${severity}] ${code}: ${message}`;
}

function scrubObject(
  input: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).map(([key, value]) => [
    key,
    SENSITIVE_KEY.test(key) ? "[REDACTED]" : scrubValue(value),
  ]));
}

function scrubValue(value: unknown): unknown {
  if (typeof value === "string") return scrubText(value);
  if (Array.isArray(value)) return value.map(scrubValue);
  if (isRecord(value)) return scrubObject(value);
  return value;
}

function scrubText(value: string): string {
  return value
    .replace(AUTHORIZATION_VALUE, "$1[REDACTED]")
    .replace(SENSITIVE_ASSIGNMENT, "$1[REDACTED]");
}

function stringField(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
