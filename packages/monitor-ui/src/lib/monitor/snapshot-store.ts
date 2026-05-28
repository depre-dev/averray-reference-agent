// Hermes Handoff Monitor — localStorage snapshot writer.
//
// Records timestamped board snapshots so a future time-travel UI (v1.1)
// can page back through "what did the board look like at 14:30?".
//
// Per §21 decision #4: localStorage, key `monitor.snapshot.<isoTimestamp>`,
// 24h sliding TTL. M5' writes; v1.1 reads. Pure functions — no React.

const KEY_PREFIX = "monitor.snapshot.";
const TTL_MS = 24 * 60 * 60 * 1000;

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  readonly length: number;
  key(index: number): string | null;
}

export interface SnapshotPayload {
  at: string;
  cards: unknown[];
}

function resolveStorage(override?: StorageLike): StorageLike {
  if (override) return override;
  if (typeof globalThis !== "undefined" && (globalThis as { localStorage?: StorageLike }).localStorage) {
    return (globalThis as unknown as { localStorage: StorageLike }).localStorage;
  }
  return noopStorage();
}

function noopStorage(): StorageLike {
  return {
    getItem: () => null,
    setItem: () => undefined,
    removeItem: () => undefined,
    length: 0,
    key: () => null,
  };
}

export interface WriteSnapshotOpts {
  storage?: StorageLike;
  now?: () => number;
  ttlMs?: number;
}

/** Write a snapshot + evict entries older than the sliding TTL. */
export function writeSnapshot(
  snapshot: SnapshotPayload,
  opts: WriteSnapshotOpts = {}
): { key: string; evicted: number } {
  const storage = resolveStorage(opts.storage);
  const now = opts.now ?? (() => Date.now());
  const ttlMs = opts.ttlMs ?? TTL_MS;

  const key = `${KEY_PREFIX}${snapshot.at}`;
  try {
    storage.setItem(key, JSON.stringify(snapshot));
  } catch {
    // Quota exceeded / disabled / private-mode: evict + retry once.
    evictExpired(storage, now(), ttlMs);
    try {
      storage.setItem(key, JSON.stringify(snapshot));
    } catch {
      return { key, evicted: 0 };
    }
  }

  const evicted = evictExpired(storage, now(), ttlMs);
  return { key, evicted };
}

/** Every snapshot's `at` timestamp, sorted oldest → newest. */
export function listSnapshotTimestamps(opts: { storage?: StorageLike } = {}): string[] {
  const storage = resolveStorage(opts.storage);
  const stamps: string[] = [];
  for (let i = 0; i < storage.length; i += 1) {
    const k = storage.key(i);
    if (typeof k === "string" && k.startsWith(KEY_PREFIX)) {
      stamps.push(k.slice(KEY_PREFIX.length));
    }
  }
  stamps.sort();
  return stamps;
}

/** Read one snapshot by its `at` timestamp, or undefined if absent/corrupt. */
export function readSnapshot(at: string, opts: { storage?: StorageLike } = {}): SnapshotPayload | undefined {
  const storage = resolveStorage(opts.storage);
  const raw = storage.getItem(`${KEY_PREFIX}${at}`);
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as SnapshotPayload;
  } catch {
    return undefined;
  }
}

/** Evict snapshots older than now - ttl. Returns count evicted. */
export function evictExpired(storage: StorageLike, nowMs: number, ttlMs: number): number {
  const candidates: string[] = [];
  for (let i = 0; i < storage.length; i += 1) {
    const k = storage.key(i);
    if (typeof k === "string" && k.startsWith(KEY_PREFIX)) {
      const iso = k.slice(KEY_PREFIX.length);
      const ts = Date.parse(iso);
      if (Number.isFinite(ts) && nowMs - ts > ttlMs) {
        candidates.push(k);
      }
    }
  }
  for (const k of candidates) {
    try {
      storage.removeItem(k);
    } catch {
      /* ignore */
    }
  }
  return candidates.length;
}

export const SNAPSHOT_KEY_PREFIX = KEY_PREFIX;
export const SNAPSHOT_TTL_MS = TTL_MS;
