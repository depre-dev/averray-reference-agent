// ChainTicker — the block-height chip that sits beside the Live clock in the
// TopStrip. Data comes from the product-health poll (ChainTick block); the
// visual contract is `.hm-chain-pill` in styles/monitor.css.
//
// The height NEVER self-increments — only the age ticks (1s interval), and all
// display logic lives in the pure deriveChainTicker() so it unit-tests without
// a DOM or a real clock.

import { useEffect, useState } from "react";
import type { ChainTick, ProductHealthProbe } from "../lib/monitor/product-health.js";
import { deriveChainTicker } from "../lib/monitor/chain-ticker.js";

export type ChainTickerProps = {
  chain?: ChainTick;
  /** The chain_height probe (tone authority). */
  probe?: ProductHealthProbe;
  /** True when the product-health poll is currently failing. */
  pollError?: boolean;
  /** Clock injection for tests; defaults to Date.now. */
  now?: () => number;
};

export function ChainTicker({ chain, probe, pollError, now = () => Date.now() }: ChainTickerProps) {
  const [nowMs, setNowMs] = useState(() => now());
  useEffect(() => {
    setNowMs(now());
    const timer = setInterval(() => setNowMs(now()), 1_000);
    return () => clearInterval(timer);
  }, [now]);

  const view = deriveChainTicker({ chain, probe, pollError: Boolean(pollError), nowMs });
  if (view.kind === "awaiting") {
    return (
      <span className="hm-chain-pill tone-awaiting" role="status" aria-label={view.title} title={view.title}>
        <span className="ledge" aria-hidden />
        chain · —
      </span>
    );
  }
  return (
    <span
      className={`hm-chain-pill tone-${view.tone}${view.stale ? " is-stale" : ""}`}
      role="status"
      aria-label={view.title}
      title={view.title}
    >
      <span className="ledge" aria-hidden />
      {view.heightLabel}
      <span className="hm-chain-age">· {view.ageLabel}</span>
    </span>
  );
}
