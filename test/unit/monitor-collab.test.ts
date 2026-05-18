import { beforeEach, describe, expect, it } from "vitest";

import {
  CollaborationValidationError,
  __resetCollaborationStoreForTests,
  listCollaborationMessages,
  recordCollaborationMessage,
} from "../../services/slack-operator/src/monitor-collab.js";

const NOW = Date.UTC(2026, 4, 18, 12, 0, 0);

describe("monitor collaboration channel", () => {
  beforeEach(() => {
    __resetCollaborationStoreForTests();
  });

  it("records a valid operator chat message with defaults", () => {
    const message = recordCollaborationMessage(
      { author: "operator", text: "Codex, pick up #137 next." },
      NOW
    );
    expect(message).toMatchObject({
      author: "operator",
      kind: "chat",
      addressedTo: "everyone",
      text: "Codex, pick up #137 next.",
      ts: NOW,
    });
    expect(message.id).toMatch(/^collab-/);
  });

  it("normalizes author/kind/addressedTo casing and trims text", () => {
    const message = recordCollaborationMessage(
      {
        author: "  Codex  ",
        kind: "PROPOSAL",
        addressedTo: "Hermes",
        text: "   Hermes, please re-check after my last push.   ",
      },
      NOW
    );
    expect(message).toMatchObject({
      author: "codex",
      kind: "proposal",
      addressedTo: "hermes",
      text: "Hermes, please re-check after my last push.",
    });
  });

  it("preserves relatedPr and relatedCorrelationId when well-formed", () => {
    const message = recordCollaborationMessage(
      {
        author: "hermes",
        kind: "request_help",
        text: "Pascal, I cannot resolve a flaky test on #221.",
        addressedTo: "operator",
        relatedPr: { repo: "averray-agent/agent", number: 221 },
        relatedCorrelationId: "smoke-2026-05-18-abc",
      },
      NOW
    );
    expect(message.relatedPr).toEqual({ repo: "averray-agent/agent", number: 221 });
    expect(message.relatedCorrelationId).toBe("smoke-2026-05-18-abc");
  });

  it("drops malformed relatedPr without failing the record", () => {
    const message = recordCollaborationMessage(
      {
        author: "codex",
        text: "Status update.",
        kind: "status",
        relatedPr: { repo: "", number: 0 },
      },
      NOW
    );
    expect(message.relatedPr).toBeUndefined();
  });

  it("rejects unknown authors", () => {
    expect(() =>
      recordCollaborationMessage({ author: "stranger", text: "hi" }, NOW)
    ).toThrowError(CollaborationValidationError);
  });

  it("rejects empty text", () => {
    expect(() =>
      recordCollaborationMessage({ author: "operator", text: "   " }, NOW)
    ).toThrowError(CollaborationValidationError);
  });

  it("truncates very long text to 4000 chars", () => {
    const long = "a".repeat(5_000);
    const message = recordCollaborationMessage({ author: "operator", text: long }, NOW);
    expect(message.text).toHaveLength(4_000);
  });

  it("falls back to chat/everyone when kind/addressedTo are unknown", () => {
    const message = recordCollaborationMessage(
      { author: "operator", text: "hi", kind: "rant", addressedTo: "everybody" },
      NOW
    );
    expect(message.kind).toBe("chat");
    expect(message.addressedTo).toBe("everyone");
  });

  it("lists messages newest-last and respects limit", () => {
    for (let i = 0; i < 5; i += 1) {
      recordCollaborationMessage(
        { author: "operator", text: `msg ${i}` },
        NOW + i
      );
    }
    const listed = listCollaborationMessages({ limit: 3 }, NOW + 1_000);
    expect(listed.map((m) => m.text)).toEqual(["msg 2", "msg 3", "msg 4"]);
  });

  it("respects sinceMs for incremental tailing", () => {
    recordCollaborationMessage({ author: "operator", text: "old" }, NOW);
    recordCollaborationMessage({ author: "codex", text: "newer" }, NOW + 5_000);
    const listed = listCollaborationMessages({ sinceMs: NOW + 1_000 }, NOW + 10_000);
    expect(listed.map((m) => m.text)).toEqual(["newer"]);
  });

  it("hides entries older than the 24h soft TTL", () => {
    recordCollaborationMessage({ author: "operator", text: "ancient" }, NOW);
    const later = NOW + 25 * 60 * 60 * 1000;
    recordCollaborationMessage({ author: "operator", text: "fresh" }, later);
    const listed = listCollaborationMessages({}, later);
    expect(listed.map((m) => m.text)).toEqual(["fresh"]);
  });

  it("caps the ring buffer at 500 entries (oldest dropped)", () => {
    for (let i = 0; i < 600; i += 1) {
      recordCollaborationMessage(
        { author: "operator", text: `m${i}` },
        NOW + i
      );
    }
    const listed = listCollaborationMessages({ limit: 500 }, NOW + 700);
    expect(listed).toHaveLength(500);
    // The first 100 should have been evicted.
    expect(listed[0].text).toBe("m100");
    expect(listed[499].text).toBe("m599");
  });
});
