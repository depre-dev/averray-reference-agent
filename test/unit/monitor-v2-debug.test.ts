import { afterEach, describe, expect, it } from "vitest";

import {
  MONITOR_V2_DEBUG_SPAWN_ENV,
  clearDebugCards,
  getDebugCards,
  isDebugSpawnEnabled,
  mergeDebugCards,
  onDebugCardSpawned,
  spawnDebugCard,
} from "../../services/slack-operator/src/monitor-v2-debug.js";
import type { BoardSnapshotV2 } from "../../services/slack-operator/src/monitor-v2.js";

afterEach(() => {
  clearDebugCards();
});

describe("isDebugSpawnEnabled", () => {
  it("is true only when MONITOR_V2_DEBUG_SPAWN === '1'", () => {
    expect(isDebugSpawnEnabled({ [MONITOR_V2_DEBUG_SPAWN_ENV]: "1" })).toBe(true);
    expect(isDebugSpawnEnabled({ [MONITOR_V2_DEBUG_SPAWN_ENV]: "0" })).toBe(false);
    expect(isDebugSpawnEnabled({ [MONITOR_V2_DEBUG_SPAWN_ENV]: "true" })).toBe(false);
    expect(isDebugSpawnEnabled({})).toBe(false);
  });
});

describe("spawnDebugCard", () => {
  it("builds a synthetic card with safe defaults from an empty body", () => {
    const card = spawnDebugCard({}, { defaultRepo: "depre-dev/agent" });
    expect(card.id).toMatch(/^debug #\d+$/);
    expect(card.lane).toBe("operator-review");
    expect(card.type).toBe("pr");
    expect(card.agentType).toBe("claude");
    expect(card.title).toBe("Debug spawn card");
    expect(card.repo).toBe("depre-dev/agent");
    expect(card.state).toBe("fresh");
    expect(card.freshness).toBe(0);
    expect(card.risk).toEqual([]);
    expect(card.waitingOn).toEqual({ actor: "operator", tone: "info" });
  });

  it("honours valid overrides", () => {
    const card = spawnDebugCard({
      id: "agent #999",
      lane: "deploying",
      type: "deploy",
      agentType: "ext",
      title: "Verify XCM settlement",
      summary: "watching the relay",
      repo: "depre-dev/site",
      branch: "main",
      freshness: 12,
      state: "running",
      risk: ["xcm", "indexer"],
      waitingOn: { actor: "relay", tone: "warn" },
      isAction: true,
      verdict: "looks good",
    });
    expect(card.id).toBe("agent #999");
    expect(card.lane).toBe("deploying");
    expect(card.type).toBe("deploy");
    expect(card.agentType).toBe("ext");
    expect(card.branch).toBe("main");
    expect(card.freshness).toBe(12);
    expect(card.state).toBe("running");
    expect(card.risk).toEqual(["xcm", "indexer"]);
    expect(card.waitingOn).toEqual({ actor: "relay", tone: "warn" });
    expect(card.isAction).toBe(true);
    expect(card.verdict).toBe("looks good");
  });

  it("falls back to defaults for invalid enum values and filters bogus risk tags", () => {
    const card = spawnDebugCard({
      lane: "nowhere",
      type: "spaceship",
      agentType: "robot",
      state: "melted",
      risk: ["xcm", "not-a-risk", 42],
      waitingOn: { actor: "ceo", tone: "loud" },
    });
    expect(card.lane).toBe("operator-review");
    expect(card.type).toBe("pr");
    expect(card.agentType).toBe("claude");
    expect(card.state).toBe("fresh");
    expect(card.risk).toEqual(["xcm"]);
    expect(card.waitingOn).toEqual({ actor: "operator", tone: "info" });
  });

  it("coerces a non-object body without throwing", () => {
    expect(() => spawnDebugCard("not an object")).not.toThrow();
    expect(() => spawnDebugCard(null)).not.toThrow();
    expect(getDebugCards().length).toBe(2);
  });

  it("accumulates cards and replaces on id collision", () => {
    spawnDebugCard({ id: "a", title: "first" });
    spawnDebugCard({ id: "b", title: "second" });
    expect(getDebugCards().map((c) => c.id)).toEqual(["a", "b"]);

    spawnDebugCard({ id: "a", title: "first-updated" });
    const cards = getDebugCards();
    expect(cards.map((c) => c.id)).toEqual(["b", "a"]);
    expect(cards.find((c) => c.id === "a")?.title).toBe("first-updated");
  });

  it("caps the store at 50 cards", () => {
    for (let i = 0; i < 55; i += 1) spawnDebugCard({ id: `card-${i}` });
    expect(getDebugCards().length).toBe(50);
    // The oldest were evicted; the newest survive.
    expect(getDebugCards().some((c) => c.id === "card-54")).toBe(true);
    expect(getDebugCards().some((c) => c.id === "card-0")).toBe(false);
  });
});

describe("onDebugCardSpawned", () => {
  it("notifies subscribers with the spawned card and stops after unsubscribe", () => {
    const seen: string[] = [];
    const off = onDebugCardSpawned((card) => seen.push(card.id));

    spawnDebugCard({ id: "x" });
    expect(seen).toEqual(["x"]);

    off();
    spawnDebugCard({ id: "y" });
    expect(seen).toEqual(["x"]);
  });

  it("a throwing subscriber does not break the spawn", () => {
    const off = onDebugCardSpawned(() => {
      throw new Error("boom");
    });
    expect(() => spawnDebugCard({ id: "z" })).not.toThrow();
    expect(getDebugCards().some((c) => c.id === "z")).toBe(true);
    off();
  });
});

describe("mergeDebugCards", () => {
  const snapshot: BoardSnapshotV2 = {
    cards: [{ id: "real #1", lane: "hermes-checking", type: "pr", agentType: "codex", title: "real", summary: "", repo: "r", freshness: 1, state: "fresh", risk: [], waitingOn: { actor: "CI", tone: "info" } }],
    at: "2026-05-28T10:00:00Z",
    repo: "r",
  };

  it("returns the snapshot unchanged when the store is empty", () => {
    expect(mergeDebugCards(snapshot)).toBe(snapshot);
  });

  it("appends debug cards to the snapshot", () => {
    spawnDebugCard({ id: "debug-a" });
    const merged = mergeDebugCards(snapshot);
    expect(merged.cards.map((c) => c.id)).toEqual(["real #1", "debug-a"]);
    expect(merged.at).toBe(snapshot.at);
  });

  it("lets a debug card override a real card with the same id", () => {
    spawnDebugCard({ id: "real #1", title: "debug override" });
    const merged = mergeDebugCards(snapshot);
    expect(merged.cards.length).toBe(1);
    expect(merged.cards[0]?.title).toBe("debug override");
  });
});
