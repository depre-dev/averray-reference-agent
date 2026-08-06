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
import type { ProductHealth, RunwayPool } from "../../lib/monitor/product-health.js";
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

/**
 * Pools projected to reach their floor, nearest first.
 *
 * Runway is a LEADING indicator: the probes can all sit above their floors — so
 * the banner reads "all nominal" — while a pool is visibly draining toward one.
 * That was live on mainnet: 7 probes green with the co-pilot simultaneously
 * saying "Signer gas ~13h to floor — top up before settlement halts".
 *
 * `estimable` + a non-null `hoursToFloor` are the backend's own honesty gates
 * (too few samples / too short a window / flat / refilling all resolve to
 * not-estimable), so a single reading can't manufacture urgency here.
 */
function drainingPools(health: ProductHealth): RunwayPool[] {
  return (health.solvency?.runway ?? [])
    .filter((p) => p.estimable && p.hoursToFloor !== null && (p.status === "red" || p.status === "degraded"))
    .sort((a, b) => (a.hoursToFloor ?? 0) - (b.hoursToFloor ?? 0));
}

function hoursToFloorPhrase(hours: number): string {
  if (hours <= 0) return "at its floor";
  if (hours < 1) return "<1h to floor";
  return `~${Math.round(hours)}h to floor`;
}

/** The burn that produced the projection — the evidence, so it can be judged. */
function burnPhrase(pool: RunwayPool): string | undefined {
  const burn = pool.burnPerHour;
  if (burn === null || burn <= 0) return undefined;
  return `${burn >= 1 ? burn.toFixed(1) : burn.toFixed(2)} ${pool.unit}/h`;
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
    // A red we could not READ is page-worthy unreachability, not a settlement
    // finding. This banner is the largest sentence on the board, and on
    // 2026-08-06 it is the one that told an operator the product was down while
    // it was serving 200s. It must also agree with `verdict.headline`, which now
    // says UNREACHABLE — two derivations contradicting each other on one screen
    // is worse than either being wrong alone.
    const unreadable = lead.reading === "unknown";
    return {
      tone: "degraded",
      eyebrow,
      headline: unreadable
        ? `${probeLabel(lead.name)} unreachable from the monitor${extra} — ${shortDetail(lead.detail)}`
        : `${probeLabel(lead.name)} red${extra} — ${shortDetail(lead.detail)}`,
      sub: unreadable
        ? "The probe cannot reach it — whether the product is affected is unknown."
        : mainnet
          ? "Settlement-affecting — on-call is paged."
          : "On mainnet this pages; on testnet it does not.",
      primaryActionId: undefined,
      mostUrgentReasons: [
        { label: unreadable ? "unreachable" : "page-worthy", tone: "risk" },
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

  // Nothing has breached — but a pool may be draining toward its floor. A
  // projection is NOT a breach, so this never takes the rose/page tone; it only
  // stops the banner claiming "all nominal" while the co-pilot is telling the
  // operator to top up. An actual red/degraded probe still outranks it above.
  const draining = drainingPools(health);
  if (draining.length > 0) {
    const lead = draining[0]!;
    const extra = draining.length > 1 ? ` +${draining.length - 1}` : "";
    const burn = burnPhrase(lead);
    const projected = burn ? `Projected from a ${burn} trend` : "Projected from the recent trend";
    return {
      tone: "action",
      eyebrow,
      headline: `${lead.label} ${hoursToFloorPhrase(lead.hoursToFloor ?? 0)}${extra}`,
      sub: mainnet
        ? `${projected} — top up before settlement halts. Nothing has breached yet.`
        : `${projected} — nothing has breached yet.`,
      primaryActionId: undefined,
      mostUrgentReasons: [
        // "projected", not "degraded": the balance is still above its floor.
        { label: "projected", tone: "warn" },
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
