// A credential that expires on a Thursday is an outage scheduled in advance.
//
// Nothing on this board watches for one. The probes cover chain, money, API and
// the monitor's own freshness; a TLS certificate lapsing or a token going cold
// looks like none of those until the moment it takes the product down, and then
// it looks like everything at once.
//
// ── OBSERVED, NEVER DECLARED ──────────────────────────────────────────────
//
// The obvious implementation is a list of dates in a file. This deliberately
// has none. A written date is a CLAIM about a credential; it is right on the
// day it is written and silently wrong from the next rotation onward — and a
// stale date here fails in the worst direction, reporting "expires in 60 days"
// about a token replaced last week. 2026-08-04 cost most of a day to exactly
// that class of error, three times over, in three unrelated files.
//
// So every reading here comes from the artefact itself: a JWT's own `exp`, a
// certificate's own `notAfter`, GitHub's own expiry header. If a credential
// cannot say when it expires, this reports that it cannot — which is true, and
// more useful than a number nobody re-checked.

import { connect as tlsConnect } from "node:tls";

/** One credential's expiry, as OBSERVED from the credential itself. */
export interface CredentialExpiry {
  /** Operator-facing name — what to go and rotate. */
  label: string;
  /** Where the reading came from, so a wrong answer is traceable. */
  source: string;
  /** Epoch ms of expiry, or null when the artefact does not declare one. */
  expiresAtMs: number | null;
  /** Why it could not be read. Null expiry + no reason is "no expiry declared". */
  unreadable?: string | null;
}

export type ExpiryTone = "ok" | "degraded" | "red" | "awaiting";

export interface ExpiryLine {
  text: string;
  tone: ExpiryTone;
}

/**
 * Two thresholds, chosen for how long the fix actually takes.
 *
 * RED at 3 days: rotating an admin credential is a ceremony — find the runbook,
 * mint on the right EOA, update the secret at the scope consumers read, verify.
 * That is not a thing to discover on the morning it expires.
 *
 * DEGRADED at 14 days: enough warning to schedule it, not so much that the line
 * sits amber for a month and becomes furniture. A permanently-lit warning is one
 * nobody reads, which is how the credential expires anyway.
 */
export const EXPIRY_RED_MS = 3 * 24 * 60 * 60 * 1000;
export const EXPIRY_WARN_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * A JWT's own `exp`, in ms — or null if it does not have one.
 *
 * The signature is NOT verified, and that is correct here rather than lazy: we
 * are reporting what the token claims about itself, and the server that accepts
 * it reads the same unverified-by-us claim. A token whose `exp` we cannot parse
 * is reported as unreadable, never as "fine".
 */
export function jwtExpiryMs(token: string): number | null {
  const parts = token.trim().split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = parts[1]!.replace(/-/g, "+").replace(/_/g, "/");
    const json = JSON.parse(Buffer.from(payload, "base64").toString("utf8")) as Record<string, unknown>;
    const exp = json.exp;
    if (typeof exp !== "number" || !Number.isFinite(exp)) return null;
    // `exp` is seconds since epoch (RFC 7519). Treating it as ms would put every
    // token in 1970 and report everything as long expired — a false red on every
    // credential at once, which is the fastest way to teach an operator to
    // ignore this probe entirely.
    return exp * 1000;
  } catch {
    return null;
  }
}

/** Days remaining, rounded down — "expires in 0 days" means today. */
export function daysUntil(expiresAtMs: number, nowMs: number): number {
  return Math.floor((expiresAtMs - nowMs) / (24 * 60 * 60 * 1000));
}

/**
 * One credential's line.
 *
 * An unreadable credential is `awaiting`, never `ok`: not knowing when
 * something expires is a different fact from knowing it is fine, and the whole
 * point of this probe is that the second one is worth acting on.
 */
export function expiryLine(input: {
  credential: CredentialExpiry;
  nowMs: number;
  redWithinMs?: number;
  warnWithinMs?: number;
}): ExpiryLine {
  const { credential: c, nowMs } = input;
  const red = input.redWithinMs ?? EXPIRY_RED_MS;
  const warn = input.warnWithinMs ?? EXPIRY_WARN_MS;

  if (c.unreadable) {
    return { text: `${c.label} — expiry unreadable (${c.unreadable})`, tone: "awaiting" };
  }
  if (c.expiresAtMs === null) {
    return { text: `${c.label} — no expiry declared by ${c.source}`, tone: "awaiting" };
  }

  const remaining = c.expiresAtMs - nowMs;
  const days = daysUntil(c.expiresAtMs, nowMs);
  if (remaining <= 0) {
    // Past tense on purpose. "expires in -2 days" is a number an eye slides off.
    return { text: `${c.label} — EXPIRED ${Math.abs(days)}d ago (${c.source})`, tone: "red" };
  }
  if (remaining <= red) {
    return { text: `${c.label} — EXPIRES IN ${days}d (${c.source})`, tone: "red" };
  }
  if (remaining <= warn) {
    return { text: `${c.label} — expires in ${days}d (${c.source})`, tone: "degraded" };
  }
  return { text: `${c.label} — ${days}d left`, tone: "ok" };
}

const TONE_RANK: Record<ExpiryTone, number> = { ok: 0, awaiting: 1, degraded: 2, red: 3 };

