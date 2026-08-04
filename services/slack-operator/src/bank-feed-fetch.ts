// Reading the Bank lane feed off the backend's internal endpoint.
//
// This is the ONLY place the two services touch. Everything that arrives here
// crossed a network from a different repo on a different release cadence, so
// none of it is trusted: the shape is checked, and anything that does not
// check out becomes a stated reason rather than a rendered number.
//
// ── WHY VALIDATE WHAT WE SPECIFIED ────────────────────────────────────────
//
// We wrote the contract, the producer implements it, and both sides have
// tests. That makes drift unlikely, not impossible — the two ship
// independently, and the failure mode of an unvalidated field is silent: a
// `raw` that arrives as a NUMBER instead of a decimal string still renders,
// just with the precision loss the string was there to prevent. A shape check
// costs nothing and turns a silent wrong number into a visible refusal.
//
// ── ABSENT IS NOT BROKEN ──────────────────────────────────────────────────
//
// No URL configured means the lane is not wired, which is a fact about setup
// and not a fault. It returns `undefined`, the lane renders nothing at all,
// and the board stays quiet. Only a CONFIGURED feed that fails is a problem
// worth a line on screen.

import type { BankFeed, BankRequest, BankRequests, BankSubject, SourcedRead } from "./bank-feed.js";

export interface BankFeedRead {
  feed?: BankFeed;
  /** Set when the feed is configured but could not be read or understood. */
  reason?: string;
}

/** A read that takes longer than this is not going to help this heartbeat. */
export const BANK_FEED_TIMEOUT_MS = 4000;

export async function readBankFeed(input: {
  /** Internal URL of the backend's read-only feed. Empty ⇒ not wired. */
  url: string;
  fetchImpl: typeof fetch;
  timeoutMs?: number;
}): Promise<BankFeedRead> {
  if (!input.url) return {}; // not wired — not a fault, and not a lane
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? BANK_FEED_TIMEOUT_MS);
  try {
    const res = await input.fetchImpl(input.url, { signal: controller.signal });
    if (!res.ok) return { reason: `bank feed returned HTTP ${res.status}` };
    const body: unknown = await res.json();
    return normalizeBankFeed(body);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { reason: `bank feed unreachable — ${message}` };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Shape-check the payload. Exported so the check is testable without a server.
 *
 * Every rejection names the field, because "malformed" on its own sends the
 * reader to the wrong repo.
 */
export function normalizeBankFeed(body: unknown): BankFeedRead {
  if (!body || typeof body !== "object") return { reason: "bank feed was not an object" };
  const b = body as Record<string, unknown>;

  const position = sourcedRead(b.position, "position");
  if ("reason" in position) return position;
  const float = sourcedRead(b.float, "float");
  if ("reason" in float) return float;
  const postage = sourcedRead(b.postage, "postage");
  if ("reason" in postage) return postage;
  const requests = requestsBlock(b.requests);
  if ("reason" in requests) return requests;

  const calibration = calibrationRecord(b.calibration);
  const subject = subjectRecord(b.subject);
  return {
    feed: {
      position: position.read,
      float: float.read,
      postage: postage.read,
      requests: requests.requests,
      ...(calibration ? { calibration } : {}),
      ...(subject ? { subject } : {}),
    },
  };
}

/**
 * A malformed subject is dropped, never guessed at.
 *
 * Dropping it costs the lane's visible "cannot confirm which generation" line,
 * and it self-corrects on the next good read. Inventing either half would be
 * worse in both directions: a fabricated match is exactly the confident green
 * about an abandoned account this field exists to prevent, and a fabricated
 * mismatch is a RED that stops a lane which is actually fine.
 *
 * Both halves are required together — a subject that names only what it read,
 * with nothing to compare against, cannot answer the one question it is for.
 */
function subjectRecord(raw: unknown): BankSubject | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const s = raw as Record<string, unknown>;
  if (typeof s.derivedFrom !== "string" || !s.derivedFrom.trim()) return undefined;
  if (typeof s.declared !== "string" || !s.declared.trim()) return undefined;
  return {
    derivedFrom: s.derivedFrom,
    declared: s.declared,
    ...(typeof s.label === "string" && s.label ? { label: s.label } : {}),
  };
}

function sourcedRead(raw: unknown, field: string): { read: SourcedRead } | { reason: string } {
  if (!raw || typeof raw !== "object") return { reason: `bank feed ${field} is missing` };
  const r = raw as Record<string, unknown>;
  if (typeof r.source !== "string" || !r.source) return { reason: `bank feed ${field} has no source` };
  // A NUMBER here is the dangerous case: it would render, having already lost
  // precision on the way. Refuse it rather than display it.
  if (r.raw !== null && !(typeof r.raw === "string" && /^\d+$/.test(r.raw))) {
    return { reason: `bank feed ${field}.raw must be a decimal string or null` };
  }
  if (r.readAtMs !== null && typeof r.readAtMs !== "number") {
    return { reason: `bank feed ${field}.readAtMs must be a number or null` };
  }
  return {
    read: {
      raw: (r.raw as string | null) ?? null,
      source: r.source,
      readAtMs: (r.readAtMs as number | null) ?? null,
      ...(typeof r.lastError === "string" ? { lastError: r.lastError } : {}),
    },
  };
}

