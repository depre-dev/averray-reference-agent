// The shared human vocabulary for everything ops pushes into chat.
//
// Three surfaces speak about the same probes — the morning digest, the
// per-probe transition alerts, and the red-boundary narration — and each had
// its own idea of what to call one (or none: `⚠ money_path: …` shipped the
// enum straight to the operator's phone). One map, imported by all three, so a
// probe is called the same thing everywhere and a rename is one edit.
//
// Prompted by the operator, 2026-08-05, the day mobile pairing put these
// messages in his pocket: "make the status update and briefing a little bit
// more human … not just some boring stats." The FACTS remain the producers'
// exact strings on every surface — this module only supplies the words around
// them, which is why it can live in the frontend of the pipeline without
// becoming a second verdict system.

export const PROBE_LABELS: Record<string, string> = {
  product_api: "Product API",
  api_latency: "API latency",
  chain_height: "Chain height",
  capabilities: "Capabilities",
  signer_liquidity: "Signer liquidity",
  treasury_liquidity: "Treasury",
  money_path: "Money path",
  credential_expiry: "Credentials",
  external_funnel: "External funnel",
};

/** Human name for a probe; an unknown name degrades to readable, not to enum. */
export function probeLabel(name: string): string {
  const known = PROBE_LABELS[name];
  if (known) return known;
  const words = name.replace(/_/g, " ").trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : name;
}

/** The board's severity vocabulary: red ✗, ok ✓, everything between ⚠. */
export function statusGlyph(status: string): string {
  if (status === "red") return "✗";
  if (status === "ok") return "✓";
  return "⚠";
}

/**
 * Greeting matched to when the digest ACTUALLY fires. The schedule fires late
 * when the process was down at the target time — that lateness is deliberate
 * and stamped honestly, so "Good morning" at 14:37 would be the one dishonest
 * word in an otherwise truthful message.
 */
export function greetingFor(hhmm: string): string {
  const hour = Number(hhmm.slice(0, 2));
  if (!Number.isFinite(hour)) return "Hello";
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}
