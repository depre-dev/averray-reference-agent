import { test, assert } from "vitest";

import {
  DEFAULT_TITLE,
  MUTE_STORAGE_KEY,
  documentTitleFor,
  isMuted,
  parseMuteArg,
  readMuteUntil,
  shouldAlert,
  writeMuteUntil,
} from "./notifications.js";
import type { StorageLike } from "./snapshot-store.js";

function memStorage(): StorageLike {
  const m = new Map<string, string>();
  return {
    getItem: (k) => (m.has(k) ? (m.get(k) as string) : null),
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
    get length() {
      return m.size;
    },
    key: (i) => Array.from(m.keys())[i] ?? null,
  };
}

test("documentTitleFor prefixes a count only when action is needed", () => {
  assert.equal(documentTitleFor(0), DEFAULT_TITLE);
  assert.equal(documentTitleFor(3), `(3) ${DEFAULT_TITLE}`);
  assert.equal(documentTitleFor(-1), DEFAULT_TITLE);
  assert.equal(documentTitleFor(2, "X"), "(2) X");
});

test("shouldAlert fires only on the 0 → >0 edge", () => {
  assert.equal(shouldAlert(0, 1), true);
  assert.equal(shouldAlert(0, 3), true);
  assert.equal(shouldAlert(1, 2), false); // already alerting
  assert.equal(shouldAlert(2, 0), false); // cleared
  assert.equal(shouldAlert(0, 0), false);
});

test("parseMuteArg: bare mute defaults to one hour", () => {
  const now = () => 1_000_000;
  const r = parseMuteArg("", now);
  assert.ok(r.ok && r.untilMs === 1_000_000 + 3_600_000);
});

test("parseMuteArg: relative durations", () => {
  const now = () => 0;
  const m30 = parseMuteArg("30m", now);
  assert.ok(m30.ok && m30.untilMs === 30 * 60_000);
  const h2 = parseMuteArg("2h", now);
  assert.ok(h2.ok && h2.untilMs === 2 * 3_600_000);
});

test("parseMuteArg: clock times resolve to a future instant within 24h", () => {
  const now = () => Date.parse("2026-05-28T12:00:00");
  const am9 = parseMuteArg("until 9am", now);
  assert.ok(am9.ok);
  if (am9.ok) {
    // 9am already passed at noon → next day's 9am.
    assert.ok(am9.untilMs > now());
    assert.ok(am9.untilMs - now() <= 24 * 3_600_000);
    assert.equal(new Date(am9.untilMs).getHours(), 9);
  }
});

test("parseMuteArg: rejects nonsense", () => {
  assert.equal(parseMuteArg("soon").ok, false);
  assert.equal(parseMuteArg("0h").ok, false);
  assert.equal(parseMuteArg("until 99:99").ok, false);
});

test("isMuted reflects the expiry vs now", () => {
  const now = () => 100;
  assert.equal(isMuted(200, now), true);
  assert.equal(isMuted(50, now), false);
  assert.equal(isMuted(null, now), false);
  assert.equal(isMuted(undefined, now), false);
});

test("read/write mute round-trips and clears", () => {
  const s = memStorage();
  assert.equal(readMuteUntil(s), null);
  writeMuteUntil(s, 12345);
  assert.equal(s.getItem(MUTE_STORAGE_KEY), "12345");
  assert.equal(readMuteUntil(s), 12345);
  writeMuteUntil(s, null);
  assert.equal(readMuteUntil(s), null);
});
