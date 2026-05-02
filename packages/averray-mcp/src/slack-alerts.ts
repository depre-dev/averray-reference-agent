import { logger, optionalEnv } from "@avg/mcp-common";

export type SlackSeverity = "info" | "success" | "warning" | "error";

export type SlackAlertKind =
  | "claim_precheck_passed"
  | "claim_blocked"
  | "claim_succeeded"
  | "claim_failed"
  | "submit_validation_failed"
  | "submit_blocked"
  | "submit_succeeded"
  | "submit_failed"
  | "ttl_nearing_expiry"
  | "inventory_exhausted"
  | "inventory_replenished";

export interface SlackAlert {
  kind: SlackAlertKind;
  severity?: SlackSeverity;
  title: string;
  identifiers?: Record<string, unknown>;
  details?: Record<string, unknown>;
}

export interface SlackPayload {
  text: string;
}

const MAX_FIELD_LENGTH = 320;
const MAX_TEXT_LENGTH = 3500;
const SECRET_KEY_RE = /(?:private.?key|secret|token|authorization|jwt|password|mnemonic|signature|webhook)/iu;

const SEVERITY_ICON: Record<SlackSeverity, string> = {
  info: "[info]",
  success: "[ok]",
  warning: "[warn]",
  error: "[error]",
};

export async function postSlackAlert(alert: SlackAlert, webhookUrl = optionalEnv("SLACK_WEBHOOK_URL")) {
  if (!webhookUrl) return;
  const payload = buildSlackPayload(alert);
  try {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      logger.warn({ status: response.status, kind: alert.kind }, "slack_post_failed");
    }
  } catch (error) {
    logger.warn({ err: error, kind: alert.kind }, "slack_post_failed");
  }
}

export function buildSlackPayload(alert: SlackAlert): SlackPayload {
  const severity = alert.severity ?? severityForKind(alert.kind);
  const lines = [
    `${SEVERITY_ICON[severity]} *Averray reference agent*: ${alert.title}`,
    `event: \`${alert.kind}\``,
    ...formatRecord("ids", alert.identifiers),
    ...formatRecord("details", alert.details),
  ];
  return { text: truncate(lines.join("\n"), MAX_TEXT_LENGTH) };
}

export function validationFailureDetails(validation: unknown) {
  const record = asRecord(validation);
  const errors = Array.isArray(record.errors) ? record.errors.slice(0, 6) : [];
  const paths = errors
    .map((entry) => asRecord(entry).path)
    .filter((path): path is string => typeof path === "string" && path.length > 0);
  const messages = errors
    .map((entry) => {
      const error = asRecord(entry);
      const path = typeof error.path === "string" ? error.path : "(unknown)";
      const message = typeof error.message === "string" ? error.message : "invalid";
      return `${path}: ${message}`;
    })
    .filter(Boolean);
  return {
    validator: record.validator,
    taskType: record.taskType,
    errorCount: Array.isArray(record.errors) ? record.errors.length : 0,
    paths,
    messages,
  };
}

function formatRecord(label: string, value: Record<string, unknown> | undefined): string[] {
  if (!value || Object.keys(value).length === 0) return [];
  const lines = [`*${label}*`];
  for (const [key, raw] of Object.entries(value)) {
    const sanitized = sanitizeValue(key, raw);
    if (sanitized === undefined || sanitized === null || sanitized === "") continue;
    lines.push(`- ${key}: ${formatValue(sanitized)}`);
  }
  return lines;
}

function sanitizeValue(key: string, value: unknown): unknown {
  if (SECRET_KEY_RE.test(key)) return "[redacted]";
  if (Array.isArray(value)) {
    return value.slice(0, 8).map((item) => sanitizeValue(key, item));
  }
  if (isRecord(value)) {
    const next: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      next[childKey] = sanitizeValue(childKey, childValue);
    }
    return next;
  }
  if (typeof value === "string") return truncate(redactInlineSecrets(value), MAX_FIELD_LENGTH);
  return value;
}

function formatValue(value: unknown): string {
  if (Array.isArray(value)) return value.map((entry) => `\`${escapeSlack(String(entry))}\``).join(", ");
  if (isRecord(value)) return `\`${escapeSlack(JSON.stringify(value))}\``;
  return `\`${escapeSlack(String(value))}\``;
}

function severityForKind(kind: SlackAlertKind): SlackSeverity {
  if (kind.endsWith("_succeeded") || kind === "claim_precheck_passed" || kind === "inventory_replenished") {
    return "success";
  }
  if (kind.endsWith("_failed")) return "error";
  if (kind.endsWith("_blocked") || kind === "submit_validation_failed" || kind === "ttl_nearing_expiry" || kind === "inventory_exhausted") {
    return "warning";
  }
  return "info";
}

function redactInlineSecrets(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gu, "Bearer [redacted]")
    .replace(/0x[a-f0-9]{64}/giu, "[redacted-hex-secret]");
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 3))}...`;
}

function escapeSlack(value: string): string {
  return value.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
