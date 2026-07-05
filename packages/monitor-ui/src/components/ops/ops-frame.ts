// Ops frame derivation — turns a ProductHealth snapshot into the persistent
// board-frame pieces that adapt per surface:
//   opsBannerData()   → the hero "board now" banner (reuses <BoardNowBanner>'s
//                       BannerData shape) so Ops carries importance the same way
//                       Delivery does.
//   pillarStatuses()  → the top-strip KPI chips, one per pillar, so the KPI
//                       cluster shows ops-relevant status instead of delivery
//                       lane counts.
// Pure + nowMs-injected so it's deterministic to test.

import type { BannerData } from "../BoardNowBanner.js";
import type { ProductHealth } from "../../lib/monitor/product-health.js";
import { probeLabel } from "../../lib/monitor/product-health.js";
import {
  groupProbesByPillar,
  isAwaitingProbe,
  probeOpsTone,
  formatAgo,
  type OpsTone,
} from "../../lib/monitor/ops-model.js";

function shortDetail(detail: string): string {
  return detail.length > 88 ? `${detail.slice(0, 85)}…` : detail;
}

function eyebrowFor(health: ProductHealth, nowMs: number): string {
  const net = health.network && health.network !== "unknown" ? ` · ${health.network}` : "";
  const chain = typeof health.chainId === "number" ? ` · chain ${health.chainId}` : "";
  const checked = health.at ? ` · checked ${formatAgo(health.at, nowMs)}` : "";
  return `OPS NOW${chain}${net}${checked}`;
}

/**
 * The Ops hero banner. Maps product health onto the three <BoardNowBanner>
 * tones: calm (✓ sage) all-nominal, action (! amber) a real degradation,
 * degraded (‼ rose) a page-worthy red. Awaiting-data probes are telemetry
 * gaps, never an incident — they don't raise the banner tone.
 */
export function opsBannerData(health: ProductHealth, nowMs: number): BannerData {
  if (!health.enabled) {
    return {
      tone: "calm",
      eyebrow: "OPS NOW",
      headline: "Monitoring is off",
      sub: "Set PRODUCT_HEALTH_ENABLED to start probing the live product.",
      primaryActionId: undefined,
    };
  }
  if (health.checks === 0) {
    return {
      tone: "calm",
      eyebrow: "OPS NOW",
      headline: "Awaiting first check",
      sub: "The heartbeat runs every couple of minutes.",
      primaryActionId: undefined,
    };
  }

  const eyebrow = eyebrowFor(health, nowMs);
  const net = health.network && health.network !== "unknown" ? health.network : undefined;
  const mainnet = health.network === "mainnet";
  const reds = health.probes.filter((p) => p.status === "red");
  const realDegraded = health.probes.filter((p) => p.status === "degraded" && !isAwaitingProbe(p));

  if (reds.length > 0) {
    const lead = reds[0];
    const extra = reds.length > 1 ? ` +${reds.length - 1}` : "";
    return {
      tone: "degraded",
      eyebrow,
      headline: `${probeLabel(lead.name)} red${extra} — ${shortDetail(lead.detail)}`,
      sub: mainnet ? "Settlement-affecting — on-call is paged." : "On mainnet this pages; on testnet it does not.",
      primaryActionId: undefined,
      mostUrgentReasons: [
        { label: "page-worthy", tone: "risk" },
        ...(net ? ([{ label: net, tone: "neutral" }] as const) : []),
      ],
    };
  }

  if (realDegraded.length > 0) {
    const lead = realDegraded[0];
    const extra = realDegraded.length > 1 ? ` +${realDegraded.length - 1}` : "";
    return {
      tone: "action",
      eyebrow,
      headline: `${probeLabel(lead.name)} degraded${extra} — ${shortDetail(lead.detail)}`,
      sub: mainnet ? "Watching closely." : "Testnet — not paging; a mainnet halt would.",
      primaryActionId: undefined,
      mostUrgentReasons: [
        { label: "degraded", tone: "warn" },
        ...(net ? ([{ label: net, tone: "neutral" }] as const) : []),
      ],
    };
  }

  const awaiting = health.probes.filter(isAwaitingProbe).length;
  const green = health.probes.length - awaiting;
  return {
    tone: "calm",
    eyebrow,
    headline: "All product health nominal",
    sub:
      awaiting > 0
        ? `${green} probes green · ${awaiting} awaiting /health data (not wired yet)`
        : `${green} probes green · all pillars nominal`,
    primaryActionId: undefined,
  };
}

export interface PillarStatus {
  label: string;
  tone: OpsTone;
}

const TONE_RANK: Record<OpsTone, number> = { red: 3, degraded: 2, awaiting: 1, ok: 0 };

/** One chip per pillar, toned by its worst probe — the Ops top-strip KPIs. */
export function pillarStatuses(probes: ProductHealth["probes"]): PillarStatus[] {
  return groupProbesByPillar(probes).map((group) => {
    const worst = group.probes.reduce<OpsTone>((acc, probe) => {
      const tone = probeOpsTone(probe);
      return TONE_RANK[tone] > TONE_RANK[acc] ? tone : acc;
    }, "ok");
    return { label: group.label, tone: worst };
  });
}
