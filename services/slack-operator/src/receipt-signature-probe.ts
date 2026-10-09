// Receipt signature probe — a regression guard for the served badge documents.
//
// Every 30 minutes the monitor fetches GET /badges?limit=5, then the per-id
// documents at /badges/<sessionId> and /receipts/<receiptId>, and verifies each
// served document against /.well-known/badge-receipt-jwks.json. The key is the
// document's own signature.kid. The canonicalization is the published RFC 8785
// subset: object keys sorted by UTF-16 code units, array order kept, no
// whitespace. The detached ES256 JWS covers everything except the root
// `signature`. A served document that fails verification is red. A fetch we
// could not complete (unreachable, 5xx, 404, timeout) is "could not check".
//
// The signer and the KMS key stay in the backend. This probe only reads public
// documents and the published JWKS.

import { createPublicKey, createVerify, type JsonWebKey as CryptoJsonWebKey } from "node:crypto";

import { classifyTransportFailure, describeTransportFailure } from "./probe-transport.js";

export const RECEIPT_PROBE_INTERVAL_MS = 30 * 60 * 1000;
export const RECEIPT_FETCH_TIMEOUT_MS = 8_000;
export const BADGE_RECEIPT_JWKS_PATH = "/.well-known/badge-receipt-jwks.json";
export const BADGE_RECEIPT_TYP = "averray-badge-receipt+jws";
export const RECEIPT_LIST_LIMIT = 5;
export const RECEIPT_DETAIL_COUNT = 2;

export interface ReceiptProbeView {
  status: "ok" | "degraded" | "red";
  detail: string;
  checked: number;
  at: number | null;
}

