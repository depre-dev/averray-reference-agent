// Transport-layer failure classification — telling "the product answered badly"
// apart from "we never got to ask".
//
// ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
//
// On 2026-08-06 container-local DNS failed for about five minutes. Every probe
// that reaches out over the network failed at once, and the board said:
//
//   Product API is red — https://api.averray.com/health unreachable: fetch failed
//
// The product was up the whole time; 200s were served from outside throughout.
// What the probe actually knew was that IT could not resolve the host from
// inside its own container. Those are different claims, and only one of them
// was true.
//
// The wording was not the only problem. "fetch failed" is undici's OUTER
// message; the cause code — ENOTFOUND — was sitting one level down in
// `err.cause` and never made it to a human. So the alert managed to be both
// overconfident about the product and uninformative about the actual fault.
//
// ── WHAT THIS MODULE DECIDES ────────────────────────────────────────────────
//
// Two things, both pure:
//
//  1. Did this failure happen BELOW HTTP? A 503 is evidence about the product.
//     A DNS failure, a refused connection, a TLS handshake error or a connect
//     timeout is evidence about the path between us and the product — and says
//     nothing about the product itself.
//  2. How many consecutive cycles has it now been failing? A single-shot DNS
//     blip must not page on-call; a sustained one must.
//
// No I/O, no clock, no config, so every rule here is unit-testable.

/** What kind of thing went wrong below HTTP. Drives the human phrasing only —
 *  the alert decision keys on `code` + the consecutive count. */
export type TransportFailureKind = "dns" | "connect" | "tls" | "timeout" | "transport";

export interface TransportFailure {
  kind: TransportFailureKind;
  /** The underlying cause code — ENOTFOUND, ECONNREFUSED, … "UNKNOWN" when the
   *  error carried none. Never invented: UNKNOWN means we could not name it. */
  code: string;
  /** The deepest message in the cause chain — the one that says something. */
  message: string;
}

/** Codes that mean the name never resolved. */
const DNS_CODES = new Set(["ENOTFOUND", "EAI_AGAIN", "EAI_NODATA", "EAI_NONAME"]);
/** Codes that mean we reached the network and it refused / vanished. */
const CONNECT_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENETDOWN",
  "EPIPE",
  "EADDRNOTAVAIL",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
]);
/** Codes that mean the handshake, not the request, failed. */
const TLS_CODES = new Set([
  "CERT_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "ERR_SSL_WRONG_VERSION_NUMBER",
  "EPROTO",
]);
/** Codes that mean we waited and nothing came back. */
const TIMEOUT_CODES = new Set([
  "ETIMEDOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "ABORT_ERR",
]);

function kindFor(code: string, message: string): TransportFailureKind {
  if (DNS_CODES.has(code)) return "dns";
  if (TLS_CODES.has(code)) return "tls";
  if (TIMEOUT_CODES.has(code)) return "timeout";
  if (CONNECT_CODES.has(code)) return "connect";
  // Codeless errors still say what they are in words often enough to be worth
  // reading — but only as a fallback, never in preference to a real code.
  if (/getaddrinfo|dns/i.test(message)) return "dns";
  if (/timed? ?out|timeout/i.test(message)) return "timeout";
  if (/tls|ssl|certificate/i.test(message)) return "tls";
  if (/econnrefused|refused|socket|network/i.test(message)) return "connect";
  return "transport";
}

/**
 * Walk an error's `cause` chain and pull out the deepest thing that names
 * itself.
 *
 * `fetch()` on undici throws `TypeError: fetch failed` and hangs the real error
 * off `.cause` — sometimes two levels down (an AggregateError of per-address
 * attempts). Reading only the top-level message is how "fetch failed" reached
 * an operator's phone as the entire explanation of a five-minute incident.
 */
export function classifyTransportFailure(err: unknown): TransportFailure {
  let code: string | undefined;
  let message = "";
  const seen = new Set<unknown>();
  let current: unknown = err;

  for (let depth = 0; current !== undefined && current !== null && depth < 8; depth += 1) {
    if (seen.has(current)) break;
    seen.add(current);
    const node = current as { code?: unknown; message?: unknown; errors?: unknown; cause?: unknown };
    // The DEEPEST code wins: undici's outer TypeError has none, and the socket
    // error underneath is the one that names ENOTFOUND.
    if (typeof node.code === "string" && node.code.trim()) code = node.code.trim();
    if (typeof node.message === "string" && node.message.trim()) message = node.message.trim();
    // AggregateError from a multi-address connect attempt — the individual
    // failures carry the codes; take the first, they share a cause in practice.
    const aggregated = Array.isArray(node.errors) ? node.errors[0] : undefined;
    current = node.cause ?? aggregated;
  }

  if (!message) message = typeof err === "string" ? err : String(err ?? "");
  const resolved = code ?? "UNKNOWN";
  return { kind: kindFor(resolved, message), code: resolved, message };
}

/** Human phrasing for the fault, cause code included. "DNS resolution failed
 *  (ENOTFOUND)" — the kind is for reading, the code is what you grep for. */
export function describeTransportFailure(failure: TransportFailure): string {
  const named =
    failure.kind === "dns"
      ? "DNS resolution failed"
      : failure.kind === "tls"
        ? "TLS handshake failed"
        : failure.kind === "timeout"
          ? "no response before the timeout"
          : failure.kind === "connect"
            ? "connection failed"
            : "transport failed";
  return failure.code === "UNKNOWN" ? `${named} (${failure.message})` : `${named} (${failure.code})`;
}

/**
 * How many consecutive cycles the transport has now failed, and under what code.
 *
 * Threaded by the caller across ticks exactly like `trackChainAdvance` — pure
 * in, pure out, nothing persisted here.
 */
export interface TransportFailureRun {
  /** The most recent cause code seen in this run. */
  code: string;
  /** Consecutive failing cycles, including this one. Never zero. */
  consecutive: number;
}

/**
 * Advance the run.
 *
 * A success clears it — recovery is immediate, because the reason to hold is
 * uncertainty and a successful read removes it.
 *
 * The count does NOT reset when the code changes. A real outage walks through
 * codes (ENOTFOUND while the resolver is down, then ECONNREFUSED as it comes
 * back on a dead port), and restarting the count on each one would keep the
 * hold armed indefinitely — a way to never page at all.
 */
export function trackTransportFailure(
  prev: TransportFailureRun | undefined,
  failure: TransportFailure | undefined,
): TransportFailureRun | undefined {
  if (!failure) return undefined;
  return { code: failure.code, consecutive: (prev?.consecutive ?? 0) + 1 };
}

/** Default consecutive failures before a transport fault is worth paging for.
 *  At the default 2-minute cadence that is ~4–6 minutes of sustained failure. */
export const DEFAULT_TRANSPORT_FAIL_THRESHOLD = 3;

/**
 * Has this run earned a page?
 *
 * Below the threshold the honest report is "we cannot see the product", which
 * is not the same claim as "the product is down" and must not wake anyone. At
 * the threshold it is still not the same claim — but it has persisted long
 * enough that somebody has to go look, whichever side of the wire is broken.
 */
export function transportFailureIsPageWorthy(
  run: TransportFailureRun | undefined,
  threshold: number = DEFAULT_TRANSPORT_FAIL_THRESHOLD,
): boolean {
  return !!run && run.consecutive >= Math.max(1, threshold);
}
