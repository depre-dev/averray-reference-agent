// The soft ops banner — a dismissible dot+note strip for the active incident.
// "Soft" per the design: it never takes over the surface, and it's network-aware
// — a testnet degradation says "not paging", a mainnet red says on-call is paged.
// Awaiting-data probes never raise it (missing data is not an incident). A NEW
// incident re-shows even after a prior dismiss (the signature changes).

import { useState } from "react";
import type { ProductHealth } from "../../lib/monitor/product-health.js";
import { probeLabel } from "../../lib/monitor/product-health.js";
import { isAwaitingProbe } from "../../lib/monitor/ops-model.js";

interface BannerContent {
  tone: "degraded" | "red";
  text: string;
  sub: string;
  sig: string;
}

function bannerContent(health: ProductHealth): BannerContent | null {
  if (!health.enabled || health.checks === 0) return null;
  const mainnet = health.network === "mainnet";

  if (health.status === "red") {
    const reds = health.probes.filter((p) => p.status === "red");
    const lead = reds[0];
    const extra = reds.length > 1 ? ` +${reds.length - 1} more` : "";
    return {
      tone: "red",
      text: `${lead ? probeLabel(lead.name) : "A probe"} red${extra} — ${lead?.detail ?? "see probes"}`,
      sub: mainnet ? "on-call is paged." : "testnet — not paging; on mainnet this pages.",
      sig: `red:${reds.map((p) => p.name).join(",")}`,
    };
  }

  if (health.status === "degraded") {
    // Only REAL degradations raise the banner — awaiting-data probes are grey
    // telemetry, not incidents.
    const real = health.probes.filter((p) => p.status === "degraded" && !isAwaitingProbe(p));
    if (real.length === 0) return null;
    const lead = real[0];
    const extra = real.length > 1 ? ` +${real.length - 1} more` : "";
    return {
      tone: "degraded",
      text: `${probeLabel(lead.name)} degraded${extra} — ${lead.detail}`,
      sub: mainnet ? "watching closely." : "testnet — not paging; a mainnet halt would.",
      sig: `degraded:${real.map((p) => p.name).join(",")}`,
    };
  }

  return null;
}

export interface OpsSoftBannerProps {
  health: ProductHealth;
}

export function OpsSoftBanner({ health }: OpsSoftBannerProps) {
  const content = bannerContent(health);
  const [dismissedSig, setDismissedSig] = useState<string | null>(null);
  if (!content || dismissedSig === content.sig) return null;
  return (
    <div className={`ops-banner ops-banner--${content.tone}`} role="status" data-testid="ops-banner">
      <span className="ops-dot" aria-hidden />
      <span className="ops-banner-text">
        {content.text} <span className="ops-banner-sub">{content.sub}</span>
      </span>
      <button
        type="button"
        className="ops-banner-x"
        aria-label="Dismiss banner"
        onClick={() => setDismissedSig(content.sig)}
      >
        ×
      </button>
    </div>
  );
}
