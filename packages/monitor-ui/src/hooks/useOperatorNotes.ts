// Operator-private per-card notes hook (G4).
//
// GETs the card's checklist + note on mount and PUTs on save, against
// /monitor/cards/:id/operator-notes. OPERATOR-PRIVATE: this data is the
// operator's own; it is never part of any agent-facing payload. Network is
// guarded + injectable so it's inert in tests that don't wire it.

import { useCallback, useEffect, useState } from "react";

export interface OperatorChecklistItem {
  id: string;
  label: string;
  done: boolean;
}

export interface OperatorCardNotesValue {
  checklist: OperatorChecklistItem[];
  note: string;
}

export interface UseOperatorNotesOptions {
  fetchNotes?: (cardId: string) => Promise<OperatorCardNotesValue | null>;
  saveNotes?: (cardId: string, value: OperatorCardNotesValue) => Promise<OperatorCardNotesValue | null>;
}

export interface UseOperatorNotes {
  notes: OperatorCardNotesValue | null;
  loading: boolean;
  saving: boolean;
  toggleItem: (id: string) => void;
  setNote: (note: string) => void;
  save: () => void;
}

function url(cardId: string): string {
  return `/monitor/cards/${encodeURIComponent(cardId)}/operator-notes`;
}

function canFetch(): boolean {
  return typeof fetch === "function";
}

async function defaultFetchNotes(cardId: string): Promise<OperatorCardNotesValue | null> {
  if (!canFetch()) return null;
  try {
    const res = await fetch(url(cardId), { method: "GET" });
    if (!res.ok) return null;
    const json = (await res.json()) as { notes?: OperatorCardNotesValue };
    return json.notes ?? null;
  } catch {
    return null;
  }
}

async function defaultSaveNotes(cardId: string, value: OperatorCardNotesValue): Promise<OperatorCardNotesValue | null> {
  if (!canFetch()) return null;
  try {
    const res = await fetch(url(cardId), {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(value),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { notes?: OperatorCardNotesValue };
    return json.notes ?? null;
  } catch {
    return null;
  }
}

export function useOperatorNotes(cardId: string, options: UseOperatorNotesOptions = {}): UseOperatorNotes {
  const fetchNotes = options.fetchNotes ?? defaultFetchNotes;
  const saveNotes = options.saveNotes ?? defaultSaveNotes;
  const [notes, setNotes] = useState<OperatorCardNotesValue | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let active = true;
    setLoading(true);
    void fetchNotes(cardId).then((value) => {
      if (!active) return;
      setNotes(value);
      setLoading(false);
    });
    return () => {
      active = false;
    };
    // Re-fetch when the card changes; fetchNotes is stable for the page lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cardId]);

  const persist = useCallback(
    (value: OperatorCardNotesValue) => {
      setSaving(true);
      void saveNotes(cardId, value).then((saved) => {
        if (saved) setNotes(saved);
        setSaving(false);
      });
    },
    [cardId, saveNotes],
  );

  const toggleItem = useCallback((id: string) => {
    setNotes((prev) => {
      if (!prev) return prev;
      const next = { ...prev, checklist: prev.checklist.map((i) => (i.id === id ? { ...i, done: !i.done } : i)) };
      // A checkbox toggle persists immediately.
      setSaving(true);
      void saveNotes(cardId, next).then((saved) => {
        setNotes((cur) => saved ?? cur);
        setSaving(false);
      });
      return next;
    });
  }, [cardId, saveNotes]);

  const setNote = useCallback((note: string) => {
    setNotes((prev) => (prev ? { ...prev, note } : { checklist: [], note }));
  }, []);

  const save = useCallback(() => {
    if (notes) persist(notes);
  }, [notes, persist]);

  return { notes, loading, saving, toggleItem, setNote, save };
}
