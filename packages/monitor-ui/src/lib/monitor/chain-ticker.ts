// Chain ticker — pure derivation for the TopStrip block-height chip.
//
// Honesty contract (truth-boundary): the HEIGHT is always the producer's last
// observed value — it never self-increments in the browser. Only the AGE ticks
// client-side, anchored to the observation the producer reported. A dead poll
// or a frozen chain makes the age grow and the tone go stale-gray; the ticker
// never invents a newer block and never stays confidently green on old data.
//
// Kept pure (no Date.now, no DOM): callers pass `nowMs`, so every state is
// deterministic to unit-test — same discipline as ops-model.ts.

import type { ChainTick, ProductHealthProbe } from "./product-health.js";
import { probeOpsTone, formatDuration, type OpsTone } from "./ops-model.js";

export type ChainTickerView =
  | {
      kind: "ready";
      /** e.g. "#18,812,345" — the last observed height, formatted. */
      heightLabel: string;
      /** e.g. "45s" / "7m" — age of the reading, ticking client-side. */
      ageLabel: string;
      ageSeconds: number;
      tone: OpsTone;
      /** Reading older than the producer's freshness window (or the poll is
       *  failing) — rendered visibly stale, never confidently green. */
      stale: boolean;
      /** Tooltip / aria text spelling out exactly what is shown. */
      title: string;
    }
  | { kind: "awaiting"; title: string };

const NUM = new Intl.NumberFormat("en-US");

export function deriveChainTicker(input: {
  chain: ChainTick | undefined;
  /** The chain_height probe — the tone authority (ok/degraded/red/awaiting). */
  probe: ProductHealthProbe | undefined;
  /** True when the product-health poll itself is currently failing. */
  pollError?: boolean;
  nowMs: number;
}): ChainTickerView {
  const { chain, probe, pollError = false, nowMs } = input;
  if (!chain || !Number.isFinite(chain.height) || chain.height <= 0) {
    return { kind: "awaiting", title: "Chain height not reported yet — awaiting the next product-health check." };
  }

  // Age = (block age at observation, when the chain-matched RPC measured it)
  //     + (time elapsed since the observation), ticking locally.
  // Fallbacks get progressively weaker but stay honest — the title says which
  // meaning applies.
  const sinceObservedSec = Math.max(0, (nowMs - chain.observedAtMs) / 1000);
  let baseAgeSec: number | null = null;
  let ageMeaning: string;
  if (typeof chain.blockAgeSec === "number" && chain.blockAgeSec >= 0) {
    baseAgeSec = chain.blockAgeSec;
    ageMeaning = "latest block age";
  } else if (typeof chain.lastAdvanceAtMs === "number" && chain.lastAdvanceAtMs <= chain.observedAtMs) {
    baseAgeSec = Math.max(0, (chain.observedAtMs - chain.lastAdvanceAtMs) / 1000);
    ageMeaning = "since the height last advanced";
  } else {
    ageMeaning = "since this height was read";
  }
  const ageSeconds = (baseAgeSec ?? 0) + sinceObservedSec;

  const staleWindow = typeof chain.freshSeconds === "number" && chain.freshSeconds > 0 ? chain.freshSeconds : undefined;
  const stale = pollError || (staleWindow !== undefined && ageSeconds > staleWindow);

  // Tone: the probe stays the single authority. Staleness only DOWNGRADES a
  // green to telemetry-gray ("we don't currently know"); a degraded/red/awaiting
  // verdict passes through — stale data never softens an alarm.
  let tone: OpsTone = probe ? probeOpsTone(probe) : "awaiting";
  if (stale && tone === "ok") tone = "awaiting";

  const heightLabel = `#${NUM.format(Math.floor(chain.height))}`;
  const ageLabel = formatDuration(ageSeconds * 1000);
  const title =
    `Block ${heightLabel} — last height observed by product-health` +
    ` · ${ageLabel} ${ageMeaning}` +
    (stale ? " · READING STALE (age exceeds the probe freshness window or the poll is failing)" : "") +
    " · the height only changes when a new check lands; it never counts up on its own.";

  return { kind: "ready", heightLabel, ageLabel, ageSeconds, tone, stale, title };
}
