// Proactive ops narration — the pure decision for whether Hermes should post a
// co-pilot turn about a product-health change, and what to say.
//
// Fires ONLY on an overall-status edge across the red boundary (entered-red /
// recovered). This is self-deduping (transitions only), so a probe staying red
// never re-posts. It stays silent on the boot transition (prev "unknown", so a
// restart doesn't spam), on routine degraded↔healthy moves (those live in the
// Digest ops line), and while the operator is muted. Network tunes the wording:
// a mainnet red pages on-call; a testnet red is informational.
//
// Kept pure (no I/O, no @avg deps) so it runs in the local unit suite; the
// caller (index.ts checkProductHealth) supplies prev/curr, the probes, the
// resolved network, and the current mute state.

export type OpsStatus = "healthy" | "degraded" | "red" | "unknown";
export type OpsNetwork = "testnet" | "mainnet" | "unknown";

export interface OpsNarrationProbe {
  name: string;
  status: string;
  detail: string;
}

export interface DecideOpsNarrationInput {
  prev: OpsStatus;
  curr: OpsStatus;
  probes: readonly OpsNarrationProbe[];
  network: OpsNetwork;
  muted: boolean;
}

export interface OpsNarrationDecision {
  post: boolean;
  /** The edge that was detected (present even when suppressed, for logging). */
  edge?: "red" | "recovered";
  /** The Hermes turn text — present only when `post` is true. */
  text?: string;
  /** Why a real edge did not post (for observability). */
  suppressed?: "muted";
}

const PROBE_LABELS: Record<string, string> = {
  product_api: "Product API",
  api_latency: "API latency",
  chain_height: "Chain height",
  capabilities: "Capabilities",
  signer_liquidity: "Signer liquidity",
  treasury_liquidity: "Treasury",
  money_path: "Money path",
};

function label(name: string): string {
  return PROBE_LABELS[name] ?? name.replace(/_/g, " ");
}

function trim(detail: string, max = 160): string {
  const d = detail.trim();
  return d.length > max ? `${d.slice(0, max - 1)}…` : d;
}

export function decideOpsNarration(input: DecideOpsNarrationInput): OpsNarrationDecision {
  const { prev, curr, probes, network, muted } = input;

  // Never narrate the boot transition — a restart shouldn't spam the thread.
  if (prev === "unknown") return { post: false };

  const enteredRed = prev !== "red" && curr === "red";
  const recovered = prev === "red" && curr !== "red";
  if (!enteredRed && !recovered) return { post: false };

  const edge: "red" | "recovered" = enteredRed ? "red" : "recovered";

  // Mute = quiet everywhere; the state still shows passively in the Digest ops line.
  if (muted) return { post: false, edge, suppressed: "muted" };

  if (edge === "red") {
    const reds = probes.filter((p) => p.status === "red");
    const lead = reds[0];
    const extra = reds.length > 1 ? ` (+${reds.length - 1} more)` : "";
    const tone = network === "mainnet" ? "On-call is paged." : "Testnet — informational.";
    const detail = lead?.detail ? `: ${trim(lead.detail)}` : "";
    return {
      post: true,
      edge,
      text: `⚠ Ops — ${lead ? label(lead.name) : "a probe"} red${detail}${extra}. ${tone}`,
    };
  }

  return {
    post: true,
    edge,
    text: `✓ Ops recovered — product health back to ${curr}.`,
  };
}
