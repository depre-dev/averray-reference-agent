// Per-card Hermes failure analysis cache (feature: grounded failure analysis
// for operator decision cards).
//
// When HERMES_FAILURE_ANALYSIS is on and the gateway session is available, the
// failure-analysis routine asks the real agentic Hermes for ONE short grounded
// paragraph explaining why a failed operator-decision card likely failed and a
// recommended next step (fix vs rollback). That paragraph is cached HERE, keyed
// by card id, together with a hash of the failure context it was grounded in.
// The board threads a cached entry back onto the card ONLY when the stored hash
// still matches the card's current failure context, so a stale analysis for a
// changed failure is never shown — the routine re-runs when the failure moves.
//
// This mirrors operator-card-notes.ts (the per-card JSON store pattern) and is
// file-backed on /data so it survives a restart. Unlike operator notes this
// store IS board-facing (it is threaded onto the card the operator reads), but
// it carries ONLY Hermes's own grounded read of the card's real failure fields
// — no operator-private text ever flows through it.

import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { optionalEnv } from "@avg/mcp-common";

/** One cached Hermes failure analysis for a card. */
export interface CardFailureAnalysis {
  /** The grounded analysis paragraph (Hermes's agentic read). */
  text: string;
  /** Model the gateway ran the turn on, when reported. */
  model?: string;
  /** When the analysis was produced (ISO). */
  at: string;
  /**
   * Hash of the failure context the analysis was grounded in. The board only
   * surfaces the analysis while this still matches the card's current failure —
   * so a changed failure invalidates the cache and the routine re-runs.
   */
  failureHash: string;
}

function analysisPath(path?: string): string {
  return (
    path ??
    optionalEnv("AVERRAY_CARD_FAILURE_ANALYSIS_PATH", "/data/card-failure-analysis.json") ??
    "/data/card-failure-analysis.json"
  );
}

type AnalysisFile = Record<string, CardFailureAnalysis>;

function readFile(path?: string): AnalysisFile {
  const p = analysisPath(path);
  try {
    if (!existsSync(p)) return {};
    const raw = JSON.parse(readFileSync(p, "utf8")) as unknown;
    return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as AnalysisFile) : {};
  } catch {
    return {};
  }
}

/** Read a card's cached failure analysis, or undefined when none is stored. */
export function readCardFailureAnalysis(cardId: string, path?: string): CardFailureAnalysis | undefined {
  const stored = readFile(path)[cardId];
  return normalizeAnalysis(stored);
}

/**
 * Read a card's cached failure analysis ONLY when it is fresh for the given
 * failure hash. Returns undefined when nothing is stored, or when the stored
 * analysis was grounded in a different (now-stale) failure context. This is the
 * single freshness gate the board threading + routine share.
 */
export function readFreshCardFailureAnalysis(
  cardId: string,
  failureHash: string,
  path?: string,
): CardFailureAnalysis | undefined {
  const stored = readCardFailureAnalysis(cardId, path);
  if (!stored) return undefined;
  return stored.failureHash === failureHash ? stored : undefined;
}

/** Persist a card's failure analysis. Returns the stored value. */
export function writeCardFailureAnalysis(
  cardId: string,
  value: { text: string; model?: string; failureHash: string },
  now: () => Date = () => new Date(),
  path?: string,
): CardFailureAnalysis {
  const file = readFile(path);
  const next: CardFailureAnalysis = {
    text: value.text,
    ...(value.model ? { model: value.model } : {}),
    failureHash: value.failureHash,
    at: now().toISOString(),
  };
  file[cardId] = next;
  const p = analysisPath(path);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, `${JSON.stringify(file, null, 2)}\n`);
  return next;
}

function normalizeAnalysis(value: unknown): CardFailureAnalysis | undefined {
  const record = (value && typeof value === "object" && !Array.isArray(value) ? value : undefined) as
    | Partial<CardFailureAnalysis>
    | undefined;
  if (!record) return undefined;
  const text = typeof record.text === "string" ? record.text.trim() : "";
  const failureHash = typeof record.failureHash === "string" ? record.failureHash : "";
  const at = typeof record.at === "string" ? record.at : "";
  if (!text || !failureHash) return undefined;
  return {
    text,
    ...(typeof record.model === "string" && record.model ? { model: record.model } : {}),
    failureHash,
    at,
  };
}