/**
 * The probe's verdict over every credential.
 *
 * Worst tone wins, and the detail LEADS with whatever earned it. An operator
 * reading one line must get the credential that is about to expire, not the
 * alphabetically first one — the same reason the Bank lane hoists its overdue
 * request above the rows.
 */
export function credentialExpiryProbe(input: {
  credentials: CredentialExpiry[];
  nowMs: number;
  redWithinMs?: number;
  warnWithinMs?: number;
}): { status: "ok" | "degraded" | "red"; detail: string } {
  if (input.credentials.length === 0) {
    // Nothing observable is not the same as nothing to worry about, and this
    // probe must not report a clean bill of health for a check it never ran.
    return { status: "degraded", detail: "no credentials observable — nothing is watching expiries" };
  }

  const lines = input.credentials.map((credential) =>
    expiryLine({
      credential,
      nowMs: input.nowMs,
      ...(input.redWithinMs !== undefined ? { redWithinMs: input.redWithinMs } : {}),
      ...(input.warnWithinMs !== undefined ? { warnWithinMs: input.warnWithinMs } : {}),
    }),
  );
  const sorted = [...lines].sort((a, b) => TONE_RANK[b.tone] - TONE_RANK[a.tone]);
  const worst = sorted[0]!.tone;

  // `awaiting` is degraded at probe level: a credential whose expiry cannot be
  // read is an unwatched credential, and this probe exists precisely so that
  // nothing sits unwatched.
  const status = worst === "red" ? "red" : worst === "ok" ? "ok" : "degraded";
  const headline = sorted
    .filter((l) => l.tone !== "ok")
    .slice(0, 3)
    .map((l) => l.text);

  if (headline.length === 0) {
    const soonest = Math.min(
      ...input.credentials
        .filter((c) => c.expiresAtMs !== null)
        .map((c) => daysUntil(c.expiresAtMs!, input.nowMs)),
    );
    return { status, detail: `${input.credentials.length} credentials, soonest expiry ${soonest}d` };
  }
  return { status, detail: headline.join(" · ") };
}

// ── COLLECTORS: read the artefacts ────────────────────────────────────────

/** Reads a host's leaf certificate expiry. Seam so the probe is testable. */
export type CertReader = (host: string) => Promise<{ validToMs: number | null; error?: string }>;

/**
 * A TLS host's `notAfter`, read by connecting and looking at the leaf cert.
 *
 * No verification is required for this to be truthful: we are asking the server
 * what it is presenting, and an expiry we read off a cert the client would
 * reject is still the expiry that will take the site down. `rejectUnauthorized`
 * stays ON regardless, because a host that cannot complete a handshake TODAY is
 * a fact worth surfacing rather than working around.
 */
export function tlsCertReader(timeoutMs = 5000): CertReader {
  return (host) =>
    new Promise((resolve) => {
      let settled = false;
      const done = (r: { validToMs: number | null; error?: string }) => {
        if (settled) return;
        settled = true;
        try {
          socket.destroy();
        } catch {
          /* already gone */
        }
        resolve(r);
      };
      const socket = tlsConnect({ host, port: 443, servername: host, timeout: timeoutMs }, () => {
        const cert = socket.getPeerCertificate();
        const validTo = cert && typeof cert.valid_to === "string" ? Date.parse(cert.valid_to) : NaN;
        done(Number.isFinite(validTo) ? { validToMs: validTo } : { validToMs: null, error: "no valid_to on the leaf cert" });
      });
      socket.on("timeout", () => done({ validToMs: null, error: `no TLS answer in ${timeoutMs}ms` }));
      socket.on("error", (e: Error) => done({ validToMs: null, error: e.message }));
    });
}

/**
 * Everything this box can observe about its own credential expiries.
 *
 * Order is deliberate: certificates first, because a lapsed one is a total
 * public outage rather than a degraded feature.
 *
 * A host that will not answer becomes `unreadable`, NOT absent. Dropping it
 * would shrink the list silently and let the probe report a clean bill of
 * health over a credential nobody looked at — absence-is-not-zero, applied to
 * the thing whose entire job is noticing something before it lapses.
 */
export async function collectCredentialExpiries(input: {
  certHosts: string[];
  env: Record<string, string | undefined>;
  jwtEnvKeys: string[];
  readCert: CertReader;
}): Promise<CredentialExpiry[]> {
  const out: CredentialExpiry[] = [];

  for (const host of input.certHosts) {
    const r = await input.readCert(host);
    out.push({
      label: `TLS ${host}`,
      source: "leaf certificate notAfter",
      expiresAtMs: r.validToMs,
      ...(r.error ? { unreadable: r.error } : {}),
    });
  }

  for (const key of input.jwtEnvKeys) {
    const raw = input.env[key];
    // An UNSET credential is not an unreadable one — there is nothing to watch,
    // and reporting "cannot read FOO" for a key nobody configured is the
    // permanently-lit panel again. Skipped entirely.
    if (!raw || !raw.trim()) continue;
    const exp = jwtExpiryMs(raw);
    out.push({
      label: key,
      source: "jwt exp claim",
      expiresAtMs: exp,
      // Non-JWT credentials (opaque GitHub PATs, webhook URLs) legitimately
      // carry no expiry. That is "no expiry declared", not a failure to read.
      ...(exp === null ? {} : {}),
    });
  }

  return out;
}
