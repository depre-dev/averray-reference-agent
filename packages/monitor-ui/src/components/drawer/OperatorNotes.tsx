// Operator checklist + private note (G4). Persisted per card via
// /monitor/cards/:id/operator-notes. OPERATOR-PRIVATE: the note is the
// operator's own scratchpad — it is never included in any agent-facing payload.

import { useOperatorNotes, type UseOperatorNotesOptions } from "../../hooks/useOperatorNotes.js";

export interface OperatorNotesProps {
  cardId: string;
  /** Override the notes wiring (GET/PUT) for tests. */
  options?: UseOperatorNotesOptions;
}

export function OperatorNotes({ cardId, options }: OperatorNotesProps) {
  const { notes, loading, saving, toggleItem, setNote, save } = useOperatorNotes(cardId, options ?? {});

  return (
    <section className="hm-operator-notes" aria-label="Operator checklist and private note">
      <div className="hm-section-h">Operator checklist &amp; note</div>
      <p className="hm-muted" style={{ fontSize: 11, margin: "0 0 8px" }}>
        Operator-private — never shared with agents.
      </p>

      {loading ? (
        <div className="hm-muted" style={{ fontSize: 12 }}>Loading your notes…</div>
      ) : (
        <>
          <ul className="hm-operator-checklist" style={{ listStyle: "none", padding: 0, margin: "0 0 10px" }}>
            {(notes?.checklist ?? []).map((item) => (
              <li key={item.id} style={{ marginBottom: 4 }}>
                <label style={{ display: "flex", gap: 8, alignItems: "center", cursor: "pointer" }}>
                  <input
                    type="checkbox"
                    checked={item.done}
                    onChange={() => toggleItem(item.id)}
                    aria-label={item.label}
                  />
                  <span style={item.done ? { textDecoration: "line-through", color: "var(--hm-muted)" } : undefined}>
                    {item.label}
                  </span>
                </label>
              </li>
            ))}
          </ul>

          <label className="hm-muted" style={{ fontSize: 11, display: "block", marginBottom: 4 }}>
            Private note
          </label>
          <textarea
            className="hm-operator-note"
            aria-label="Operator-private note"
            value={notes?.note ?? ""}
            placeholder="Private note for yourself — never sent to any agent…"
            onChange={(e) => setNote(e.target.value)}
            onBlur={save}
            rows={3}
            style={{ width: "100%", resize: "vertical" }}
          />
          <div style={{ marginTop: 6, display: "flex", alignItems: "center", gap: 8 }}>
            <button type="button" className="hm-btn hm-btn--ghost" onClick={save} disabled={saving}>
              {saving ? "Saving…" : "Save note"}
            </button>
          </div>
        </>
      )}
    </section>
  );
}
