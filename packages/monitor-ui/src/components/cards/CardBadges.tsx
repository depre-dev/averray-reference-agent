// Hermes-4 card badge families (PR-D2).
//
// One unified badge row — four families, each from REAL card fields, never
// fabricated:
//   - State    ← missionStatus / card.state            (tone: ok/warn/tel)
//   - Risk     ← risk[] (+ riskSignals severity)        (tone: tel, warn if high)
//   - Evidence ← mission.evidence kinds                 (tone: tel)
//   - Gate     ← waitingOn.actor                        (tone: act for operator)
//
// Tones use the PR-D1 --h4 semantic palette. The component renders only the
// families a card actually has — an empty card yields an empty row (the caller
// can skip it). Risk-tag text is preserved verbatim so it stays greppable.

import type { BoardCard, CardState, RiskTag, WaitingOn } from "../../lib/monitor/card-types.js";

type Tone = "ok" | "warn" | "act" | "tel";

function StateBadge({ card }: { card: BoardCard }) {
  const meta = stateMeta(card);
  if (!meta) return null;
  return (
    <span className={`h4-badge h4-badge--state h4-tone--${meta.tone}`} title={`state: ${meta.label}`}>
      <span className="h4-badge-glyph" aria-hidden>{meta.glyph}</span>
      {meta.label}
    </span>
  );
}

function stateMeta(card: BoardCard): { label: string; tone: Tone; glyph: string } | null {
  if (card.type === "mission") {
    const s = (card as { missionStatus?: string }).missionStatus;
    switch (s) {
      case "running": return { label: "running", tone: "ok", glyph: "◐" };
      case "completed": return { label: "done", tone: "tel", glyph: "✓" };
      case "failed": return { label: "failed", tone: "warn", glyph: "✕" };
      case "requested": return { label: "queued", tone: "tel", glyph: "·" };
      case "ready": return { label: "ready", tone: "ok", glyph: "▲" };
      default: break;
    }
  }
  const map: Record<CardState, { label: string; tone: Tone; glyph: string }> = {
    "running": { label: "running", tone: "ok", glyph: "◐" },
    "fresh": { label: "fresh", tone: "tel", glyph: "▲" },
    "stale": { label: "stale", tone: "warn", glyph: "◑" },
    "failed-fetch": { label: "fetch failed", tone: "warn", glyph: "✕" },
    "source-offline": { label: "offline", tone: "warn", glyph: "▢" },
  };
  return map[card.state] ?? null;
}

function RiskBadges({ card }: { card: BoardCard }) {
  const tags: RiskTag[] = Array.isArray(card.risk) ? card.risk : [];
  // Highest severity across real risk signals (if any) escalates the family.
  const severities = (card.riskSignals ?? []).map((s) => s.severity);
  const high = severities.includes("high");
  const med = !high && severities.includes("medium");
  if (tags.length === 0 && !high && !med) return null;
  return (
    <>
      {high || med ? (
        <span className={`h4-badge h4-badge--risk h4-tone--warn`} title="risk signals">
          <span className="h4-badge-glyph" aria-hidden>{high ? "◆" : "◣"}</span>
          risk: {high ? "high" : "med"}
        </span>
      ) : null}
      {tags.map((tag) => (
        <span key={tag} className="h4-badge h4-badge--risk h4-tone--tel" title={`risk area: ${tag}`}>
          {tag}
        </span>
      ))}
    </>
  );
}

function EvidenceBadges({ card }: { card: BoardCard }) {
  if (card.type !== "mission") return null;
  const evidence = (card as { mission?: { evidence?: Array<{ kind?: string }> } }).mission?.evidence;
  if (!Array.isArray(evidence) || evidence.length === 0) return null;
  const counts = new Map<string, number>();
  for (const e of evidence) {
    const k = typeof e?.kind === "string" ? e.kind : "evidence";
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return (
    <>
      {[...counts.entries()].map(([kind, n]) => (
        <span key={kind} className="h4-badge h4-badge--evidence h4-tone--tel" title="mission evidence">
          {n} {kind}{n === 1 ? "" : "s"}
        </span>
      ))}
    </>
  );
}

const GATE_META: Record<WaitingOn["actor"], { label: string; tone: Tone }> = {
  operator: { label: "needs you", tone: "act" },
  author: { label: "author", tone: "tel" },
  agent: { label: "agent", tone: "tel" },
  CI: { label: "CI", tone: "tel" },
  relay: { label: "relay", tone: "tel" },
  "branch-protection": { label: "branch protection", tone: "tel" },
};

function GateBadge({ card }: { card: BoardCard }) {
  const waitingOn = card.waitingOn;
  if (!waitingOn) return null;
  const meta = GATE_META[waitingOn.actor];
  if (!meta) return null;
  // Operator is always coral (DECIDE-orange); others take their declared tone
  // (warn → amber) but default to telemetry.
  const tone: Tone = meta.tone === "act" ? "act" : waitingOn.tone === "warn" ? "warn" : "tel";
  return (
    <span className={`h4-badge h4-badge--gate h4-tone--${tone}`} title={`waiting on ${waitingOn.actor}`}>
      <span className="h4-badge-dot" aria-hidden />
      {meta.label}
    </span>
  );
}

/** The unified badge row. Returns null when no family has anything to show. */
export function CardBadges({ card }: { card: BoardCard }) {
  const hasState = stateMeta(card) !== null;
  const hasRisk = (Array.isArray(card.risk) && card.risk.length > 0) || (card.riskSignals?.length ?? 0) > 0;
  const hasEvidence =
    card.type === "mission" &&
    Array.isArray((card as { mission?: { evidence?: unknown[] } }).mission?.evidence) &&
    ((card as { mission?: { evidence?: unknown[] } }).mission?.evidence?.length ?? 0) > 0;
  const hasGate = Boolean(card.waitingOn);
  if (!hasState && !hasRisk && !hasEvidence && !hasGate) return null;

  return (
    <div className="hm-card-badges" data-h4 role="list" aria-label="Card badges">
      <StateBadge card={card} />
      <RiskBadges card={card} />
      <EvidenceBadges card={card} />
      <GateBadge card={card} />
      {card.isDraft ? <span className="h4-badge h4-badge--risk h4-tone--tel" title="draft">draft</span> : null}
    </div>
  );
}