/** RFC 8785 for the JSON subset badge receipts use. Rejects non-JSON values. */
export function canonicalizeJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("canonicalizeJson: numbers must be finite");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalizeJson(entry)).join(",")}]`;
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("canonicalizeJson: only plain JSON objects are supported");
    }
    const entries = Object.keys(value)
      .sort()
      .map((key) => {
        const entry = (value as Record<string, unknown>)[key];
        if (entry === undefined || ["bigint", "function", "symbol"].includes(typeof entry)) {
          throw new TypeError(`canonicalizeJson: property ${JSON.stringify(key)} is not a JSON value`);
        }
        return `${JSON.stringify(key)}:${canonicalizeJson(entry)}`;
      });
    return `{${entries.join(",")}}`;
  }
  throw new TypeError(`canonicalizeJson: unsupported value type ${typeof value}`);
}

export function canonicalBadgeReceiptBytes(document: Record<string, unknown>): Buffer {
  const { signature: _signature, ...unsigned } = document;
  return Buffer.from(canonicalizeJson(unsigned), "utf8");
}

function rawSignatureToDer(raw: Buffer): Buffer {
  if (raw.length !== 64) throw new TypeError("ES256 receipt signature must be 64 bytes");
  const trim = (part: Buffer): Buffer => {
    let index = 0;
    while (index < part.length - 1 && part[index] === 0) index += 1;
    const value = part.subarray(index);
    return value[0]! & 0x80 ? Buffer.concat([Buffer.from([0]), value]) : value;
  };
  const r = trim(raw.subarray(0, 32));
  const s = trim(raw.subarray(32));
  const body = Buffer.concat([Buffer.from([0x02, r.length]), r, Buffer.from([0x02, s.length]), s]);
  return Buffer.concat([Buffer.from([0x30, body.length]), body]);
}

interface Jwk {
  kid?: string;
  kty?: string;
  crv?: string;
  alg?: string;
  x?: string;
  y?: string;
  use?: string;
}

function isSigningJwk(value: unknown): value is Jwk {
  if (!value || typeof value !== "object") return false;
  const key = value as Jwk;
  return typeof key.kid === "string"
    && key.kid.length > 0
    && key.kty === "EC"
    && key.crv === "P-256"
    && key.alg === "ES256"
    && typeof key.x === "string"
    && typeof key.y === "string"
    && (key.use === undefined || key.use === "sig");
}

function signingKeys(jwks: unknown): Jwk[] {
  if (isSigningJwk(jwks)) return [jwks];
  const keys = jwks && typeof jwks === "object" ? (jwks as { keys?: unknown }).keys : undefined;
  if (!Array.isArray(keys)) throw new Error("published JWKS has no keys");
  return keys.filter(isSigningJwk);
}

/**
 * Verify one served document against an already-loaded JWKS key.
 * Throws a reason string's Error when the document does not verify.
 */
export function verifyServedReceipt(document: Record<string, unknown>, jwks: unknown): void {
  const signature = document.signature;
  if (!signature || typeof signature !== "object" || Array.isArray(signature)) {
    throw new Error("served receipt has no signature");
  }
  const sig = signature as Record<string, unknown>;
  if (sig.alg !== "ES256" || typeof sig.kid !== "string" || !sig.kid || typeof sig.sig !== "string" || typeof sig.signedAt !== "string") {
    throw new Error("receipt signature metadata is malformed or uses an unsupported key");
  }
  const segments = sig.sig.split(".");
  if (segments.length !== 3 || segments[1] !== "") throw new Error("receipt signature is not a detached compact JWS");
  let protectedHeader: Record<string, unknown>;
  try {
    protectedHeader = JSON.parse(Buffer.from(segments[0]!, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    throw new Error("receipt protected header is not JSON");
  }
  const headerKeys = Object.keys(protectedHeader).sort();
  if (
    headerKeys.join(",") !== "alg,kid,signedAt,typ"
    || protectedHeader.alg !== "ES256"
    || protectedHeader.kid !== sig.kid
    || protectedHeader.typ !== BADGE_RECEIPT_TYP
    || protectedHeader.signedAt !== sig.signedAt
  ) {
    throw new Error("protected header does not integrity-bind alg, kid, typ, and signedAt");
  }
  const jwk = signingKeys(jwks).find((key) => key.kid === sig.kid);
  if (!jwk) throw new Error(`unknown kid ${sig.kid}`);
  const payloadB64 = canonicalBadgeReceiptBytes(document).toString("base64url");
  const verifier = createVerify("SHA256");
  verifier.update(`${segments[0]}.${payloadB64}`, "utf8");
  verifier.end();
  const raw = Buffer.from(segments[2]!, "base64url");
  const ok = verifier.verify(
    createPublicKey({ key: jwk as CryptoJsonWebKey, format: "jwk" }),
    rawSignatureToDer(raw),
  );
  if (!ok) throw new Error("signature does not match the canonical receipt document");
}

function textField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value : null;
}

function nestedId(item: unknown, key: "sessionId" | "receiptId"): string | null {
  if (!item || typeof item !== "object") return null;
  const record = item as Record<string, unknown>;
  const direct = textField(record, key);
  if (direct) return direct;
  const document = record.document;
  if (document && typeof document === "object" && !Array.isArray(document)) {
    const doc = document as Record<string, unknown>;
    const fromDoc = textField(doc, key);
    if (fromDoc) return fromDoc;
    const averray = doc.averray;
    if (averray && typeof averray === "object" && !Array.isArray(averray)) {
      const fromAverray = textField(averray as Record<string, unknown>, key);
      if (fromAverray) return fromAverray;
    }
  }
  return null;
}

function sessionIdOf(item: unknown): string | null {
  return nestedId(item, "sessionId");
}

function receiptIdOf(item: unknown): string | null {
  return nestedId(item, "receiptId");
}

function servedDocument(body: unknown): Record<string, unknown> | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  if (
    (record.schemaVersion === "averray.receipt-envelope.v1" || record.schemaVersion === "averray.badge-list-item.v1")
    && record.document && typeof record.document === "object" && !Array.isArray(record.document)
  ) {
    return record.document as Record<string, unknown>;
  }
  return record;
}

async function readJson(fetchImpl: typeof fetch, url: string, timeoutMs: number): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { headers: { accept: "application/json" }, signal: controller.signal });
    if (!response.ok) throw new Error(`${url} → HTTP ${response.status}`);
    return response.json();
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`${url} timed out`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export function decideReceiptProbe(input: {
  checked: number;
  ids: number;
  failures: string[];
  unchecked?: string[];
}): Omit<ReceiptProbeView, "at"> {
  // Red only when a document we actually received fails verification.
  if (input.failures.length > 0) {
    return { status: "red", detail: input.failures.slice(0, 3).join(" · "), checked: input.checked };
  }
  const unchecked = input.unchecked ?? [];
  if (unchecked.length > 0) {
    return {
      status: "degraded",
      detail: `could not check — ${unchecked.slice(0, 3).join(" · ")}`,
      checked: input.checked,
    };
  }
  if (input.ids < RECEIPT_DETAIL_COUNT || input.checked < RECEIPT_DETAIL_COUNT) {
    return {
      status: "degraded",
      detail: `receipt signature probe checked ${input.checked} served document${input.checked === 1 ? "" : "s"}; need ${RECEIPT_DETAIL_COUNT} per-id receipts`,
      checked: input.checked,
    };
  }
  return {
    status: "ok",
    detail: `verified ${input.checked} served receipt documents against the served JWKS`,
    checked: input.checked,
  };
}

/** Empty means the probe has no base URL. Never substitute a production host. */
export function receiptApiBase(apiBaseUrl: string | undefined): string | null {
  const trimmed = apiBaseUrl?.trim().replace(/\/+$/, "") ?? "";
  return trimmed || null;
}

export function receiptProbeDetail(view: Pick<ReceiptProbeView, "detail" | "at">, nowMs: number): string {
  if (view.at == null) return view.detail;
  const seconds = Math.max(0, Math.round((nowMs - view.at) / 1000));
  const age = seconds < 90 ? `${seconds}s ago` : `${Math.round(seconds / 60)}m ago`;
  return `${view.detail} · ${age}`;
}

/** Fetch the list, two per-id receipts, and verify every served document. */
function couldNotCheck(reason: string): Omit<ReceiptProbeView, "at"> {
  return { status: "degraded", detail: `could not check — ${reason}`, checked: 0 };
}

export async function runReceiptSignatureProbe(input: {
  apiBaseUrl: string;
  fetchImpl: typeof fetch;
  timeoutMs?: number;
}): Promise<Omit<ReceiptProbeView, "at">> {
  const base = receiptApiBase(input.apiBaseUrl);
  if (!base) return { status: "degraded", detail: "not configured", checked: 0 };
  const timeoutMs = input.timeoutMs ?? RECEIPT_FETCH_TIMEOUT_MS;
  try {
    const jwks = await readJson(input.fetchImpl, `${base}${BADGE_RECEIPT_JWKS_PATH}`, timeoutMs);
    const keys = signingKeys(jwks);
    if (keys.length === 0) return couldNotCheck("published JWKS has no signing keys");
    const list = await readJson(input.fetchImpl, `${base}/badges?limit=${RECEIPT_LIST_LIMIT}`, timeoutMs);
    const items = list && typeof list === "object" && Array.isArray((list as { items?: unknown }).items)
      ? (list as { items: unknown[] }).items
      : [];
    const chosen: Array<{ sessionId: string | null; receiptId: string | null; listed: Record<string, unknown> | null }> = [];
    for (const item of items) {
      const sessionId = sessionIdOf(item);
      const receiptId = receiptIdOf(item);
      if (!sessionId && !receiptId) continue;
      if (chosen.some((row) => row.sessionId === sessionId && row.receiptId === receiptId)) continue;
      const listed = item && typeof item === "object" ? servedDocument(item) : null;
      chosen.push({ sessionId, receiptId, listed });
      if (chosen.length === RECEIPT_DETAIL_COUNT) break;
    }
    const failures: string[] = [];
    const unchecked: string[] = [];
    let checked = 0;
    const check = (label: string, document: Record<string, unknown> | null) => {
      if (!document) {
        unchecked.push(`${label} served no receipt document`);
        return;
      }
      checked += 1;
      try {
        verifyServedReceipt(document, { keys });
      } catch (error) {
        failures.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
      }
    };
    const fetchOne = async (label: string, url: string) => {
      try {
        const detail = await readJson(input.fetchImpl, url, timeoutMs);
        check(label, servedDocument(detail));
      } catch (error) {
        unchecked.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
      }
    };
    for (const row of chosen) {
      const labelId = row.sessionId ?? row.receiptId ?? "item";
      if (row.listed) check(`list ${labelId}`, row.listed);
      if (row.sessionId) await fetchOne(`badges/${row.sessionId}`, `${base}/badges/${encodeURIComponent(row.sessionId)}`);
      if (row.receiptId) await fetchOne(`receipts/${row.receiptId}`, `${base}/receipts/${encodeURIComponent(row.receiptId)}`);
    }
    return decideReceiptProbe({ checked, ids: chosen.length, failures, unchecked });
  } catch (error) {
    const transport = classifyTransportFailure(error);
    const reason = transport.code === "UNKNOWN"
      ? (error instanceof Error ? error.message : String(error))
      : describeTransportFailure(transport);
    return couldNotCheck(reason);
  }
}

export interface ReceiptProbeCache {
  read(): ReceiptProbeView;
  maybeRefresh(nowMs: number): void;
}

export function createReceiptProbeCache(deps: {
  run: () => Promise<Omit<ReceiptProbeView, "at">>;
  intervalMs?: number;
}): ReceiptProbeCache {
  const intervalMs = deps.intervalMs ?? RECEIPT_PROBE_INTERVAL_MS;
  let view: ReceiptProbeView = {
    status: "degraded",
    detail: "receipt signature probe has not completed",
    checked: 0,
    at: null,
  };
  let lastRunAt: number | null = null;
  let running = false;

  return {
    read: () => view,
    maybeRefresh(nowMs) {
      if (running) return;
      if (lastRunAt !== null && nowMs - lastRunAt < intervalMs) return;
      running = true;
      void (async () => {
        try {
          const next = await deps.run();
          view = { ...next, at: nowMs };
          lastRunAt = nowMs;
        } catch (error) {
          view = {
            status: "degraded",
            detail: `could not check — ${error instanceof Error ? error.message : String(error)}`,
            checked: 0,
            at: nowMs,
          };
          lastRunAt = nowMs;
        } finally {
          running = false;
        }
      })();
    },
  };
}
