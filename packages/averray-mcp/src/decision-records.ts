export type HermesDecisionKind =
  | "routing"
  | "auto_approval"
  | "escalation"
  | "anomaly_pause"
  | "away_digest";

export type HermesDecisionSubjectType =
  | "task"
  | "card"
  | "repo"
  | "pr"
  | "mission"
  | "digest"
  | "autopilot_session";

export interface HermesDecisionSubject {
  type: HermesDecisionSubjectType;
  id: string;
  repo?: string;
  pullRequestNumber?: number;
}

export interface HermesDecisionOutcome {
  summary: string;
  waitingNext?: string;
  changed?: string[];
}

export interface HermesDecisionSafety {
  readOnly: boolean;
  mutates: boolean;
  mutatesGithub?: boolean;
  mutatesAverray?: boolean;
  editsWikipedia?: boolean;
}

export interface HermesDecisionRecord {
  schemaVersion: 1;
  recordType: "hermes_decision_record";
  id: string;
  kind: HermesDecisionKind;
  subject: HermesDecisionSubject;
  decision: string;
  reasons: string[];
  inputs: Record<string, unknown>;
  outcome: HermesDecisionOutcome;
  safety: HermesDecisionSafety;
  generatedAt: string;
}

export interface CreateHermesDecisionRecordInput {
  kind: HermesDecisionKind;
  subject: HermesDecisionSubject;
  decision: string;
  reasons: string[];
  inputs?: Record<string, unknown>;
  outcome: HermesDecisionOutcome;
  safety: HermesDecisionSafety;
  generatedAt?: Date | string;
}

export interface ExtendHermesDecisionRecordInput {
  inputs?: Record<string, unknown>;
  reasons?: string[];
  outcome?: HermesDecisionOutcome;
  safety?: HermesDecisionSafety;
}

const SECRET_KEY_PATTERN = /(token|secret|private.?key|password|credential|mnemonic|authorization|cookie|webhook|api.?key|bearer)/i;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const PRIVATE_KEY_PATTERN = /\b(?:private[_ -]?key|secret|token|password)\s*[:=]\s*([^\s,;]+)/gi;
const OPENAI_KEY_PATTERN = /\bsk-[A-Za-z0-9_-]{16,}\b/g;

export function createHermesDecisionRecord(input: CreateHermesDecisionRecordInput): HermesDecisionRecord {
  const generatedAt = normalizeGeneratedAt(input.generatedAt);
  const subject = sanitizeSubject(input.subject);
  return {
    schemaVersion: 1,
    recordType: "hermes_decision_record",
    id: decisionRecordId(input.kind, subject, generatedAt),
    kind: input.kind,
    subject,
    decision: sanitizeText(input.decision) || input.kind,
    reasons: normalizeReasons(input.reasons),
    inputs: sanitizeDecisionValue(input.inputs ?? {}) as Record<string, unknown>,
    outcome: sanitizeOutcome(input.outcome),
    safety: sanitizeSafety(input.safety),
    generatedAt,
  };
}

export function extendHermesDecisionRecord(
  record: HermesDecisionRecord,
  patch: ExtendHermesDecisionRecordInput,
): HermesDecisionRecord {
  const next = createHermesDecisionRecord({
    kind: record.kind,
    subject: record.subject,
    decision: record.decision,
    reasons: patch.reasons ?? record.reasons,
    inputs: {
      ...record.inputs,
      ...(patch.inputs ?? {}),
    },
    outcome: patch.outcome ?? record.outcome,
    safety: patch.safety ?? record.safety,
    generatedAt: record.generatedAt,
  });
  return { ...next, id: record.id };
}

export function whyHermesLine(record: HermesDecisionRecord): string {
  const reason = record.reasons[0] ?? record.outcome.summary;
  return `Why Hermes did this: ${reason}`;
}

export function isHermesDecisionRecord(value: unknown): value is HermesDecisionRecord {
  if (!isRecord(value)) return false;
  return value.schemaVersion === 1
    && value.recordType === "hermes_decision_record"
    && typeof value.id === "string"
    && isDecisionKind(value.kind)
    && isRecord(value.subject)
    && typeof value.decision === "string"
    && Array.isArray(value.reasons)
    && isRecord(value.inputs)
    && isRecord(value.outcome)
    && isRecord(value.safety)
    && typeof value.generatedAt === "string";
}

export function sanitizeDecisionValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => sanitizeDecisionValue(item));
  }
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, field] of Object.entries(value)) {
      out[key] = SECRET_KEY_PATTERN.test(key) ? "[redacted]" : sanitizeDecisionValue(field);
    }
    return out;
  }
  if (typeof value === "string") return sanitizeText(value);
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean" || value === null || value === undefined) return value ?? null;
  return String(value);
}

function normalizeGeneratedAt(value: Date | string | undefined): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && Number.isFinite(Date.parse(value))) return new Date(value).toISOString();
  return new Date().toISOString();
}

function sanitizeSubject(subject: HermesDecisionSubject): HermesDecisionSubject {
  return {
    type: subject.type,
    id: sanitizeText(subject.id) || "unknown",
    ...(subject.repo ? { repo: sanitizeText(subject.repo) } : {}),
    ...(typeof subject.pullRequestNumber === "number" && Number.isFinite(subject.pullRequestNumber)
      ? { pullRequestNumber: subject.pullRequestNumber }
      : {}),
  };
}

function normalizeReasons(reasons: string[]): string[] {
  const normalized = reasons
    .map(sanitizeText)
    .map((reason) => reason.trim())
    .filter(Boolean)
    .slice(0, 8);
  return normalized.length > 0 ? normalized : ["Hermes recorded the decision for operator review."];
}

function sanitizeOutcome(outcome: HermesDecisionOutcome): HermesDecisionOutcome {
  return {
    summary: sanitizeText(outcome.summary) || "Decision recorded.",
    ...(outcome.waitingNext ? { waitingNext: sanitizeText(outcome.waitingNext) } : {}),
    ...(outcome.changed ? { changed: outcome.changed.map(sanitizeText).filter(Boolean).slice(0, 10) } : {}),
  };
}

function sanitizeSafety(safety: HermesDecisionSafety): HermesDecisionSafety {
  return {
    readOnly: safety.readOnly === true,
    mutates: safety.mutates === true,
    ...(safety.mutatesGithub !== undefined ? { mutatesGithub: safety.mutatesGithub === true } : {}),
    ...(safety.mutatesAverray !== undefined ? { mutatesAverray: safety.mutatesAverray === true } : {}),
    ...(safety.editsWikipedia !== undefined ? { editsWikipedia: safety.editsWikipedia === true } : {}),
  };
}

function sanitizeText(value: string): string {
  return value
    .replace(BEARER_PATTERN, "Bearer [redacted]")
    .replace(PRIVATE_KEY_PATTERN, (match) => match.replace(/[:=]\s*[^\s,;]+/, ": [redacted]"))
    .replace(OPENAI_KEY_PATTERN, "sk-[redacted]")
    .slice(0, 2_000);
}

function decisionRecordId(kind: HermesDecisionKind, subject: HermesDecisionSubject, generatedAt: string): string {
  const slug = `${kind}-${subject.type}-${subject.id}-${generatedAt}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 120);
  return `hdr-${slug || "decision"}`;
}

function isDecisionKind(value: unknown): value is HermesDecisionKind {
  return value === "routing"
    || value === "auto_approval"
    || value === "escalation"
    || value === "anomaly_pause"
    || value === "away_digest";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