function requestsBlock(raw: unknown): { requests: BankRequests } | { reason: string } {
  if (!raw || typeof raw !== "object") return { reason: "bank feed requests is missing" };
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.items)) return { reason: "bank feed requests.items is not an array" };
  if (r.readAtMs !== null && typeof r.readAtMs !== "number") {
    return { reason: "bank feed requests.readAtMs must be a number or null" };
  }
  const items: BankRequest[] = [];
  for (const entry of r.items) {
    if (!entry || typeof entry !== "object") return { reason: "bank feed request entry is not an object" };
    const e = entry as Record<string, unknown>;
    if (typeof e.id !== "string" || typeof e.phase !== "string") {
      return { reason: "bank feed request entry needs a string id and phase" };
    }
    if (typeof e.ageSeconds !== "number" || typeof e.overdue !== "boolean") {
      return { reason: `bank feed request ${e.id} needs numeric ageSeconds and boolean overdue` };
    }
    const reconciliation = terminalReconciliation(e.reconciliation);
    items.push({
      id: e.id,
      kind: typeof e.kind === "string" ? e.kind : "unknown",
      // Passed through verbatim. The vocabulary belongs to the observer and
      // the renderer flags anything it does not recognise.
      phase: e.phase,
      ageSeconds: e.ageSeconds,
      overdue: e.overdue,
      ...(typeof e.status === "string" ? { status: e.status } : {}),
      ...(reconciliation ? { reconciliation } : {}),
    });
  }
  return {
    requests: {
      items,
      readAtMs: (r.readAtMs as number | null) ?? null,
      ...(typeof r.lastError === "string" ? { lastError: r.lastError } : {}),
    },
  };
}

function terminalReconciliation(raw: unknown): BankRequest["reconciliation"] | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const keys = [
    "stagedRaw",
    "leg1TransferFeeRaw",
    "trappedWriteOff3Raw",
    "unexplainedRaw",
  ] as const;
  if (keys.some((key) => typeof r[key] !== "string" || !/^\d+$/.test(r[key]))) return undefined;
  if (typeof r.artifactLabel !== "string" || !r.artifactLabel.trim()) return undefined;
  const remoteShape = typeof r.remoteRecoverableRaw === "string" && /^\d+$/.test(r.remoteRecoverableRaw);
  const finalKeys = [
    "actualTreasuryReturnRaw",
    "recoveryReturnFeeRaw",
    "finalRawRecoverySlotResidueRaw",
  ] as const;
  const finalShape = finalKeys.every((key) => typeof r[key] === "string" && /^\d+$/.test(r[key]));
  if (!remoteShape && !finalShape) return undefined;
  return {
    stagedRaw: r.stagedRaw as string,
    leg1TransferFeeRaw: r.leg1TransferFeeRaw as string,
    trappedWriteOff3Raw: r.trappedWriteOff3Raw as string,
    unexplainedRaw: r.unexplainedRaw as string,
    artifactLabel: r.artifactLabel,
    ...(remoteShape ? { remoteRecoverableRaw: r.remoteRecoverableRaw as string } : {}),
    ...(finalShape ? {
      actualTreasuryReturnRaw: r.actualTreasuryReturnRaw as string,
      recoveryReturnFeeRaw: r.recoveryReturnFeeRaw as string,
      finalRawRecoverySlotResidueRaw: r.finalRawRecoverySlotResidueRaw as string,
    } : {}),
  };
}

/**
 * A malformed calibration is dropped, never repaired.
 *
 * Dropping it costs a zero rendering as `unverified` — conservative, and it
 * self-corrects on the next good read. Repairing it would mean inventing the
 * proof that a read path works, which is the one thing this record exists to
 * refuse.
 */
function calibrationRecord(raw: unknown): BankFeed["calibration"] {
  if (!raw || typeof raw !== "object") return null;
  const c = raw as Record<string, unknown>;
  if (typeof c.provenSource !== "string" || !c.provenSource) return null;
  if (typeof c.provenAtMs !== "number") return null;
  if (typeof c.provenRaw !== "string" || !/^\d+$/.test(c.provenRaw)) return null;
  try {
    if (BigInt(c.provenRaw) <= 0n) return null; // a zero proves nothing
  } catch {
    return null;
  }
  return { provenAtMs: c.provenAtMs, provenRaw: c.provenRaw, provenSource: c.provenSource };
}
