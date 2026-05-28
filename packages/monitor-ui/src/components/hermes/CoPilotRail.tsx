// Hermes Handoff Monitor — co-pilot rail (M7' shell).
//
// The right-hand rail: header + (M8') narration stream + the Ask-Hermes
// composer. M7' wires the composer's /mission spawn flow; the live
// card-stream narration and free-form Q&A land in M8', filling the
// stream region that is a stub here.

import { AskHermesComposer } from "./AskHermesComposer.js";

export interface CoPilotRailProps {
  onSpawnMission?: (url: string) => void;
  onAsk?: (text: string) => void;
  focusedCardId?: string | null;
}

export function CoPilotRail({ onSpawnMission, onAsk, focusedCardId }: CoPilotRailProps) {
  return (
    <aside className="hm-hermes" role="complementary" aria-label="Hermes co-pilot">
      {/* A <div>, not <header>: only the TopStrip is the page banner
          landmark — the rail's own header must not register as a second. */}
      <div className="hm-hermes-head">
        <div className="hm-hermes-mark" aria-hidden>
          H
        </div>
        <div>
          <div className="hm-hermes-title">Hermes co-pilot</div>
          <div className="hm-hermes-sub">
            <span className="pulse" aria-hidden />
            Live · narrating the board · context: {focusedCardId ?? "everywhere"}
          </div>
        </div>
      </div>

      <div className="hm-hermes-stream">
        <div className="hm-lane-empty">Board narration lands in M8'.</div>
      </div>

      <AskHermesComposer onSpawnMission={onSpawnMission} onAsk={onAsk} focusedCardId={focusedCardId} />
    </aside>
  );
}
