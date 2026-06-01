// Operator-private per-card notes (checklist + free-text note).
//
// PRIVACY INVARIANT — load-bearing: this store is OPERATOR-PRIVATE. It is read
// and written ONLY by the monitor's operator-notes endpoint (the operator's own
// browser). It is NEVER imported into any agent-facing payload — not the board
// snapshot an agent/Hermes reads, not the collaboration channel, not a handoff
// event, not an MCP context. Keeping it in its own file/module (never merged
// into a card or a mission/agent payload) is what guarantees that. A test
// asserts the note is absent from the agent-facing board snapshot.
//
// File-backed on /data so it survives a restart (mirrors autonomy-mode.ts).

import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { optionalEnv } from "@avg/mcp-common";

export interface OperatorChecklistItem {
  id: string;
  label: string;
  done: boolean;
}

export interface OperatorCardNotes {
  checklist: OperatorChecklistItem[];
  /** Operator-private free-text note. NEVER sent to any agent. */
  note: string;
  updatedAt?: string;
}

/** The default operator-review checklist offered for a card with no saved state. */
export const DEFAULT_OPERATOR_CHECKLIST: ReadonlyArray<Omit<OperatorChecklistItem, "done">> = [
  { id: "read-diff", label: "Read the diff / report" },
  { id: "ci-green", label: "CI is green" },
  { id: "risk-intent", label: "Risk + intent are clear" },
  { id: "safe-to-proceed", label: "Safe to dispatch / merge" },
];

export function defaultOperatorCardNotes(): OperatorCardNotes {
  return { checklist: DEFAULT_OPERATOR_CHECKLIST.map((i) => ({ ...i, done: false })), note: "" };
}

function notesPath(path?: string): string {
  return (
    path ??
    optionalEnv("AVERRAY_OPERATOR_CARD_NOTES_PATH", "/data/operator-card-notes.json") ??
    "/data/operator-card-notes.json"
  );
}

type NotesFile = Record<string, OperatorCardNotes>;

function readFile(path?: string): NotesFile {
  const p = notesPath(path);
  try {
    if (!existsSync(p)) return {};
    const raw = JSON.parse(readFileSync(p, "utf8")) as unknown;
    return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as NotesFile) : {};
  } catch {
    return {};
  }
}

/** Read a card's operator notes, or the default template when none are saved. */
export function readOperatorCardNotes(cardId: string, path?: string): OperatorCardNotes {
  const stored = readFile(path)[cardId];
  if (!stored) return defaultOperatorCardNotes();
  return {
    checklist: Array.isArray(stored.checklist) ? stored.checklist.map(normalizeItem) : defaultOperatorCardNotes().checklist,
    note: typeof stored.note === "string" ? stored.note : "",
    ...(stored.updatedAt ? { updatedAt: stored.updatedAt } : {}),
  };
}

/** Persist a card's operator notes. Returns the stored value. */
export function writeOperatorCardNotes(
  cardId: string,
  value: { checklist?: OperatorChecklistItem[]; note?: string },
  now: () => Date = () => new Date(),
  path?: string,
): OperatorCardNotes {
  const file = readFile(path);
  const next: OperatorCardNotes = {
    checklist: Array.isArray(value.checklist) ? value.checklist.map(normalizeItem) : defaultOperatorCardNotes().checklist,
    note: typeof value.note === "string" ? value.note : "",
    updatedAt: now().toISOString(),
  };
  file[cardId] = next;
  const p = notesPath(path);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, `${JSON.stringify(file, null, 2)}\n`);
  return next;
}

function normalizeItem(item: unknown): OperatorChecklistItem {
  const record = (item && typeof item === "object" ? item : {}) as Partial<OperatorChecklistItem>;
  return {
    id: typeof record.id === "string" && record.id ? record.id : "item",
    label: typeof record.label === "string" ? record.label : "",
    done: record.done === true,
  };
}
