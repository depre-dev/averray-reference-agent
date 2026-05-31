// Hermes Handoff Monitor — dev-only debug card spawner.
//
// Acceptance vehicle for "spawn a card via the API, see it appear in the
// UI within 500ms" (spec §6, M5'). Gated behind MONITOR_V2_DEBUG_SPAWN=1;
// when that env is unset the route 404s and this store stays empty, so
// production behaviour is unchanged.
//
// A spawned card is SYNTHETIC by construction (default title "Debug spawn
// card") and lives only in memory (lost on restart). It is:
//   - merged into every v2 snapshot so it survives the periodic
//     full-snapshot replace the SSE stream pushes, and
//   - broadcast to live SSE connections as board.card.added so it lands
//     within milliseconds rather than on the next poll.
//
// Replaced by real GitHub/Codex/Hermes ingestion as those milestones land.

import type {
  AgentType,
  BoardCard,
  BoardSnapshotV2,
  CardState,
  CardType,
  Lane,
  RiskTag,
  WaitingOn,
} from "./monitor-v2.js";

export const MONITOR_V2_DEBUG_SPAWN_ENV = "MONITOR_V2_DEBUG_SPAWN";
const MAX_DEBUG_CARDS = 50;

const LANES: readonly Lane[] = [
  "needs-attention",
  "drafts",
  "codex-needed",
  "hermes-checking",
  "operator-review",
  "release-queue",
  "deploying",
  "done",
];
const CARD_TYPES: readonly CardType[] = ["pr", "mission", "task", "deploy", "draft", "done"];
const AGENT_TYPES: readonly AgentType[] = ["claude", "codex", "test-writer", "hermes", "ext"];
const CARD_STATES: readonly CardState[] = ["fresh", "stale", "failed-fetch", "source-offline", "running"];
const RISK_TAGS: readonly RiskTag[] = [
  "workflow",
  "config",
  "review-gated",
  "contracts",
  "secrets",
  "indexer",
  "xcm",
  "docs",
  "testbed",
  "ui-only",
  "deps",
  "quality",
];
const WAITING_ACTORS: readonly WaitingOn["actor"][] = [
  "operator",
  "author",
  "agent",
  "CI",
  "relay",
  "branch-protection",
];
const WAITING_TONES: readonly WaitingOn["tone"][] = ["warn", "info", "neutral"];

let store: BoardCard[] = [];
let counter = 0;
const subscribers = new Set<(card: BoardCard) => void>();

/** Dev-only gate. The route 404s unless MONITOR_V2_DEBUG_SPAWN=1. */
export function isDebugSpawnEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[MONITOR_V2_DEBUG_SPAWN_ENV] === "1";
}

export interface SpawnDebugCardOptions {
  /** Repo to stamp on the card when the body omits one. */
  defaultRepo?: string;
}

/**
 * Coerce an arbitrary request body into a valid BoardCard with sensible
 * synthetic defaults, store it (replacing any same-id card, capped), and
 * notify subscribers (live SSE connections). Unknown enum values fall
 * back to defaults rather than erroring — this is a forgiving dev tool.
 */
export function spawnDebugCard(input: unknown, opts: SpawnDebugCardOptions = {}): BoardCard {
  const body = isRecord(input) ? input : {};
  counter += 1;

  const card: BoardCard = {
    id: nonEmptyString(body.id) ?? `debug #${counter}`,
    lane: oneOf(body.lane, LANES, "operator-review"),
    type: oneOf(body.type, CARD_TYPES, "pr"),
    agentType: oneOf(body.agentType, AGENT_TYPES, "claude"),
    title: nonEmptyString(body.title) ?? "Debug spawn card",
    summary:
      typeof body.summary === "string"
        ? body.summary
        : "Synthetic card injected via /monitor/v2/debug/spawn for pipeline testing.",
    repo: nonEmptyString(body.repo) ?? opts.defaultRepo ?? "debug/local",
    freshness:
      typeof body.freshness === "number" && Number.isFinite(body.freshness) && body.freshness >= 0
        ? body.freshness
        : 0,
    state: oneOf(body.state, CARD_STATES, "fresh"),
    risk: Array.isArray(body.risk) ? body.risk.filter((r): r is RiskTag => RISK_TAGS.includes(r as RiskTag)) : [],
    waitingOn: parseWaitingOn(body.waitingOn),
  };

  const branch = nonEmptyString(body.branch);
  if (branch) card.branch = branch;
  if (body.isAction === true) card.isAction = true;
  if (body.isDraft === true) card.isDraft = true;
  if (body.archiveHint === true) card.archiveHint = true;
  if (typeof body.next === "string") card.next = body.next;
  if (typeof body.verdict === "string") card.verdict = body.verdict;

  // Re-spawning an id replaces the prior card; keep only the newest N.
  store = store.filter((c) => c.id !== card.id);
  store.push(card);
  if (store.length > MAX_DEBUG_CARDS) store = store.slice(-MAX_DEBUG_CARDS);

  for (const fn of subscribers) {
    try {
      fn(card);
    } catch {
      /* a thrown subscriber must never break the spawn */
    }
  }

  return card;
}

/** Snapshot of the current in-memory debug cards. */
export function getDebugCards(): BoardCard[] {
  return store.slice();
}

/** Drop all debug cards (used by tests and a future clear endpoint). */
export function clearDebugCards(): void {
  store = [];
}

/** Subscribe to spawns (live SSE connections). Returns an unsubscribe fn. */
export function onDebugCardSpawned(fn: (card: BoardCard) => void): () => void {
  subscribers.add(fn);
  return () => {
    subscribers.delete(fn);
  };
}

/**
 * Append the in-memory debug cards to a snapshot so they survive the
 * periodic full-snapshot replace. Debug cards win on id collision. A
 * no-op (returns the same object) when the store is empty — i.e. always,
 * in production.
 */
export function mergeDebugCards(snapshot: BoardSnapshotV2): BoardSnapshotV2 {
  if (store.length === 0) return snapshot;
  const ids = new Set(store.map((c) => c.id));
  const base = snapshot.cards.filter((c) => !ids.has(c.id));
  return { ...snapshot, cards: [...base, ...store] };
}

// ── helpers ─────────────────────────────────────────────────────────

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function nonEmptyString(v: unknown): string | undefined {
  return typeof v === "string" && v.trim().length > 0 ? v : undefined;
}

function oneOf<T>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

function parseWaitingOn(value: unknown): WaitingOn {
  if (isRecord(value)) {
    return {
      actor: oneOf(value.actor, WAITING_ACTORS, "operator"),
      tone: oneOf(value.tone, WAITING_TONES, "info"),
    };
  }
  return { actor: "operator", tone: "info" };
}
