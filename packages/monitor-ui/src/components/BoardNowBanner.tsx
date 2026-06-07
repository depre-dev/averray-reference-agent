// Hermes Handoff Monitor — BoardNowBanner
//
// The hero sentence at the top of the board. Reads the composed prose
// from `boardNowBanner(cards)` and renders one of three tone variants:
//   - "action"   — amber wash; "1 card needs your review decision…"
//   - "calm"     — sage; "Nothing waits on you…"
//   - "degraded" — rose; "Live stream disconnected…"
//
// The text content comes from the selector — the component just picks
// the glyph and tone class and renders. This keeps the prose
// composition testable (board-state.test.ts) and the React tree dumb.

import type { ReactNode } from "react";

export type BannerData = {
  tone: "action" | "calm" | "hermes-focus" | "degraded";
  eyebrow: string;
  headline: string;
  sub: string;
  primaryActionId: string | undefined;
  mostUrgentReasons?: Array<{
    label: string;
    tone: "neutral" | "risk" | "safe" | "warn";
    title?: string;
  }>;
};

export type BoardNowBannerProps = {
  banner: BannerData;
  /** Right-side action buttons. Caller composes (Jump to / Ask Hermes / etc). */
  cta?: ReactNode;
};

const GLYPHS: Record<BannerData["tone"], string> = {
  action: "!",
  calm: "✓",
  "hermes-focus": "H",
  degraded: "‼",
};

export function BoardNowBanner({ banner, cta }: BoardNowBannerProps) {
  const reasons = banner.mostUrgentReasons ?? [];
  const toneClass =
    banner.tone === "action"
      ? "hm-now hm-now--action"
      : banner.tone === "hermes-focus"
        ? "hm-now hm-now--action hm-now--hermes-focus"
      : banner.tone === "calm"
        ? "hm-now hm-now--calm"
        : "hm-now hm-now--degraded";

  return (
    <div className={toneClass} role="status" aria-live="polite">
      <div className="hm-now-glyph" aria-hidden>
        {GLYPHS[banner.tone]}
      </div>
      <div>
        <div className="hm-now-eyebrow">
          <span className="live" aria-hidden />
          {banner.eyebrow}
        </div>
        <h1 className="hm-now-head">{banner.headline}</h1>
        <p className="hm-now-sub">{banner.sub}</p>
        {reasons.length > 0 ? (
          <div className="hm-now-reasons" aria-label="Most urgent because">
            <span className="hm-now-reasons-label">Most urgent because</span>
            {reasons.map((reason) => (
              <span
                key={`${reason.tone}:${reason.label}`}
                className={`hm-now-reason hm-now-reason--${reason.tone}`}
                title={reason.title}
              >
                {reason.label}
              </span>
            ))}
          </div>
        ) : null}
      </div>
      {cta ? <div className="hm-now-cta">{cta}</div> : null}
    </div>
  );
}
