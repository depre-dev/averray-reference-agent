// Recent reward-bank moves. The sentence is the backend's `line`.
//
// This sits under the venue lane and the deposit pool. It does not change
// either of those: a lane that was never wired still renders nothing, and a
// failed move read says `not reported` instead of borrowing the lane's rows.

import { bankMovesView, type BankMovesReading } from "../../lib/monitor/bank-moves.js";

export function BankMovesList({ reading }: { reading: BankMovesReading | undefined }) {
  const view = bankMovesView(reading);
  return (
    <section
      className="ops-bank-moves"
      data-testid="ops-bank-moves"
      data-state={view.kind}
      aria-label="Recent bank moves"
    >
      <h3 className="ops-bank-moves-title">RECENT MOVES</h3>
      {view.kind === "not-reported" ? (
        <p className="ops-bank-moves-status" data-testid="ops-bank-moves-status">not reported</p>
      ) : view.kind === "none" ? (
        <p className="ops-bank-moves-status" data-testid="ops-bank-moves-status">none in window</p>
      ) : (
        <ol className="ops-bank-moves-list">
          {view.lines.map((move) => (
            <li key={move.id} className="ops-bank-move" data-testid="ops-bank-move">{move.line}</li>
          ))}
        </ol>
      )}
      {view.kind === "lines" && view.incomplete ? (
        <p className="ops-bank-moves-status" data-testid="ops-bank-moves-gap">remainder not reported</p>
      ) : null}
      {view.kind === "lines" && view.withheld > 0 ? (
        <p className="ops-bank-moves-status" data-testid="ops-bank-moves-withheld">
          {view.withheld} older moves withheld
        </p>
      ) : null}
    </section>
  );
}
