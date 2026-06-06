import { describe, expect, it } from "vitest";
import { derivePresence, activeCount } from "./presence.js";
import type { BoardCard } from "./card-types.js";

const NOW = Date.parse("2026-06-06T12:00:00Z");

function card(workingNow?: { agent: string; label?: string }): BoardCard {
  return { id: "c", type: "pr", ...(workingNow ? { workingNow: { ...workingNow, source: "runner" } } : {}) } as unknown as BoardCard;
}
function msg(author: string, agoMs: number) {
  return { author, ts: NOW - agoMs };
}

describe("derivePresence", () => {
  it("marks an agent with real in-flight work (workingNow) as active", () => {
    const peers = derivePresence({ messages: [], cards: [card({ agent: "codex", label: "Codex fixing" })], nowMs: NOW });
    expect(peers).toHaveLength(1);
    expect(peers[0]).toMatchObject({ agent: "codex", presence: "active", detail: "Codex fixing" });
  });

  it("marks a recent collaboration author as online", () => {
    const peers = derivePresence({ messages: [msg("claude", 2 * 60_000)], cards: [], nowMs: NOW });
    expect(peers).toEqual([{ agent: "claude", presence: "online" }]);
  });

  it("active wins over online for the same agent", () => {
    const peers = derivePresence({
      messages: [msg("codex", 1_000)],
      cards: [card({ agent: "codex", label: "working" })],
      nowMs: NOW,
    });
    expect(peers).toHaveLength(1);
    expect(peers[0]!.presence).toBe("active");
  });

  it("excludes authors older than the online window, and 'everyone'", () => {
    const peers = derivePresence({
      messages: [msg("claude", 30 * 60_000), msg("everyone", 1_000)],
      cards: [],
      nowMs: NOW,
    });
    expect(peers).toEqual([]);
  });

  it("orders active before online, then by name; activeCount counts the active tier", () => {
    const peers = derivePresence({
      messages: [msg("docs", 1_000), msg("claude", 1_000)],
      cards: [card({ agent: "codex" }), card({ agent: "hermes" })],
      nowMs: NOW,
    });
    expect(peers.map((p) => `${p.agent}:${p.presence}`)).toEqual([
      "codex:active",
      "hermes:active",
      "claude:online",
      "docs:online",
    ]);
    expect(activeCount(peers)).toBe(2);
  });

  it("is honestly empty when there is no live signal", () => {
    expect(derivePresence({ messages: [], cards: [card()], nowMs: NOW })).toEqual([]);
  });
});
